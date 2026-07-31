// The one place store state becomes globe state.
//
// This used to be fourteen watchers inside Satvis.vue, which had to be an
// always-mounted component for them to survive the catalog panel closing, and
// which quietly made "EntityInfoPanel is a child of Satvis" load-bearing —
// useSelectedEntity depended on being registered after Satvis's overpassMode
// watcher. Started from app.ts instead, none of that matters.
//
// The direction is one-way. The store decides, Cesium follows. The only value
// that also travels the other way is tracking, because the user can start it by
// clicking a satellite on the globe, and that arrives as a callback.

import { JulianDate } from "@cesium/engine";
import { nextTick, watch } from "vue";

import { currentPosition } from "../composables/useGeolocation";
import { SKY_MODE } from "../config/viewModes";
import { useCesiumStore } from "../stores/cesium";
import { useSatStore } from "../stores/sat";
import type { CesiumController } from "./CesiumController";
import { offlineFallback } from "./CesiumLayerProviders";
import { createElsetSync } from "./elsetSync";
import type { DesiredScene } from "./SatelliteManager";
import type { Observer } from "./SkyView";
import { toMinuteIso } from "./util/urlCodec";

// Enough to keep a fast clock multiplier from hammering the history api.
const MIN_CLOCK_WRITE_MS = 1000;

