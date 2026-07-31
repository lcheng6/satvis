// SatelliteCatalog — the frontend's plain, non-reactive registry of known
// satellites, decoupled from instantiated Cesium objects. It owns O(n) dedup
// and tag merging (previously O(n²) Array.find in SatelliteManager.#add).
//
// This module must stay Cesium-free (node-env vitest exercises it).

import type { SatelliteMetadata } from "../config/satelliteMetadata";
import { parseGpPayload, recordName, recordSatnum, type GpRecord } from "./util/gp";
import { fetchGpGroup, fetchGpIndex } from "./util/gpSource";

// A single known satellite. Created by SatelliteCatalog.addRecords, which owns
// the identity/tag indices.
export class CatalogEntry {
  // Dedup identity, matching today's SatelliteManager.#add: satnum + "|" + name.
  readonly key: string;

  readonly name: string;

  readonly nameUpper: string;

  readonly satnum: string;

  // Mutable: addRecords reassigns it when merging tags across groups.
  tags: string[];

  // The element set as served by the group. Never replaced — a time-appropriate
  // override is held beside it, so returning to live time is just dropping the
  // override rather than refetching the group.
  readonly baseRecord: GpRecord;

  // A time-appropriate element set from Databricks, when one is in force.
  // See src/modules/util/elsetWindow.ts.
  #override: GpRecord | undefined;

  constructor(fields: { key: string; name: string; nameUpper: string; satnum: string; tags: string[]; record: GpRecord }) {
    this.key = fields.key;
    this.name = fields.name;
    this.nameUpper = fields.nameUpper;
    this.satnum = fields.satnum;
    this.tags = fields.tags;
    this.baseRecord = fields.record;
  }

  // The element set in force. Everything downstream (Orbit, the info panel)
  // reads this, so an override reaches all of them without any of them needing
  // to know that overrides exist.
  get record(): GpRecord {
    return this.#override ?? this.baseRecord;
  }

  get hasRecordOverride(): boolean {
    return this.#override !== undefined;
  }

  /**
   * Put an element set in force, or drop back to the group's own with
   * `undefined`. Returns true when the effective record actually changed, so a
   * caller only rebuilds the satellites that really need it.
   */
  setRecordOverride(record: GpRecord | undefined): boolean {
    if (record === undefined) {
      const had = this.#override !== undefined;
      this.#override = undefined;
      return had;
    }
    const current = this.#override;
    // Compared by the element set itself, not by identity: the same two lines
    // arriving again — a refetched window, or a scrub landing on the same epoch
    // — must not count as a change, or every fetch would rebuild everything.
    if (current?.kind === "tle" && record.kind === "tle" && current.line1 === record.line1 && current.line2 === record.line2) {
      return false;
    }
    this.#override = record;
    return true;
  }

  // Static per-satellite facts (swath extents, cone FOV, model URL, operator),
  // attached to the record by the worker at refresh time. Empty for a satellite
  // absent from the satellite table — consumers apply their own defaults.
  //
  // Falls back to the base record because an override is a bare element set:
  // Databricks knows a satellite's TLE, not its swath, and swapping one in must
  // not cost the satellite its metadata.
  get metadata(): SatelliteMetadata {
    return this.record.metadata ?? this.baseRecord.metadata ?? {};
  }
}

// A preset group source known to the catalog but fetched lazily: registered
// up front (so the UI can list it), loaded only once one of its tags becomes
// active, it is expanded/searched in the browser, or an unresolved satellite
// name forces a full load.
interface RegisteredGroup {
  source: string;
  tags: string[];
  loaded: boolean;
  // Memoized in-flight/completed load; cleared on failure so a later ensure
  // call retries.
  load: Promise<void> | undefined;
}

export type CatalogChangeCallback = (entries: CatalogEntry[]) => void;

export class SatelliteCatalog {
  #byKey = new Map<string, CatalogEntry>();

  #byName = new Map<string, CatalogEntry>();

  #bySatnum = new Map<string, CatalogEntry[]>();

  #byTag = new Map<string, Set<CatalogEntry>>();

  #changeCallbacks: CatalogChangeCallback[] = [];

  onChange(cb: CatalogChangeCallback): void {
    this.#changeCallbacks.push(cb);
  }

