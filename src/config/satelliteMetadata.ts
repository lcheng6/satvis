// Per-satellite metadata: the static facts a served GP record carries alongside
// its element set, attached by the worker at refresh time from the satellite
// table in worker/src/config/satvis.core.yaml (and plugin configs).
//
// The worker treats the bag as opaque and only copies it, so this file is the
// single place where it acquires meaning. Adding a field costs a declaration here,
// a value in the YAML, and a reader wherever it should show up (for a display-only
// field, a row in entityInfo.getSatelliteInfo) — but no worker or pipeline change,
// because nothing between the config and this file inspects the payload. The one
// exception is the swath pair, whose both-or-neither rule the generator enforces.
//
// This module must stay Cesium-free (node-env vitest exercises it).

// Static facts about one satellite. Every field is optional: a record either
// carries a value or the consumer applies its own default (see the DEFAULT_*
// constants below and SatelliteProperties).
export interface SatelliteMetadata {
  // Cross-track distance (km) from the ground track to the swath edge, per side,
  // relative to flight direction (starboard = velocity bearing + 90°). NOT
  // halves of a full width — the sides can differ, e.g. Sentinel-3's SLSTR is
  // tilted against sunglint. Given for both sides or neither (the generator
  // rejects a half-specified swath), so consumers read them as a pair.
  swathStarboardKm?: number;
  swathPortKm?: number;
  coneFovDeg?: number;
  modelUrl?: string;
  // Display-only, free text, shown verbatim in the entity info panel.
  operator?: string;
  missionType?: string;
  // Date the satellite reached orbit (CelesTrak SATCAT LAUNCH_DATE, attached at
  // refresh time). A satellite is not drawn at a simulation time before it.
  //
  // Not derivable from an element set — a TLE propagates backwards past its own
  // launch perfectly happily — and not the same as the first epoch the elset
  // history holds, which can be months later.
  launchDate?: string;
}

/**
 * True when this satellite had not reached orbit at `timeMs`.
 *
 * False when no launch date is recorded: absence of the fact is not evidence
 * the satellite did not exist, and hiding on a missing field would blank every
 * satellite whose group has no satcat source.
 */
export function launchedAfter(metadata: SatelliteMetadata, timeMs: number): boolean {
  if (metadata.launchDate === undefined) {
    return false;
  }
  const launchMs = Date.parse(metadata.launchDate);
  return Number.isFinite(launchMs) && timeMs < launchMs;
}

// Total swath width for a satellite with no extents of its own. Kept as a total
// rather than a pair of per-side halves so "200 km wide by default" is stated
// once, and a half-specified swath cannot arise here either.
export const DEFAULT_SWATH_KM = 200;

export const DEFAULT_CONE_FOV_DEG = 10;

/**
 * Per-side cross-track extents of a sensor footprint (km), measured from the
 * ground track outwards relative to flight direction.
 *
 * Lives here rather than beside its consumers because the pair is one domain
 * value: the two fields are stored together, validated together (the generator
 * rejects a half-specified swath) and read together.
 */
export interface SwathExtents {
  starboardKm: number;
  portKm: number;
}

/**
 * The satellite's own extents, or `undefined` when its record carries none.
 *
 * The single place the both-or-neither rule is interpreted. Callers that need a
 * usable value fall back to a default; callers that must distinguish real data
 * from a fallback — the info panel, which would otherwise present a renderer
 * default as a fact — check for `undefined`.
 */
export function swathExtentsOf(metadata: SatelliteMetadata): SwathExtents | undefined {
  const { swathStarboardKm, swathPortKm } = metadata;
  if (swathStarboardKm === undefined || swathPortKm === undefined) {
    return undefined;
  }
  return { starboardKm: swathStarboardKm, portKm: swathPortKm };
}
