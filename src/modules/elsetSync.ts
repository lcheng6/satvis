// Keeps the element sets in force appropriate to the simulation time.
//
// Databricks is the PRIMARY source of orbital state. Each enabled satellite is
// propagated from the element set whose SCD2 validity interval contains the
// simulation time, fetched a window at a time; CelesTrak's element set is the
// fallback for whatever the warehouse cannot answer. This applies at live time
// too, not only while the clock is pinned — the warehouse's open row is the
// current element set, and preferring it is what "primary" means.
//
// The one asymmetry, deliberate: WHAT AN UNRESOLVED SATELLITE MEANS depends on
// whether the clock is pinned.
//
//   pinned — hidden. Per tasking 4: no element set valid at that instant means
//            the satellite is not drawn, whether it had not launched yet or the
//            instant fell in one of the chain's gaps.
//   live   — left on its CelesTrak element set. At the present moment a missing
//            row is a warehouse artifact (a dangling SCD2 close — 5,377 of the
//            catalog's open rows are affected), never evidence the satellite
//            left orbit. Deleting a demonstrably-orbiting satellite from the
//            live view on that basis would be wrong.
//
// One-way, like the rest of sceneSync: the clock decides, the element sets
// follow. Nothing here writes back to the store.

import { launchedAfter } from "../config/satelliteMetadata";
import type { CesiumController } from "./CesiumController";
import { fetchElsetWindow, hidesSatellite, MAX_WINDOW_SATNOS, resolveElset, windowCovers, type ElsetWindow } from "./util/elsetWindow";
import type { GpRecord } from "./util/gp";

export interface ElsetSync {
  /** Bring the element sets in line with the current clock and activation. */
  sync(): void;
}

export function createElsetSync(cc: CesiumController, pinnedTime: () => string | null): ElsetSync {
  let window: ElsetWindow | undefined;
  let inFlight: AbortController | undefined;
  // Guards against an out-of-order answer: a slow fetch that lands after a
  // newer one must not overwrite it. Compared rather than cancelled-on-abort
  // because an aborted fetch can still resolve first.
  let generation = 0;
  // What was last applied, so a no-op sync does not walk the catalog again.
  let appliedSignature = "";

  // Satellites whose recorded launch date is after the simulation time.
  //
  // Independent of the element-set window, and applied even when Databricks is
  // unconfigured or over the cap: it is the only thing that can speak for a
  // satellite the elset table has no rows for at all (53807 and the three
  // 2026-139 satellites), which would otherwise be drawn at every time.
  // Where the table DOES have history its own LAUNCH already answers this, and
  // the two agree; hiding on either is the same answer.
  function launchHiddenSatnums(satnums: readonly string[], timeMs: number): Set<string> {
    const hidden = new Set<string>();
    for (const satnum of satnums) {
      // One satnum can carry several catalog entries (same id, different name);
      // one of them knowing a later launch is enough.
      if (cc.sats.catalog.entriesWithSatnum(satnum).some((entry) => launchedAfter(entry.metadata, timeMs))) {
        hidden.add(satnum);
      }
    }
    return hidden;
  }

  function apply(resolved: ElsetWindow | undefined, timeMs: number | undefined, launchHidden: ReadonlySet<string> = new Set(), live = false): void {
    const overrides = new Map<string, GpRecord>();
    const hidden = new Set<string>(launchHidden);
    // Split only so the gap case can be reported: both are hidden.
    let gapCount = 0;
    let fallbackCount = 0;

    if (resolved !== undefined && timeMs !== undefined) {
      for (const satnum of resolved.requested) {
        const resolution = resolveElset(resolved, satnum, timeMs);
        if (resolution.kind === "elset") {
          // The name is the catalog's, not the table's: an entry is identified
          // by satnum + name, so renaming it here would strand the override on
          // a key nothing looks up. Only the two lines are being replaced.
          overrides.set(satnum, { kind: "tle", name: satnum, line1: resolution.line1, line2: resolution.line2 });
        } else if (hidesSatellite(resolution)) {
          // Live: keep the satellite on CelesTrak rather than hiding it. See
          // the asymmetry note at the top of this file.
          if (live) {
            fallbackCount++;
          } else {
            hidden.add(satnum);
            if (resolution.kind === "no-valid-entry") {
              gapCount++;
            }
          }
        }
      }
    }

    // Cheap identity for "the same thing is already in force".
    const signature = `${[...overrides]
      .map(([satnum, record]) => `${satnum}:${record.kind === "tle" ? record.line1 : ""}`)
      .toSorted()
      .join("|")}#${[...hidden].toSorted().join(",")}`;
    if (signature === appliedSignature) {
      return;
    }
    appliedSignature = signature;
    if (gapCount > 0) {
      // Not an error, but not obvious from the globe either: these satellites
      // are in orbit and covered by the table, and vanished only because no
      // row's validity interval contains this instant.
      console.info(`Time-appropriate element sets: ${gapCount} satellite(s) hidden — no validity interval covers this time (SCD2 chain gap).`);
    }
    if (fallbackCount > 0) {
      console.info(`Time-appropriate element sets: ${fallbackCount} satellite(s) kept on their CelesTrak element set — Databricks has no open row for them now.`);
    }
    cc.sats.applyElsetOverrides(overrides, hidden);
  }

  function sync(): void {
    const pinned = pinnedTime();
    // Live is a simulation time like any other — the present one. It resolves
    // against Databricks the same way a pinned time does; only the meaning of
    // an unresolved satellite differs (see the header).
    const live = pinned === null;
    const timeMs = live ? Date.now() : Date.parse(pinned);
    if (!Number.isFinite(timeMs)) {
      return;
    }

    const satnums = cc.sats.enabledSatnums();
    if (satnums.length === 0) {
      apply(undefined, undefined);
      return;
    }
    // Computed for every path below, including the ones that never reach
    // Databricks: a launch date is knowable without an element set, and it is
    // the only thing that can hide a satellite the elset table does not cover.
    const launchHidden = launchHiddenSatnums(satnums, timeMs);

    // Past the worker's cap the request would be rejected outright. Leaving
    // every satellite on its CelesTrak element set is the honest outcome —
    // resolving an arbitrary 200 of them would silently mix two epochs of data
    // in one view.
    if (satnums.length > MAX_WINDOW_SATNOS) {
      if (appliedSignature !== "") {
        console.warn(`Time-appropriate element sets skipped: ${satnums.length} satellites enabled, limit is ${MAX_WINDOW_SATNOS}.`);
      }
      apply(undefined, undefined, launchHidden, live);
      return;
    }

    // The bucketed window usually still covers a scrub, so most clock changes
    // resolve locally and never reach the network.
    if (windowCovers(window, timeMs, satnums)) {
      apply(window, timeMs, launchHidden, live);
      return;
    }

    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;
    const mine = ++generation;
    void fetchElsetWindow(satnums, timeMs, controller.signal)
      .then((fetched) => {
        if (mine !== generation) {
          return;
        }
        window = fetched;
        apply(fetched, timeMs, launchHidden, live);
      })
      .catch((error: unknown) => {
        if (mine !== generation || controller.signal.aborted) {
          return;
        }
        // A window that cannot be fetched leaves the satellites on their
        // CelesTrak element sets; the globe stays usable and says so once.
        console.warn("Could not fetch time-appropriate element sets", error);
      });
  }

  return { sync };
}