export function startSceneSync(cc: CesiumController): void {
  const cesiumStore = useCesiumStore();
  const satStore = useSatStore();

  // --- globe settings -------------------------------------------------------

  // Immediate, because the store is the only owner of the layer stack: the viewer
  // is constructed with no base layer at all and the first stack arrives here.
  //
  // The imagery is applied synchronously, and the availability check is a
  // *correction* that follows. A missing tile set is then something the store is
  // told about — the swap re-enters this watcher and the checkbox, the url and the
  // pixels never disagree — while nothing has to wait on a probe to see a globe.
  watch(
    () => cesiumStore.layers,
    (layers) => {
      cc.imageryLayers = [...layers];
      void correctMissingImagery();
    },
    { deep: true, immediate: true },
  );

  async function correctMissingImagery(): Promise<void> {
    const swapped = await offlineFallback(cesiumStore.layers);
    // Reading the store again rather than trusting the stack this was called for:
    // the user may have picked something else while the probe was in flight, and
    // that answer is simply about a stack that no longer exists.
    if (swapped) {
      cesiumStore.setLayers(swapped);
    }
  }
  watch(
    () => cesiumStore.terrainProvider,
    (name) => {
      cc.terrainProvider = name;
    },
  );
  // The view mode is the one setting that cannot be a plain assignment. Three
  // of the four are a Cesium projection, but "Sky" needs an observer, which may
  // still be arriving from the url or may have to be asked for — so entering is
  // an action with a result, and a refusal has to put the mode back.
  let viewModeGeneration = 0;

  async function resolveObserver(): Promise<Observer | undefined> {
    // The cesium and sat stores hydrate from the url independently, so a ground
    // station in `?gs=` can land a tick after the view mode in `?scene=` does.
    // Waiting is the difference between using the observer the link supplied and
    // prompting for a location on top of it.
    await nextTick();
    const existing = satStore.groundStations[0];
    if (existing) {
      return { lat: existing.lat, lon: existing.lon };
    }

    const fix = await currentPosition();
    if (!fix) {
      return undefined;
    }
    // The device's location becomes a ground station rather than a private
    // second notion of "here": the sky view's next-pass figures are then the
    // passes the app was already computing. Read it back rather than reusing
    // `fix`, so the observer is the rounded value the store and url agree on.
    satStore.setGroundStations([...satStore.groundStations, { ...fix, name: "Geolocation" }]);
    const created = satStore.groundStations[0];
    return created ? { lat: created.lat, lon: created.lon } : undefined;
  }

  async function applyViewMode(mode: string, previous: string): Promise<void> {
    const generation = ++viewModeGeneration;

    if (mode !== SKY_MODE) {
      cc.skyInteraction.stop();
      cc.skyView.exit();
      cc.releaseCameraMode();
      cc.morphTo(mode);
      return;
    }

    const observer = await resolveObserver();
    // Leaving again while the browser was asking for a location, or a second
    // switch overtaking this one, makes this answer stale.
    if (generation !== viewModeGeneration) {
      return;
    }
    if (!observer) {
      console.warn("Sky view needs an observer: no ground station, and no location from the device");
      cesiumStore.sceneMode = previous === SKY_MODE ? "3D" : previous;
      return;
    }

    // Both of these fight the sky view for the camera, and they are handled
    // differently on purpose — see docs/adr/0003-sky-view.md. Inertial is
    // suppressed, so `?camera=Inertial` survives the round trip. Tracking is
    // cleared, because a camera cannot both follow a satellite and be a pair of
    // eyes on the ground, so there is nothing to come back to.
    cc.suppressCameraMode();
    satStore.trackedSatellite = "";
    cc.skyView.enter(observer);
    cc.skyInteraction.start();
  }

  watch(
    () => cesiumStore.sceneMode,
    (mode, previous) => {
      void applyViewMode(mode, previous);
    },
  );

  // Nothing is tracked while the sky view is up, held as a standing invariant
  // rather than a one-off clear on entry. A track can arrive later than the
  // view mode does: `pendingTrackedSatellite` resolves whenever its group
  // finishes loading, which can be long after. Writing the store rather than
  // `viewer.trackedEntity` matters — tracking is the one value the globe
  // reports back, so poking Cesium would reach the store from behind and race
  // the forward path.
  watch(
    () => satStore.trackedSatellite,
    (tracked) => {
      if (tracked !== "" && cc.skyView.active) {
        satStore.trackedSatellite = "";
      }
    },
  );

  // Moving the first ground station moves the observer under a live sky view.
  // Removing every station does not close it: the view stays where it was
  // rather than collapsing out from under someone editing their stations.
  watch(
    () => satStore.groundStations[0],
    (station) => {
      if (station && cc.skyView.active) {
        cc.skyView.enter({ lat: station.lat, lon: station.lon });
      }
    },
    { deep: true },
  );
  watch(
    () => cesiumStore.cameraMode,
    (mode) => {
      cc.cameraMode = mode;
    },
  );
  watch(
    () => cesiumStore.qualityPreset,
    (preset) => {
      cc.qualityPreset = preset;
    },
    { immediate: true },
  );
  watch(
    () => cesiumStore.showFps,
    (show) => {
      cc.showFps = show;
    },
  );
  watch(
    () => cesiumStore.background,
    (on) => {
      cc.background = on;
    },
  );

  // --- the scene ------------------------------------------------------------
  const desired = (): DesiredScene => ({
    enabledTags: [...satStore.enabledTags],
    enabledSatellites: [...satStore.enabledSatellites],
    disabledSatellites: [...satStore.disabledSatellites],
    components: [...satStore.enabledComponents],
    groundStations: satStore.groundStations.map((station) => ({ ...station })),
    overpassMode: satStore.overpassMode,
    trackedSatellite: satStore.trackedSatellite,
  });

  // Which element sets are in force follows the clock and the activation, so it
  // is resynced after both — after reconcile, because it asks the manager which
  // satellites are enabled.
  const elsets = createElsetSync(cc, () => cesiumStore.time);

  watch(
    desired,
    (next) => {
      cc.sats.reconcile(next);
      elsets.sync();
    },
    { deep: true, immediate: true },
  );

  // --- the clock ------------------------------------------------------------
  // Live by default: `time` is null and absent from the url, so a shared link
  // opens at the recipient's present. It pins on a deliberate act — a time in
  // the url, or the user dragging the timeline — and then follows the clock at
  // minute granularity so the link reproduces the moment being looked at.
  const clockMinute = (): string | undefined => toMinuteIso(JulianDate.toDate(cc.viewer.clock.currentTime));

  watch(
    () => cesiumStore.time,
    (pinned) => {
      if (pinned !== null && pinned !== (clockMinute() ?? null)) {
        cc.setTime(pinned);
      }
      elsets.sync();
    },
    { immediate: true },
  );

  let lastClockWrite = 0;
  cc.viewer.clock.onTick.addEventListener(() => {
    if (cesiumStore.time === null) {
      return;
    }
    const now = performance.now();
    if (now - lastClockWrite < MIN_CLOCK_WRITE_MS) {
      return;
    }
    const minute = clockMinute();
    if (minute === cesiumStore.time) {
      return;
    }
    lastClockWrite = now;
    cesiumStore.setTime(minute ?? null);
  });

  // Dragging the timeline is the other way in. Cesium's Timeline dispatches
  // this on its own element; it is absent in minimal ui, where there is no
  // timeline to drag.
  // Cesium dispatches this from Timeline.prototype._setTimeBarTime but does not
  // declare addEventListener on the widget, so the cast covers a typing gap
  // rather than an assumption.
  const timeline = cc.viewer.timeline as unknown as { addEventListener?: (type: string, listener: () => void) => void } | undefined;
  timeline?.addEventListener?.("settime", () => {
    cesiumStore.setTime(clockMinute() ?? null);
  });

  // --- back from the globe --------------------------------------------------
  cc.sats.onTrackedChange((name) => {
    satStore.trackedSatellite = name;
  });

  // The catalog is deliberately non-reactive — ~10k entries do not belong in
  // Pinia — so a revision counter is what lets catalog-derived views recompute.
  cc.sats.onCatalogChange(() => {
    satStore.catalogRevision += 1;
    // A group finishing its load brings satellites the current window was never
    // fetched for, so they would sit on their CelesTrak element sets until the
    // clock happened to move. Resync instead.
    elsets.sync();
  });
}
