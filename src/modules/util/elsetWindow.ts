// The Databricks element-set window: every element set that can be the right
// one for some instant near the simulation time, fetched in one request so
// scrubbing inside the window costs nothing.
//
// Selection rule — the SCD2 validity match, mirroring the worker exactly (see
// worker/src/databricks/elset.ts):
//
//     __START_AT <= t AND (__END_AT IS NULL OR t < __END_AT)
//
// The interval is half-open, so an instant exactly on an epoch belongs to the
// row starting there and to exactly one row. A satellite with no matching row
// is not displayed at that time.
//
// The chain is not continuous — measured on this table, 28% of rows are
// followed by a gap — so "no matching row" is a routine outcome for a covered,
// long-launched satellite, not only for one that has yet to launch. The two are
// kept as separate resolutions so that stays visible rather than being folded
// into a single "hidden".
//
// This module must stay Cesium-free so node-env vitest can exercise it.

// Half-width of a fetched window. Seven days total is enough that ordinary
// scrubbing stays inside one window, while keeping the payload small: these
// satellites get a new element set every few hours, so a week is ~25 rows each.
const WINDOW_HALF_SPAN_MS = 3.5 * 24 * 3_600_000;
// Window bounds are snapped to this, so nearby simulation times ask for the
// *same* window. Without it every scrub would mint a new pair of bounds, miss
// the worker's edge cache, and spend a fresh warehouse query.
const BUCKET_MS = 6 * 3_600_000;
// Matches the worker's own cap. Past it the request would be rejected outright,
// so the caller is told to leave every satellite on its CelesTrak element set
// rather than have some resolved and some not.
export const MAX_WINDOW_SATNOS = 200;

const ENDPOINT = "/api/elset/window";

export interface WindowElset {
  // __START_AT, which is also the TLE epoch. Start of the validity interval.
  epochMs: number;
  // __END_AT, exclusive. Null while this is the open row.
  endMs: number | null;
  line1: string;
  line2: string;
  name: string | null;
}

export interface WindowSatellite {
  // Earliest epoch the table holds for this satellite, ever. NOT a launch date
  // — it is where this table's history happens to begin.
  firstEpochMs: number;
  // satcat LAUNCH — the authoritative moment the satellite reached orbit. Null
  // when the table carries none.
  launchMs: number | null;
  // Ascending by epoch.
  elsets: WindowElset[];
}

export interface ElsetWindow {
  fromMs: number;
  toMs: number;
  // False when the deployment has no Databricks configured; the window is then
  // empty and every satellite resolves to "unknown".
  configured: boolean;
  bySatnum: Map<string, WindowSatellite>;
  // Requested satellites the table holds nothing for at all.
  uncovered: Set<string>;
  // What this window was fetched for. A satnum outside it was never asked
  // about, which is not the same as being uncovered.
  requested: Set<string>;
}

export type ElsetResolution =
  // Use these lines instead of the satellite's CelesTrak element set.
  | { kind: "elset"; line1: string; line2: string }
  // The simulation time precedes the satcat launch date: the satellite was not
  // in orbit yet. The authoritative form of "too early".
  | { kind: "before-launch" }
  // In orbit, but the simulation time precedes this table's first element set
  // for it — the history simply does not reach back that far.
  | { kind: "before-first" }
  // Covered and launched, but no row's validity interval contains the instant —
  // it fell in one of the chain's gaps, or past the end of a closed final row.
  // Not displayed either, per the selection rule.
  | { kind: "no-valid-entry" }
  // Nothing to say — not covered by the table, or not part of this window.
  // The satellite keeps whatever element set it already had.
  | { kind: "unknown" };

// The resolutions that mean "do not draw this satellite at this time".
export function hidesSatellite(resolution: ElsetResolution): boolean {
  return resolution.kind === "before-launch" || resolution.kind === "before-first" || resolution.kind === "no-valid-entry";
}

// The bucketed bounds for a simulation time. Exported for the tests and for
// callers deciding whether a refetch is due.
export function windowBoundsFor(timeMs: number): { fromMs: number; toMs: number } {
  const centre = Math.floor(timeMs / BUCKET_MS) * BUCKET_MS;
  return { fromMs: centre - WINDOW_HALF_SPAN_MS, toMs: centre + WINDOW_HALF_SPAN_MS };
}

// Whether an existing window can answer for this time and this satellite set.
// Both halves matter: enabling a new group adds satnums the window never asked
// about, and they would silently resolve to "unknown" without a refetch.
export function windowCovers(window: ElsetWindow | undefined, timeMs: number, satnums: readonly string[]): boolean {
  if (window === undefined) {
    return false;
  }
  const { fromMs, toMs } = windowBoundsFor(timeMs);
  if (fromMs !== window.fromMs || toMs !== window.toMs) {
    return false;
  }
  return satnums.every((satnum) => window.requested.has(satnum));
}

