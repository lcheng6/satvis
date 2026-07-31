import { Cartesian3 } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";

import { SATELLITE_COMPONENTS } from "../config/components";
import type { SerializedGroundStation } from "../stores/sat";
import { GroundStationEntity, type GroundStationPositionData } from "./GroundStationEntity";
import { activeTargetEntries } from "./satelliteActivation";
import { type CatalogEntry, SatelliteCatalog } from "./SatelliteCatalog";
import { SatelliteComponentCollection } from "./SatelliteComponentCollection";
import { CesiumCleanupHelper } from "./util/CesiumCleanupHelper";
import { sameValue } from "./util/equality";
import type { GpRecord } from "./util/gp";

/**
 * Everything the globe should be showing. The manager holds no opinion of its
 * own about any of it — the store decides, this is the value it hands over.
 */
export interface DesiredScene {
  enabledTags: string[];
  enabledSatellites: string[];
  disabledSatellites: string[];
  components: string[];
  groundStations: SerializedGroundStation[];
  overpassMode: string;
  trackedSatellite: string;
}

const EMPTY_SCENE: DesiredScene = {
  enabledTags: [],
  enabledSatellites: [],
  disabledSatellites: [],
  components: [],
  groundStations: [],
  overpassMode: "elevation",
  trackedSatellite: "",
};

export class SatelliteManager {
  // The last scene handed to reconcile. Nothing else mirrors store state.
  #desired: DesiredScene = EMPTY_SCENE;

  // Components hidden for the duration of a scene morph, which is a Cesium
  // concern and must not be mistaken for the user turning them off.
  #suppressed = new Set<string>();

  #stations: GroundStationEntity[] = [];

  #onTrackedChange: ((name: string) => void) | undefined;

  viewer: Viewer;

  readonly catalog = new SatelliteCatalog();

  // Live collections keyed by catalog entry key. Satellites are instantiated
  // lazily: only entries in the current activation target (see #reconcileActive)
  // have a collection here; everything else stays a plain catalog entry.
  #active = new Map<string, SatelliteComponentCollection>();

  availableComponents: string[] = [...SATELLITE_COMPONENTS];

  pendingTrackedSatellite: string | undefined;

  constructor(viewer: Viewer) {
    this.viewer = viewer;

    // Tracking is the one genuinely two-way value: the user can also start it
    // by clicking a satellite on the globe. Report it rather than reaching for
    // the store, so this class stays free of Pinia.
    this.viewer.trackedEntityChanged.addEventListener(() => {
      if (this.trackedSatellite) {
        this.getSatellite(this.trackedSatellite)?.show(this.#effectiveComponents());
      }
      this.#onTrackedChange?.(this.trackedSatellite);
    });

    // New/changed catalog entries may fall into the current activation target
    // (e.g. URL-enabled names or a pendingTrackedSatellite that arrives once the
    // catalog finishes loading), so bump the revision and reconcile.
    this.catalog.onChange(() => {
      this.#onCatalogChange?.();
      this.#reconcileActive();
    });
  }

  /** Called whenever the catalog gains or changes entries. */
  onCatalogChange(callback: () => void): void {
    this.#onCatalogChange = callback;
  }

  /** Called when the globe starts or stops tracking a satellite. */
  onTrackedChange(callback: (name: string) => void): void {
    this.#onTrackedChange = callback;
  }

  #onCatalogChange: (() => void) | undefined;

  #effectiveComponents(): string[] {
    return this.#desired.components.filter((name) => !this.#suppressed.has(name));
  }

