<template>
  <div class="cesium">
    <div v-show="showUI" id="toolbarLeft">
      <div class="toolbarButtons">
        <UTooltip text="Satellite selection">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('cat')">
            <UIcon name="lucide:satellite" />
          </button>
        </UTooltip>
        <UTooltip text="Satellite components">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('sat')">
            <UIcon name="lucide:orbit" />
          </button>
        </UTooltip>
        <UTooltip text="Ground station">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('gs')">
            <UIcon name="lucide:map-pin" />
          </button>
        </UTooltip>
        <UTooltip text="Map">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('map')">
            <UIcon name="lucide:layers" />
          </button>
        </UTooltip>
        <UTooltip text="View">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('view')">
            <UIcon name="lucide:telescope" />
          </button>
        </UTooltip>
        <UTooltip text="Simulation time">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('time')">
            <UIcon name="lucide:calendar-clock" />
          </button>
        </UTooltip>
        <UTooltip v-if="cc.minimalUI" text="Mobile">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('ios')">
            <UIcon name="lucide:smartphone" />
          </button>
        </UTooltip>
        <UTooltip text="Debug">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('dbg')">
            <UIcon name="lucide:hammer" />
          </button>
        </UTooltip>
      </div>
      <!-- v-if (not v-show like the other panels): the virtualized list inside
           measures its scroll element on mount, and mounting hidden (display:none)
           yields a 0-height measurement that only a later ResizeObserver tick would
           fix. Mounting on open guarantees a correct first paint; browser state
           (search, expansion) is module-scoped in useSatelliteBrowser and survives
           remounts. -->
      <div v-if="menu.cat" class="toolbarSwitches toolbarSwitches--catalog">
        <satellite-browser />
      </div>
      <div v-show="menu.sat" class="toolbarSwitches">
        <!-- "Components", not "elements": an element set is the GP data a
             satellite is built from, and this panel is about what is drawn. -->
        <div class="toolbarTitle">Satellite components</div>
        <label v-for="componentName in cc.sats.availableComponents" :key="componentName" class="toolbarSwitch">
          <input v-model="enabledComponents" type="checkbox" :value="componentName" />
          <span class="slider"></span>
          {{ componentName }}
        </label>
        <!--
        <label class="toolbarSwitch">
          <input type="button" @click="cc.viewer.trackedEntity = undefined">
          Untrack Entity
        </label>
        -->
      </div>
      <div v-show="menu.gs" class="toolbarSwitches">
        <div class="toolbarTitle">Ground station</div>
        <label class="toolbarSwitch">
          <input v-model="pickMode" type="checkbox" />
          <span class="slider"></span>
          Pick on globe
        </label>
        <label class="toolbarSwitch">
          <input type="button" :disabled="locating" @click="void locate()" />
          <span v-if="locating" class="toolbarSpinner"></span>
          Set from geolocation
        </label>
        <label class="toolbarSwitch">
          <input type="button" @click="cc.sats.focusGroundStation()" />
          Focus
        </label>
        <div class="toolbarTitle">Overpass calculation</div>
        <label class="toolbarSwitch">
          <input v-model="overpassMode" type="radio" value="elevation" />
          <span class="slider"></span>
          Elevation
        </label>
        <label class="toolbarSwitch">
          <input v-model="overpassMode" type="radio" value="swath" />
          <span class="slider"></span>
          Swath
        </label>
      </div>
      <div v-show="menu.map" class="toolbarSwitches">
        <div class="toolbarTitle">Layers</div>
        <label v-for="name in cc.imageryProviderNames" :key="name" class="toolbarSwitch">
          <input v-model="layerSelection" type="checkbox" :value="name" />
          <span class="slider"></span>
          {{ name }}
        </label>
        <div class="toolbarTitle">Terrain</div>
        <label v-for="name in cc.terrainProviderNames" :key="name" class="toolbarSwitch">
          <input v-model="terrainProvider" type="radio" :value="name" />
          <span class="slider"></span>
          {{ name }}
        </label>
      </div>
      <!-- Where you look from and with what, as against the Map panel's what you
           are looking at. -->
      <div v-show="menu.view" class="toolbarSwitches">
        <div class="toolbarTitle">View</div>
        <label v-for="name in cc.sceneModes" :key="name" class="toolbarSwitch">
          <input v-model="sceneMode" type="radio" :value="name" />
          <span class="slider"></span>
          {{ name }}
        </label>
        <div class="toolbarTitle">Camera</div>
        <label v-for="name in cc.cameraModes" :key="name" class="toolbarSwitch">
          <input v-model="cameraMode" type="radio" :value="name" />
          <span class="slider"></span>
          {{ name }}
        </label>
        <!-- Only in the sky view, which is the only place an aim exists to hand
             over, and only where the sensor could work at all. -->
        <template v-if="inSkyView && compassOffered">
          <div class="toolbarTitle">Aiming</div>
          <label class="toolbarSwitch">
            <input type="checkbox" :checked="compassActive" :disabled="compassPending" @change="onCompassToggle" />
            <!-- The spinner stands in for the slider rather than joining it: both
                 occupy the row's left gutter, and one of the two is always the
                 answer to "what is this control doing". -->
            <span v-if="compassPending" class="toolbarSpinner"></span>
            <span v-else class="slider"></span>
            Use compass
          </label>
        </template>
      </div>
      <!-- Where the simulation starts. The field is UTC, matching every other
           time the app shows and the `time` url parameter; datetime-local has no
           zone of its own, so the value is read and written as UTC text. -->
      <div v-show="menu.time" class="toolbarSwitches">
        <div class="toolbarTitle">Simulation time</div>
        <div class="toolbarContent">
          <input v-model="timeInput" class="toolbarInput" type="datetime-local" step="60" aria-label="Simulation start time (UTC)" />
          <div class="toolbarNote">UTC — currently {{ timeState }}</div>
        </div>
        <label class="toolbarSwitch">
          <input type="button" @click="applyTime" />
          Set start time
        </label>
        <!-- Back to following the present. Two steps and in this order: move the
             clock first, then clear the pin — clearing it first would leave the
             clock parked wherever it was, still stopped, and merely unpinned. -->
        <label class="toolbarSwitch">
          <input type="button" @click="resumeLive" />
          Resume live
        </label>
      </div>
      <div v-show="menu.ios" class="toolbarSwitches">
        <div class="toolbarTitle">Mobile</div>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.useWebVR" type="checkbox" />
          <span class="slider"></span>
          VR
        </label>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.clock.shouldAnimate" type="checkbox" />
          <span class="slider"></span>
          Play
        </label>
        <label class="toolbarSwitch">
          <input type="button" @click="cc.viewer.clockViewModel.multiplier *= 2" />
          Increase play speed
        </label>
        <label class="toolbarSwitch">
          <input type="button" @click="cc.viewer.clockViewModel.multiplier /= 2" />
          Decrease play speed
        </label>
        <label class="toolbarSwitch">
          <input type="button" @click="reload" />
          Reload
        </label>
      </div>
      <div v-show="menu.dbg" class="toolbarSwitches">
        <div class="toolbarTitle">Debug</div>
        <label class="toolbarSwitch">
          <input v-model="showFps" type="checkbox" />
          <span class="slider"></span>
          FPS
        </label>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.requestRenderMode" type="checkbox" />
          <span class="slider"></span>
          RequestRender
        </label>
        <label class="toolbarSwitch">
          <input v-model="qualityPreset" true-value="high" false-value="low" type="checkbox" />
          <span class="slider"></span>
          High Quality
        </label>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.fog.enabled" type="checkbox" />
          <span class="slider"></span>
          Fog
        </label>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.globe.enableLighting" type="checkbox" />
          <span class="slider"></span>
          Lighting
        </label>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.highDynamicRange" type="checkbox" />
          <span class="slider"></span>
          HDR
        </label>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.globe.showGroundAtmosphere" type="checkbox" />
          <span class="slider"></span>
          Atmosphere
        </label>
        <label class="toolbarSwitch">
          <input type="button" @click="cc.jumpTo('Everest')" />
          Jump to Everest
        </label>
        <label class="toolbarSwitch">
          <input type="button" @click="cc.jumpTo('HalfDome')" />
          Jump to HalfDome
        </label>
      </div>
    </div>
    <div id="toolbarRight">
      <UTooltip v-if="showUI" text="Github">
        <a class="cesium-button cesium-toolbar-button" href="https://github.com/Flowm/satvis/" target="_blank" rel="noopener">
          <UIcon name="fa6-brands:github" />
        </a>
      </UTooltip>
      <UTooltip text="Toggle UI">
        <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleUI">
          <UIcon name="lucide:eye" />
        </button>
      </UTooltip>
    </div>
    <!-- Deliberately outside the showUI toggle: the entity info replaces the
         Cesium InfoBox, which was visible with hidden UI and in minimalUI. -->
    <entity-info-panel />
    <sky-hud />
  </div>