interface WindowResponse {
  configured?: boolean;
  entries?: {
    satNo: number;
    firstEpoch: string;
    launchDate: string | null;
    elsets: { epoch: string; supersededAt: string | null; line1: string; line2: string; objectName: string | null }[];
  }[];
  uncovered?: number[];
}

// Fetch the window covering `timeMs` for these satellites. Rejects only on a
// transport/HTTP failure; a deployment without Databricks answers 200 with
// `configured: false`, which is a valid empty window rather than an error.
export async function fetchElsetWindow(satnums: readonly string[], timeMs: number, signal?: AbortSignal): Promise<ElsetWindow> {
  const requested = new Set(satnums);
  const { fromMs, toMs } = windowBoundsFor(timeMs);
  const empty: ElsetWindow = { fromMs, toMs, configured: false, bySatnum: new Map(), uncovered: new Set(), requested };
  // Only numeric satnums can be asked for: alpha-5 designators ("E8493") have
  // no counterpart in a table keyed by a bigint satNo.
  const numeric = [...requested].filter((satnum) => /^\d+$/.test(satnum));
  if (numeric.length === 0 || numeric.length > MAX_WINDOW_SATNOS) {
    return empty;
  }

  const url = `${ENDPOINT}?satnos=${numeric.join(",")}&from=${new Date(fromMs).toISOString()}&to=${new Date(toMs).toISOString()}`;
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`elset window: HTTP ${response.status}`);
  }
  const payload = (await response.json()) as WindowResponse;
  if (payload.configured === false) {
    return empty;
  }

  const bySatnum = new Map<string, WindowSatellite>();
  for (const entry of payload.entries ?? []) {
    const firstEpochMs = Date.parse(entry.firstEpoch);
    if (!Number.isFinite(firstEpochMs)) {
      continue;
    }
    const elsets = (entry.elsets ?? [])
      .map((elset) => ({
        epochMs: Date.parse(elset.epoch),
        // An unparseable __END_AT is treated as "still open" rather than as an
        // interval ending at NaN, which would compare false against everything
        // and silently hide the satellite.
        endMs: elset.supersededAt === null || elset.supersededAt === undefined ? null : Number.isFinite(Date.parse(elset.supersededAt)) ? Date.parse(elset.supersededAt) : null,
        line1: elset.line1,
        line2: elset.line2,
        name: elset.objectName,
      }))
      .filter((elset) => Number.isFinite(elset.epochMs))
      // The worker orders by epoch already; sorting here keeps resolveElset's
      // precondition true no matter what a future query shape does.
      .toSorted((a, b) => a.epochMs - b.epochMs);
    const launchMs = entry.launchDate === null || entry.launchDate === undefined ? Number.NaN : Date.parse(entry.launchDate);
    bySatnum.set(String(entry.satNo), { firstEpochMs, launchMs: Number.isFinite(launchMs) ? launchMs : null, elsets });
  }

  return {
    fromMs,
    toMs,
    configured: true,
    bySatnum,
    uncovered: new Set((payload.uncovered ?? []).map((satNo) => String(satNo))),
    requested,
  };
}

// The element set to use for one satellite at one instant, by the SCD2 validity
// match: `__START_AT <= t AND (__END_AT IS NULL OR t < __END_AT)`.
//
// "before-first" is reported only when the table *knows* this satellite and its
// history starts later — that is a launch date. A satellite the table has never
// heard of is "unknown", so it keeps its CelesTrak element set and stays
// visible. Between those, "no-valid-entry" is a covered, launched satellite
// whose intervals simply do not cover this instant.
export function resolveElset(window: ElsetWindow, satnum: string, timeMs: number): ElsetResolution {
  const entry = window.bySatnum.get(satnum);
  if (entry === undefined) {
    return { kind: "unknown" };
  }
  // Checked before firstEpochMs: the launch date is the real fact, and this
  // table's history can begin long after it.
  if (entry.launchMs !== null && timeMs < entry.launchMs) {
    return { kind: "before-launch" };
  }
  if (timeMs < entry.firstEpochMs) {
    return { kind: "before-first" };
  }
  // Ascending by start, and the intervals do not overlap in this table, so the
  // first containing interval is the only one. A linear scan is right for the
  // handful of rows a week holds.
  const chosen: WindowElset | undefined = entry.elsets.find((elset) => elset.epochMs <= timeMs && (elset.endMs === null || timeMs < elset.endMs));
  if (chosen === undefined) {
    return { kind: "no-valid-entry" };
  }
  return { kind: "elset", line1: chosen.line1, line2: chosen.line2 };
}
