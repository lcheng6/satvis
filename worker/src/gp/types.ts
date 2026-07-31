// Shared GP (general perturbations) element-set types.
//
// IMPORTANT: This file (and everything else under worker/src/gp/) must stay
// node-type-strippable (erasable syntax only) because the static generator
// imports it with plain `node` (v24) type stripping. That means NO enums, NO
// namespaces, NO parameter properties, NO `import =` — only type-level syntax
// that erases cleanly to plain JS.

// CelesTrak OMM JSON record (GP element set). CelesTrak emits many optional
// fields; we only rely on OBJECT_NAME / NORAD_CAT_ID for selection, so the
// rest are kept as an open index signature.
export interface OmmRecord {
  OBJECT_NAME?: string;
  NORAD_CAT_ID?: number | string;
  OBJECT_ID?: string;
  EPOCH?: string;
  [key: string]: unknown;
}

// Escape hatch for pseudo element sets (ot-add / otc-p1) that use fake
// catalog numbers and cannot be expressed as OMM. Carried through the
// pipeline verbatim as two TLE lines.
export interface TleRecord {
  OBJECT_NAME?: string;
  TLE_LINE1: string;
  TLE_LINE2: string;
  // Attached by enrichRecords, like on OmmRecord (which admits it via its index
  // signature). Lowercase to stand apart from the SCREAMING_SNAKE CCSDS fields.
  metadata?: Record<string, unknown>;
}

export type GpRecord = OmmRecord | TleRecord;

// A single upstream source for a group. Exactly one key is present.
export type SourceSpec = { celestrak: string } | { celestrakSup: string } | { url: string };

export interface GroupSelect {
  noradIds?: (number | string)[];
  names?: string[];
  namePattern?: string;
}

// One row per satellite, co-locating its NORAD id, expected upstream name, and
// display-name override so a renamed satellite's three facts live together
// instead of being scattered across select.noradIds / rename. Preferred over
// select.noradIds+rename for known, individually-named satellites; select is
// still the tool for bulk/pattern selection.
export interface SatelliteSpec {
  // Primary selector — matched against NORAD_CAT_ID (numeric-normalized).
  noradId?: number;
  // Expected upstream OBJECT_NAME. Documents the satellite, validates the id
  // match (mismatch -> warning), and acts as the selector when noradId is
  // absent (exact OBJECT_NAME match).
  upstreamName?: string;
  // Display-name override. Omit to keep the upstream OBJECT_NAME.
  name?: string;
  // Optional per-satellite metadata (e.g. { swathStarboardKm: 205 }); the
  // generator lifts this into the merged satellite table, keyed by noradId, so
  // it applies wherever the record is served — not just in this group.
  metadata?: Record<string, unknown>;
  // The satellite has decayed and is expected to match no record ever again.
  // Suppresses the "matched no record" warning; a match warns in reverse.
  decayed?: boolean;
}

export interface GroupDefinition {
  // Served at /api/gp/<name>.json — must match ^[a-zA-Z0-9_-]+$.
  name: string;
  sources?: SourceSpec[];
  // Sources of CelesTrak SATCAT records, read ONLY for their LAUNCH_DATE, which
  // is then attached to matching records as `metadata.launchDate`. Nothing from
  // here is ever served: a satcat record is not an element set.
  //
  // A launch date cannot be derived from element sets — a TLE propagates
  // backwards past its own launch perfectly happily — so without this a
  // satellite is drawn at simulation times before it existed. Only needed for
  // satellites whose element-set history cannot answer the question itself.
  satcatSources?: SourceSpec[];
  select?: GroupSelect;
  // Per-satellite rows, unioned with `select`. A row matches by noradId when
  // present, else by exact upstreamName. A row's `name` renames the records it
  // matched (taking precedence over the group-level `rename` map).
  satellites?: SatelliteSpec[];
  // OBJECT_NAME -> new name, applied post-select.
  rename?: Record<string, string>;
  // Names of other groups whose FULL evaluated output — including their own
  // extraRecords and renames — is prepended before this group's own records
  // (they are evaluated first). This differs from the old ot-tle sync.sh, which
  // concatenated ot.txt into wfs.txt BEFORE appending ot-add.txt extras; authors
  // who want that ordering should put extras in a separate included group.
  include?: string[];
  // Inlined by the generator from extraRecordsFile; appended verbatim.
  extraRecords?: GpRecord[];
}

// One row of the satellite table: static facts about a satellite, matched
// against a record's NORAD_CAT_ID alone. `name` is documentation only.
//
// The worker treats `metadata` as opaque JSON — it copies the bag onto matching
// records without interpreting it, so new fields need no worker change. The
// frontend gives it meaning (see src/config/satelliteMetadata.ts).
export interface SatelliteEntry {
  noradId: number;
  name?: string;
  metadata: Record<string, unknown>;
  decayed?: boolean;
}

export interface GroupsConfig {
  groups: GroupDefinition[];
  satellites?: SatelliteEntry[];
}

// Per-group status entry stored in the KV index (gp:index).
export interface GroupStatus {
  name: string;
  updated: string | null;
  count: number;
  lastError?: string;
  lastErrorAt?: string;
  // Non-fatal issues from the last successful evaluation (e.g. a satellites row
  // whose id matched a record with an unexpected OBJECT_NAME, or whose id
  // matched no record at all). Present only when non-empty.
  warnings?: string[];
}

export interface GroupsIndex {
  updated: string;
  groups: GroupStatus[];
}