</template>

<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, onMounted, reactive, ref, watch } from "vue";

import { useGeolocation } from "../composables/useGeolocation";
import { compassAvailable, useSkyCompass } from "../composables/useSkyCompass";
import { SKY_MODE } from "../config/viewModes";
import { DeviceDetect } from "../modules/util/DeviceDetect";
import { toMinuteIso } from "../modules/util/urlCodec";
import { useCesiumStore } from "../stores/cesium";
import { useSatStore } from "../stores/sat";
import EntityInfoPanel from "./EntityInfoPanel.vue";
import SatelliteBrowser from "./SatelliteBrowser.vue";
import SkyHud from "./SkyHud.vue";

type MenuKey = "cat" | "sat" | "gs" | "map" | "view" | "time" | "ios" | "dbg";

const cc = globalThis.cc;

const menu = reactive<Record<MenuKey, boolean>>({
  cat: false,
  sat: false,
  gs: false,
  map: false,
  view: false,
  time: false,
  ios: false,
  dbg: false,
});
const showUI = ref(true);

const cesiumStore = useCesiumStore();
const { layers, terrainProvider, sceneMode, cameraMode, qualityPreset, showFps, pickMode, time } = storeToRefs(cesiumStore);

// The datetime-local field's own text. Held apart from the store rather than
// v-modelled onto it, because the store's value is what the clock IS: binding
// them would re-pin the clock on every keystroke, including the half-typed
// years a date field emits while being edited.
const timeInput = ref("");