  /**
   * Make the globe match `desired`. Diffed against the previous scene, so it
   * is cheap to call on every store change and there is no path by which the
   * manager can disagree with the store.
   */
  reconcile(desired: DesiredScene): void {
    const previous = this.#desired;
    this.#desired = desired;

    if (
      !sameValue(previous.enabledTags, desired.enabledTags) ||
      !sameValue(previous.enabledSatellites, desired.enabledSatellites) ||
      previous.trackedSatellite !== desired.trackedSatellite
    ) {
      void this.#ensureCatalogCoverage();
    }

    if (!sameValue(previous.groundStations, desired.groundStations)) {
      this.#applyGroundStations(desired.groundStations);
    }

    if (previous.overpassMode !== desired.overpassMode) {
      this.#applyOverpassMode(desired.overpassMode);
    }

    if (!sameValue(previous.components, desired.components)) {
      this.#applyComponents(previous.components);
    }

    if (previous.trackedSatellite !== desired.trackedSatellite) {
      this.#applyTracked(desired.trackedSatellite);
    }

    this.#reconcileActive();
  }

  #applyComponents(previousComponents: string[]): void {
    const next = new Set(this.#effectiveComponents());
    const current = new Set(previousComponents.filter((name) => !this.#suppressed.has(name)));
    for (const name of next) {
      if (!current.has(name)) {
        this.#showComponent(name);
      }
    }
    for (const name of current) {
      if (!next.has(name)) {
        this.#hideComponent(name);
      }
    }
  }

  #applyOverpassMode(mode: string): void {
    this.activeSatellites.forEach((sat) => {
      // The mode setter clears the predictor's window on change; recompute
      // eagerly so pass-dependent visuals update without waiting for a read.
      sat.props.passPredictor.mode = mode;
      if (sat.props.passPredictor.groundStationAvailable) {
        sat.props.passPredictor.passes(this.viewer.clock.currentTime);
      }
    });
  }

  #applyGroundStations(stations: readonly SerializedGroundStation[]): void {
    this.#stations.forEach((station) => station.hide());
    this.#stations = stations.map((station) =>
      this.createGroundstation(
        {
          latitude: station.lat,
          longitude: station.lon,
          height: 0,
          cartesian: Cartesian3.fromDegrees(station.lon, station.lat, 0),
        },
        station.name ?? "",
      ),
    );
    this.activeSatellites.forEach((sat) => {
      sat.groundStations = this.#stations;
    });
  }

  #applyTracked(name: string): void {
    if (!name) {
      if (this.trackedSatellite) {
        this.viewer.trackedEntity = undefined;
      }
      this.pendingTrackedSatellite = undefined;
      return;
    }
    if (name === this.trackedSatellite) {
      return;
    }
    // If the name is unknown to the catalog (yet?), reconciling is a no-op and
    // the pending name survives until a matching entry is loaded — coverage
    // kicks off the group loads that can make it resolvable.
    this.pendingTrackedSatellite = name;
  }

  // Register the preset's element sets with the catalog. Groups are NOT
  // fetched here — only the ones required by the current activation state
  // (enabled tags, URL-enabled/tracked names) load now; the rest load on
  // demand when their tag is enabled or the catalog browser needs them.
  loadElementSets(sourceTagList: ReadonlyArray<readonly [string, string[]]>): Promise<void> {
    this.catalog.registerGroups(sourceTagList);
    // Registered groups become visible in the browser immediately; their
    // estimated counts follow once the group index arrives.
    this.#onCatalogChange?.();
    void this.catalog.ensureIndex().then(() => this.#onCatalogChange?.());
    return this.#ensureCatalogCoverage();
  }

  // Load the catalog groups the current activation state depends on: groups
  // carrying an enabled tag, plus everything if a name-based activation
  // (URL-enabled sats, pending track) cannot be resolved yet — the group of an
  // unknown name is unknowable without loading.
  #ensureCatalogCoverage(): Promise<void> {
    const loads = [this.catalog.ensureTags(this.#desired.enabledTags)];
    const names = [...this.#desired.enabledSatellites];
    if (this.pendingTrackedSatellite) {
      names.push(this.pendingTrackedSatellite);
    }
    if (names.some((name) => this.catalog.getByName(name) === undefined)) {
      loads.push(this.catalog.ensureAll());
    }
    return Promise.all(loads).then(() => undefined);
  }

  // Passthrough for custom inline records (e.g. console/testing usage).
  addCustomRecords(records: GpRecord[], tags: string[]): void {
    this.catalog.addRecords(records, tags);
    this.#onCatalogChange?.();
    this.#reconcileActive();
  }

  // Catalog entries that should currently be instantiated: enabled by tag
  // (minus per-member opt-outs), enabled by name, or the tracked /
  // pending-tracked satellite.
  #activeTargetEntries(): Map<string, CatalogEntry> {
    return activeTargetEntries({
      entries: this.catalog.entries,
      enabledTags: this.#desired.enabledTags,
      enabledSatellites: this.#desired.enabledSatellites,
      disabledSatellites: this.#desired.disabledSatellites,
      trackedName: this.trackedSatellite || undefined,
      pendingTrackedName: this.pendingTrackedSatellite,
      hiddenSatnums: this.#hiddenSatnums,
    });
  }

  // Satnums with no element set valid at the simulation time. Owned here rather
  // than in DesiredScene because it is not something the store decides — it
  // falls out of the element-set data (see modules/elsetSync.ts).
  #hiddenSatnums: ReadonlySet<string> = new Set();

  /**
   * Satnums of every satellite the current activation asks for, ignoring the
   * hidden filter.
   *
   * Ignoring it is the point: this is what the element-set window is fetched
   * for, and that filter is derived FROM the window. Honouring it here would
   * mean a satellite hidden once could never be asked about again, and so could
   * never come back when the clock moved on.
   */
  enabledSatnums(): string[] {
    const entries = activeTargetEntries({
      entries: this.catalog.entries,
      enabledTags: this.#desired.enabledTags,
      enabledSatellites: this.#desired.enabledSatellites,
      disabledSatellites: this.#desired.disabledSatellites,
      trackedName: this.trackedSatellite || undefined,
      pendingTrackedName: this.pendingTrackedSatellite,
    });
    return [...new Set([...entries.values()].map((entry) => entry.satnum))];
  }

  /**
   * Apply the time-appropriate element sets for the current simulation time:
   * `overrides` is the whole override state (satnum -> element set), and
   * `hidden` the satnums with no element set valid at that time.
   *
   * Satellites whose element set really changed are rebuilt, because an Orbit —
   * and the pass predictor and sampled trajectory built on it — is constructed
   * from the record and cannot be re-pointed in place.
   */
  applyElsetOverrides(overrides: ReadonlyMap<string, GpRecord>, hidden: ReadonlySet<string>): void {
    const changedKeys = this.catalog.applyRecordOverrides(overrides);
    this.#hiddenSatnums = hidden;

    // Tracking survives the rebuild: the collection holding the tracked entity
    // is about to be disposed, and only its replacement can hold it again.
    const tracked = this.trackedSatellite;
    let rebuilt = false;
    for (const key of changedKeys) {
      const sat = this.#active.get(key);
      if (sat === undefined) {
        continue;
      }
      if (sat.isTracked) {
        this.viewer.trackedEntity = undefined;
      }
      sat.dispose();
      this.#active.delete(key);
      rebuilt = true;
    }
    if (rebuilt && tracked) {
      this.pendingTrackedSatellite = tracked;
    }

    // Always reconcile: even with no record change, `hidden` may have grown or
    // shrunk, which adds or removes live satellites on its own.
    this.#reconcileActive();
  }

  // Reconcile the live #active map against the activation target: dispose
  // collections that are no longer targeted, instantiate the ones that are
  // newly targeted, and resolve a pending track once its satellite exists.
  #reconcileActive(): void {
    const target = this.#activeTargetEntries();

    // Dispose collections no longer in the target.
    for (const [key, sat] of this.#active) {
      if (target.has(key)) {
        continue;
      }
      if (sat.isTracked) {
        // Clear the tracked entity before tearing down its components so Cesium
        // does not keep a dangling trackedEntity reference.
        this.viewer.trackedEntity = undefined;
      }
      sat.dispose();
      this.#active.delete(key);
    }

    // Instantiate collections newly in the target.
    for (const [key, entry] of target) {
      if (this.#active.has(key)) {
        continue;
      }
      const sat = new SatelliteComponentCollection(this.viewer, entry);
      if (this.groundStationAvailable) {
        sat.groundStations = this.#stations;
      }
      sat.props.passPredictor.mode = this.#desired.overpassMode;
      sat.show(this.#effectiveComponents());
      this.#active.set(key, sat);
    }

    // Resolve a pending track now that the satellite is guaranteed active
    // (whether it was just created above or was already live).
    if (this.pendingTrackedSatellite) {
      const sat = this.getSatellite(this.pendingTrackedSatellite);
      if (sat) {
        sat.track();
        this.pendingTrackedSatellite = undefined;
      }
    }

    if (this.visibleSatellites.length === 0) {
      CesiumCleanupHelper.cleanup(this.viewer);
    }
  }

  get selectedSatellite(): string {
    for (const sat of this.#active.values()) {
      if (sat.isSelected) {
        return sat.props.name;
      }
    }
    return "";
  }

  // Read-only: what the globe is tracking is derived from Cesium, and asking
  // for a different one goes through reconcile like every other desire.
  get trackedSatellite(): string {
    for (const sat of this.#active.values()) {
      if (sat.isTracked) {
        return sat.props.name;
      }
    }
    return "";
  }

  // Active collections that have created components (i.e. are visible).
  get visibleSatellites(): SatelliteComponentCollection[] {
    return [...this.#active.values()].filter((sat) => sat.created);
  }

  // Active-only lookup for selected/tracked/active names; console users
  // wanting arbitrary lookups should use `cc.sats.catalog.getByName`.
  getSatellite(name: string): SatelliteComponentCollection | undefined {
    for (const sat of this.#active.values()) {
      if (sat.props.name === name) {
        return sat;
      }
    }
    return undefined;
  }

  get activeSatellites(): SatelliteComponentCollection[] {
    return [...this.#active.values()];
  }

  get enabledComponents(): string[] {
    return this.#effectiveComponents();
  }

  /**
   * Hide a component for the duration of a scene morph. Suppression is kept
   * apart from the desired scene on purpose: the user did not switch this off,
   * so the toolbar must go on showing it enabled.
   */
  suppressComponent(componentName: string): boolean {
    if (this.#suppressed.has(componentName) || !this.#desired.components.includes(componentName)) {
      return false;
    }
    this.#suppressed.add(componentName);
    this.#hideComponent(componentName);
    return true;
  }

  releaseComponent(componentName: string): void {
    if (!this.#suppressed.delete(componentName)) {
      return;
    }
    if (this.#desired.components.includes(componentName)) {
      this.#showComponent(componentName);
    }
  }

  #showComponent(componentName: string): void {
    this.activeSatellites.forEach((sat) => {
      sat.enableComponent(componentName);
    });
  }

  #hideComponent(componentName: string): void {
    this.activeSatellites.forEach((sat) => {
      sat.disableComponent(componentName);
    });
  }

  get groundStationAvailable(): boolean {
    return this.#stations.length > 0;
  }

  focusGroundStation(): void {
    if (this.groundStationAvailable) {
      this.#stations[0]?.track();
    }
  }

  createGroundstation(position: GroundStationPositionData, name: string): GroundStationEntity {
    const groundStation = new GroundStationEntity(this.viewer, this, position, name);
    groundStation.show();
    return groundStation;
  }

  get groundStations(): GroundStationEntity[] {
    return this.#stations;
  }

  get overpassMode(): string {
    return this.#desired.overpassMode;
  }

  get pendingUpdate(): boolean {
    return SatelliteComponentCollection.primitivePendingUpdate;
  }
}
