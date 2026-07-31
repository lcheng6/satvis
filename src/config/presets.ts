/**
 * Configuration manager for different application presets
 * Maps routes to their respective configurations and element-set sources.
 */

// A source is either a bare GP group name (resolved against the probed GP base,
// worker `/api/gp/<name>.json` or the static `data/gp/<name>.json` snapshot) or
// an explicit URL/path (anything containing "/" or ".", incl. legacy .txt),
// which passes through unchanged and is parsed via payload sniffing.
export type ElementsEntry = [source: string, tags: string[]];

export interface PresetConfig {
  sat?: {
    enabledTags?: string[];
    enabledComponents?: string[];
    overpassMode?: string;
  };
  cesium?: {
    layers?: string[];
    // One of SCENE_MODES. No preset sets it yet; it is here so that a route can
    // open straight into the sky view without the type having to change first,
    // which is the point of a preset supplying defaults.
    sceneMode?: string;
  };
}

export interface Preset {
  title: string;
  description?: string;
  config: PresetConfig;
  elements: ElementsEntry[];
}

export const presets: Record<string, Preset> = {
  default: {
    title: "Satellite Orbit Visualization",
    config: {
      sat: {
        enabledTags: ["Weather"],
      },
    },
    // Bare group names matching worker/src/config/satvis.core.yaml.
    elements: [
      ["cubesat", ["Cubesat"]],
      ["globalstar", ["Globalstar"]],
      ["gnss", ["GNSS"]],
      ["iridium-NEXT", ["IridiumNEXT"]],
      ["last-30-days", ["New"]],
      ["oneweb", ["OneWeb"]],
      ["planet", ["Planet"]],
      ["resource", ["Resource"]],
      ["science", ["Science"]],
      ["spire", ["Spire"]],
      ["starlink", ["Starlink"]],
      ["stations", ["Stations"]],
      ["weather", ["Weather"]],
      ["eutelsat", ["Eutelsat"]],
      // Tag carries the operator's name with its space; only commas are barred
      // from a tag, and the group name itself must stay url-safe.
      ["ast-spacemobile", ["AST SpaceMobile"]],
    ],
  },
  ot: {
    title: "OT Satellite Orbit Visualization",
    config: {
      sat: {
        enabledTags: ["OT"],
        enabledComponents: ["Point", "Label", "Orbit", "Sensor cone", "Ground track"],
        overpassMode: "swath",
      },
      cesium: {
        layers: ["ArcGis"],
      },
    },
    elements: [
      ["ot", ["OT"]],
      ["wfs", ["WFS"]],
    ],
  },
};

/**
 * Get configuration preset based on current route/path
 */
export function getConfigPreset(path: string = window.location.pathname): Preset {
  // Extract the last path segment, removing .html extension if present
  const routeName = (path.split("/").pop() ?? "").replace(/\.html$/, "");

  switch (routeName) {
    case "ot":
      return presets.ot as Preset;
    default:
      return presets.default as Preset;
  }
}

/**
 * Update document title and meta description based on preset
 */
export function updateMetadata(preset: Preset): void {
  document.title = preset.title;
  const metaDescription = document.querySelector('meta[name="description"]');
  if (metaDescription && preset.description) {
    metaDescription.setAttribute("content", preset.description);
  }
}