const timeState = computed(() => (time.value === null ? "live" : `pinned to ${time.value}`));

// Seed the field on open, so it shows the moment being looked at rather than
// whatever was typed and abandoned last time. `time` is null while live, and
// then the present is the honest starting point.
watch(
  () => menu.time,
  (open) => {
    if (open) {
      timeInput.value = (time.value ?? toMinuteIso(new Date()) ?? "").replace(/Z$/, "");
    }
  },
);

function applyTime(): void {
  const value = timeInput.value.trim();
  if (value === "") {
    return;
  }
  // datetime-local yields zone-less text; the trailing Z is what declares it
  // UTC, matching the field's label and the url parameter.
  cesiumStore.setTime(`${value}Z`);
  menu.time = false;
}

function resumeLive(): void {
  cc.setTime(new Date());
  cesiumStore.setTime(null);
  menu.time = false;
}

// The checkbox list writes the whole array back. layers is read-only because
// "at most one base layer" is an invariant of the list, so the write is routed
// through the action that enforces it.
const layerSelection = computed({
  get: () => layers.value,
  set: (next: string[]) => cesiumStore.setLayers(next),
});

const satStore = useSatStore();
const { enabledComponents, overpassMode } = storeToRefs(satStore);

const { pending: locating, locate } = useGeolocation();

const compassOffered = compassAvailable();
const { active: compassActive, pending: compassPending, toggle: toggleCompass } = useSkyCompass();
const inSkyView = computed(() => sceneMode.value === SKY_MODE);

// Handing the aim to a sensor is an action with an outcome, and the outcome may be
// "no". The browser's own flip on click is the feedback that something was
// attempted — and iOS's permission prompt has to be raised from inside the click —
// so the switch moves first and is corrected afterwards.
//
// The correction has to be made by hand. Vue re-syncs a checkbox only when the value
// bound to it changes, and a refused sensor leaves `compassActive` exactly where it
// was, so the box would sit there checked and contradicting it.
async function onCompassToggle(event: Event): Promise<void> {
  await toggleCompass();
  (event.target as HTMLInputElement).checked = compassActive.value;
  // Success closes the panel, which was covering the sky it was just asked to aim
  // at — so the revert above is only ever seen when it means something.
  if (compassActive.value) {
    menu.view = false;
  }
}

onMounted(() => {
  showUI.value = !DeviceDetect.inIframe();
});

function toggleMenu(name: MenuKey) {
  const oldState = menu[name];
  (Object.keys(menu) as MenuKey[]).forEach((k) => {
    menu[k] = false;
  });
  menu[name] = !oldState;
}

function toggleUI() {
  showUI.value = !showUI.value;
  if (!cc.minimalUI) {
    cc.showUI = showUI.value;
  }
}

function reload() {
  window.location.reload();
}
</script>