  #notifyChange(entries: CatalogEntry[]): void {
    if (entries.length === 0) {
      return;
    }
    this.#changeCallbacks.forEach((cb) => cb(entries));
  }

  // Lazily-loaded preset groups by source name, plus per-source record counts
  // from the group index (display estimates for not-yet-loaded groups).
  #registry = new Map<string, RegisteredGroup>();

  #indexCounts = new Map<string, number>();

  #indexLoad: Promise<void> | undefined;

  // Register preset groups without fetching them. Repeated registration (e.g.
  // navigating between presets) merges tags; already-loaded groups stay loaded.
  registerGroups(sourceTagList: ReadonlyArray<readonly [string, string[]]>): void {
    for (const [source, tags] of sourceTagList) {
      const existing = this.#registry.get(source);
      if (existing) {
        existing.tags = mergeTags(existing.tags, tags);
        continue;
      }
      this.#registry.set(source, { source, tags: [...tags], loaded: false, load: undefined });
    }
  }

  // Fetch the group index (names + record counts) so unloaded groups can show
  // an estimated count in the UI. Best-effort: an unavailable index just leaves
  // the estimates at 0.
  ensureIndex(): Promise<void> {
    this.#indexLoad ??= fetchGpIndex().then((index) => {
      for (const group of index) {
        if (typeof group.count === "number") {
          this.#indexCounts.set(group.name, group.count);
        }
      }
    });
    return this.#indexLoad;
  }

  // Load every registered group carrying one of the given tags. Loads are
  // memoized per group; per-group errors are logged and skipped.
  ensureTags(tags: readonly string[]): Promise<void> {
    const wanted = new Set(tags);
    const loads = [...this.#registry.values()].filter((group) => group.tags.some((tag) => wanted.has(tag))).map((group) => this.#ensureGroup(group));
    return Promise.all(loads).then(() => undefined);
  }

  // Load every registered group (needed for cross-group search and for
  // satellite names whose group is unknown, e.g. URL-enabled sats).
  ensureAll(): Promise<void> {
    const loads = [...this.#registry.values()].map((group) => this.#ensureGroup(group));
    return Promise.all(loads).then(() => undefined);
  }

  // True once every registered group carrying the tag has loaded (trivially
  // true for tags without a registered source, e.g. custom records).
  isTagLoaded(tag: string): boolean {
    for (const group of this.#registry.values()) {
      if (!group.loaded && group.tags.includes(tag)) {
        return false;
      }
    }
    return true;
  }

  #ensureGroup(group: RegisteredGroup): Promise<void> {
    group.load ??= this.#loadRegisteredGroup(group);
    return group.load;
  }

  async #loadRegisteredGroup(group: RegisteredGroup): Promise<void> {
    try {
      const text = await fetchGpGroup(group.source);
      const records = parseGpPayload(text);
      const changed = this.addRecords(records, group.tags);
      group.loaded = true;
      this.#notifyChange(changed);
    } catch (error) {
      console.log(error);
      // Clear the memoized load so a later ensure call retries.
      group.load = undefined;
    }
  }

  // Add records with the given tags, deduping by key and merging tags. Returns
  // the entries that were added or whose tags changed (for the change callback).
  addRecords(records: GpRecord[], tags: string[]): CatalogEntry[] {
    const changed: CatalogEntry[] = [];
    for (const record of records) {
      const name = recordName(record);
      const satnum = recordSatnum(record);
      const key = `${satnum}|${name}`;
      const existing = this.#byKey.get(key);
      if (existing) {
        const before = existing.tags.length;
        existing.tags = mergeTags(existing.tags, tags);
        if (existing.tags.length !== before) {
          this.#indexTags(existing);
          changed.push(existing);
        }
        continue;
      }
      const entry = new CatalogEntry({
        key,
        name,
        nameUpper: name.toUpperCase(),
        satnum,
        tags: [...tags],
        record,
      });
      this.#byKey.set(key, entry);
      // First-wins by name (matches today's getSatellite lookup).
      if (!this.#byName.has(name)) {
        this.#byName.set(name, entry);
      }
      const satnumEntries = this.#bySatnum.get(satnum) ?? [];
      satnumEntries.push(entry);
      this.#bySatnum.set(satnum, satnumEntries);
      this.#indexTags(entry);
      changed.push(entry);
    }
    return changed;
  }

  #indexTags(entry: CatalogEntry): void {
    for (const tag of entry.tags) {
      const tagEntries = this.#byTag.get(tag) ?? new Set();
      tagEntries.add(entry);
      this.#byTag.set(tag, tagEntries);
    }
  }

  // All known groups: tags with loaded entries (exact counts) plus registered
  // but not-yet-loaded sources (estimated counts from the group index, 0 until
  // the index arrives). Estimates may double-count satellites shared with a
  // loaded group; they are replaced by exact counts once the group loads.
  get groups(): { tag: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const [tag, entries] of this.#byTag) {
      counts.set(tag, entries.size);
    }
    for (const group of this.#registry.values()) {
      if (group.loaded) {
        continue;
      }
      const estimate = this.#indexCounts.get(group.source) ?? 0;
      for (const tag of group.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + estimate);
      }
    }
    return [...counts.entries()].map(([tag, count]) => ({ tag, count }));
  }

  entriesWithTag(tag: string): CatalogEntry[] {
    return [...(this.#byTag.get(tag) ?? [])];
  }

  entriesWithSatnum(satnum: string): CatalogEntry[] {
    return [...(this.#bySatnum.get(satnum) ?? [])];
  }

  /**
   * Put a time-appropriate element set in force per satnum, and drop the
   * override from every entry not named — so this is the whole override state,
   * not an addition to it, and going back to live time is `applyRecordOverrides
   * (new Map())`.
   *
   * Returns the keys whose effective record changed: exactly the satellites
   * whose live Cesium objects have to be rebuilt.
   */
  applyRecordOverrides(bySatnum: ReadonlyMap<string, GpRecord>): string[] {
    const changed: string[] = [];
    for (const [satnum, entries] of this.#bySatnum) {
      const record = bySatnum.get(satnum);
      for (const entry of entries) {
        // Cheap exit for the overwhelming majority: no override wanted, none
        // held. Without it every scrub would walk all ~10k entries doing work.
        if (record === undefined && !entry.hasRecordOverride) {
          continue;
        }
        if (entry.setRecordOverride(record)) {
          changed.push(entry.key);
        }
      }
    }
    return changed;
  }

  getByName(name: string): CatalogEntry | undefined {
    return this.#byName.get(name);
  }

  get size(): number {
    return this.#byKey.size;
  }

  get entries(): CatalogEntry[] {
    return [...this.#byKey.values()];
  }
}

// Union merge preserving order.
function mergeTags(existing: string[], added: string[]): string[] {
  const result = [...existing];
  for (const tag of added) {
    if (!result.includes(tag)) {
      result.push(tag);
    }
  }
  return result;
}
