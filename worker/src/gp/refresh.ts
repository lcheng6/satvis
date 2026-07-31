// Store-agnostic refresh: fetch every source, evaluate every group, and
// persist successful groups while preserving last-known-good on failure.
// The worker cron/API run it against KV (refreshAll); the static snapshot
// generator runs the same pipeline against disk (scripts/update-static-gp.mjs).

import generatedConfig from "../config/satvis.generated.json" with { type: "json" };
import {
  buildLaunchDates,
  buildStatuses,
  collectSources,
  indexSatellitesByNoradId,
  enrichRecords,
  evaluateGroups,
  fetchSources,
  type FetchImpl,
  type SourceProbe,
  toProbe,
  toRecordsBySource,
} from "./evaluate.ts";
import { kvGroupStore, type GroupStore } from "./store.ts";
import type { GroupsConfig, GroupsIndex } from "./types.ts";

const groupsConfig = generatedConfig as GroupsConfig;

// Result of one refresh run: the rebuilt index plus the per-source fetch
// diagnostics and write tallies, so a manual trigger (POST /api/refresh) can
// report exactly what happened. The cron ignores the return value.
export interface RefreshReport {
  index: GroupsIndex;
  sources: SourceProbe[];
  written: number;
  skipped: number;
  durationMs: number;
}

// Fetch upstream, evaluate, enrich, and write results to the store. Failed
// groups are skipped so their last-known-good value stays in the store; the
// rebuilt index (see buildStatuses) keeps their old `updated` and gains
// lastError/lastErrorAt.
export async function refreshGroups(config: GroupsConfig, store: GroupStore, fetchImpl: FetchImpl): Promise<RefreshReport> {
  const defs = config.groups;
  const startedMs = Date.now();
  const now = new Date().toISOString();
  console.log(`gp refresh: start — ${defs.length} groups, ${collectSources(defs).length} sources`);

  const fetched = await fetchSources(defs, fetchImpl);
  const bySource = toRecordsBySource(fetched);
  const evaluated = evaluateGroups(defs, bySource);
  // Read from the same fetch results as the element sets — satcat sources ride
  // the one rate-limited pass rather than opening a second one.
  const launchDates = buildLaunchDates(defs, bySource);
  const previous = await store.readIndex();
  const statuses = buildStatuses(defs, evaluated, previous, now);

  // Enrichment runs here rather than inside evaluateGroups so it sits on the far
  // side of `include` and `extraRecords` — every record actually served gets
  // exactly one pass, including pseudo TLE extras.
  const table = indexSatellitesByNoradId(config.satellites ?? []);
  const matchedSatnums = new Set<string>();

  // Persist successful groups in parallel (independent keys). Failed groups
  // get no write, so their last-known-good value stays intact.
  let written = 0;
  let skipped = 0;
  await Promise.all(
    defs.map((def) => {
      const result = evaluated.get(def.name);
      if (result === undefined || result instanceof Error) {
        skipped++;
        return undefined;
      }
      for (const warning of result.warnings) {
        console.warn(`gp refresh: ${def.name}: ${warning}`);
      }
      const enriched = enrichRecords(result.records, table, launchDates);
      for (const satnum of enriched.matched) {
        matchedSatnums.add(satnum);
      }
      written++;
      return store.writeGroup(def.name, enriched.records, { updated: now, count: enriched.records.length });
    }),
  );

  // A table entry matching nothing in any group is a config-health signal (typo,
  // or a satellite quietly gone), not per-group status — so it is logged rather
  // than written into the index. Decayed entries are expected never to match.
  //
  // Only meaningful when every group evaluated: a failed group contributes no
  // records, so its satellites would look unmatched when the truth is only that we
  // could not reach the upstream. Reporting that as a config problem would cry wolf
  // on every transient CelesTrak failure, so the check is skipped instead.
  if (skipped > 0) {
    console.log(`gp refresh: skipping the satellite-table check — ${skipped} group(s) failed, so unmatched entries cannot be distinguished from unreachable ones`);
  } else {
    const unmatched = (config.satellites ?? []).filter((entry) => !entry.decayed && !matchedSatnums.has(String(entry.noradId)));
    for (const entry of unmatched) {
      console.warn(`gp refresh: satellite table entry ${entry.noradId}${entry.name ? ` (${entry.name})` : ""} matched no record in any group`);
    }
  }

  const index: GroupsIndex = { updated: now, groups: statuses };
  await store.writeIndex(index);
  const durationMs = Date.now() - startedMs;
  console.log(`gp refresh: done in ${durationMs}ms — ${written} groups written, ${skipped} skipped/failed`);
  return { index, sources: fetched.map(toProbe), written, skipped, durationMs };
}

// Worker entrypoint: bundled config, KV store, global fetch.
export async function refreshAll(env: Env): Promise<RefreshReport> {
  return refreshGroups(groupsConfig, kvGroupStore(env.GP_KV), (url, init) => fetch(url, init));
}
