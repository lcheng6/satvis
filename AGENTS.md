# AGENTS.md

## Setup

```sh
git submodule update --init
pnpm install
```

A single `pnpm install` at the repository root installs dependencies for both
the SPA and the `worker/` package (a pnpm workspace). CI uses `pnpm ci`.

## Commands

| Task              | Command                                                               |
| ----------------- | --------------------------------------------------------------------- |
| Dev server        | `pnpm dev` (proxies `/api` → <https://satvis.space>)                  |
| Full-stack dev    | `pnpm dev:worker` + `SATVIS_API_PROXY=http://localhost:8080 pnpm dev` |
| Build             | `pnpm build`                                                          |
| Test (CI)         | `pnpm test` (frontend) and `pnpm --filter satvis-worker test`         |
| Lint (CI)         | `pnpm lint` (runs frontend and worker lint)                           |
| Lint fix          | `pnpm lint:fix` (runs frontend and worker fixes)                      |
| Type-check only   | `pnpm type-check`                                                     |
| Refresh static GP | `pnpm update-gp` (writes the gitignored `data/gp/` snapshot)          |
| Deploy            | `pnpm deploy` (builds frontend, then deploys worker)                  |

Worker-only scripts run via `pnpm --filter satvis-worker <script>`.

CI runs `lint`, then `test` (frontend + worker), then `build`.

## Architecture

- **Frontend**: Vue 3 + Vite + CesiumJS + Nuxt UI (Tailwind). Single-page app in `src/`.
- **Worker**: Cloudflare Worker backend in `worker/` — a workspace package (`satvis-worker`) with its own `package.json`, installed by the root `pnpm install`. Uses Wrangler for dev/deploy. Has its own `lint`, `type-check`, `test`, and `generate-types` scripts (run via `pnpm --filter satvis-worker <script>`).
- **Satellite data (GP element sets)**: fetched from CelesTrak as OMM JSON.
  - The worker refreshes each group into Workers KV via a cron trigger (every 3 h) and serves `/api/gp/<group>.json` and `/api/groups.json`.
  - Config is declarative and YAML: core config in `worker/src/config/satvis.core.yaml`, plugin config in `data/custom/<plugin>/satvis.yaml`. Each contributes two independent sections — `groups` (`sources`/`satellites`/`select`/`rename`/`include`/`extraRecordsFile`) and `satellites` (static per-satellite facts keyed by NORAD id). `pnpm --filter satvis-worker generate-groups` merges them into the gitignored `worker/src/config/satvis.generated.json`.
  - **Satellite metadata** (swath extents, sensor FOV, model URL, operator) is attached to each matching record **at refresh time**, under a lowercase `metadata` key, from the merged satellite table. There is no metadata endpoint and no browser-side rule matching: a record either carries the bag or the frontend applies its defaults (`src/config/satelliteMetadata.ts`). See `docs/adr/0002-static-satellite-metadata.md`.
  - **Worker-less mode**: `pnpm update-gp` runs the same evaluator and writes a static snapshot into `data/gp/` (gitignored). The app probes `/api/groups.json` and falls back to that snapshot.
- **Databricks (element sets from Unity Catalog)**: `worker/src/databricks/` talks to the
  SQL **Statement Execution REST API** over plain `fetch` — deliberately _not_ the
  `@databricks/sql` npm driver, which speaks Thrift over Node sockets and cannot run on
  workerd. `client.ts` submits, polls and walks result chunks; `elset.ts` resolves the
  time-appropriate element set per satellite; `config.ts` resolves the connection from
  env. Off unless configured, and a _partial_ configuration is a hard error rather than a
  silent downgrade. See "Databricks configuration" below.
- **Time-appropriate element sets**: while the clock is **pinned**, each enabled satellite is
  propagated from the element set whose SCD2 validity interval contains that moment, and a
  satellite with no such element set is not drawn at all. `elsetWindow.ts` fetches a
  7-day window from `/api/elset/window` (bounds bucketed to 6 h so scrubbing mostly resolves
  locally and refetches hit the worker's edge cache); `elsetSync.ts` turns the clock into
  overrides plus an unlaunched set; `SatelliteCatalog` holds an override **beside**
  `baseRecord` (metadata falls back to the base — an override is a bare element set);
  `SatelliteManager.applyElsetOverrides` rebuilds the affected satellites, because `Orbit`
  is constructed from the record. **Live time is left alone** — CelesTrak is hours old at
  most. See "Databricks configuration" below.
- **Data assets**: `data/` also contains Cesium assets (imagery, textures, stars) and 3D-model plugins under `data/custom/`. Copied into `dist/` at build time via `vite-plugin-static-copy`.
- Entrypoints: `index.html`, `embedded.html`, `test.html` (all configured as Vite MPA inputs).

## Key quirks

- **Cesium static assets**: Vite copies Cesium engine assets from `node_modules/@cesium/engine` and `@cesium/widgets` into `dist/cesium/`. The global `CESIUM_BASE_URL` is defined as `"./cesium"` in `vite.config.ts`.
- **Git submodules**: Required — `data/` content depends on them. Run `git submodule update --init` before first build. **`git worktree add` does not populate them**, so a fresh worktree has an empty `data/cesium-assets` (high-resolution offline imagery) and `data/models` (3D models). Imagery covers for this: the `OfflineHighres` layer probes its `tilemapresource.xml` and, when it is missing, the selection is switched to the bundled `Offline` layer with a toast. The probe exists because Cesium cannot report the failure — `TileMapServiceImageryProvider.fromUrl` treats a missing `tilemapresource.xml` as "carry on with defaults" and resolves happily, then 404s every tile behind a blank globe. The 3D models have no such fallback yet.
- **Build globals**: `__BUILD_DATE__` and `__BUILD_SHA__` are injected via `vite.config.ts` `define`.
- **Path aliases**: `@/*` → `src/*` (in `tsconfig.json`).
- **Formatting**: `oxfmt` (config in `.oxfmtrc.json`): `printWidth: 180`, `sortImports`, and `sortPackageJson` enabled.
- **Linting**: `pnpm lint` runs frontend `oxlint`, `oxfmt --check`, and `vue-tsc`, then the worker's own lint script.
- **Env files**: `.env.development` / `.env.production` — only PostHog keys (`VITE_POSTHOG_*`). See `.env.example`.
- **PWA**: Service worker via `vite-plugin-pwa` with Workbox caching strategies.
- **TypeScript**: Strict mode, `noUnusedLocals`, `noUncheckedIndexedAccess`. Unused vars must be prefixed with `_`.
- **Vue conventions**: Component names in templates must use kebab-case.

## Deployment

`pnpm deploy` builds the frontend and deploys the worker. The worker needs a KV
namespace bound as `GP_KV` (see `worker/wrangler.jsonc`). After the first
deploy, KV is empty until a cron run fills it — either wait for the cron
(≤ 3 h) or force a fill now against the deployed KV:

```
cd worker
wrangler dev --remote --test-scheduled
curl "http://localhost:8080/__scheduled?cron=23+*%2F3+*+*+*"
```

### Databricks configuration

Four vars in `worker/wrangler.jsonc` plus one secret. Locally they live in
`worker/.dev.vars` (gitignored — copy `worker/.dev.vars.example`); in production the
token is `wrangler secret put DATABRICKS_TOKEN` and never a var.

| Name                      | Kind       | Meaning                                                      |
| ------------------------- | ---------- | ------------------------------------------------------------ |
| `DATABRICKS_HOST`         | var        | Workspace URL, no trailing slash                             |
| `DATABRICKS_WAREHOUSE_ID` | var        | SQL warehouse to run statements on                           |
| `DATABRICKS_TOKEN`        | **secret** | PAT or OAuth access token                                    |
| `DATABRICKS_ELSET_TABLE`  | var        | Overrides the SCD2 elset view; blank uses the default        |
| `DATABRICKS_PROBE`        | var        | `"1"` exposes `GET /api/databricks/probe`; off in production |

All blank → "not configured", and the worker serves CelesTrak data exactly as before.
Some-but-not-all set → startup-time error, because a half-set connection is a deployment
mistake, not a feature flag.

`GET /api/databricks/probe?satnos=<ids>&at=<iso8601>` is the connectivity check: it
resolves the time-appropriate element set for each id and reports epoch, epoch age,
provenance and the ids the view had nothing for. It is unauthenticated and every call
spins a metered warehouse, so it is disabled unless `DATABRICKS_PROBE=1` — local only.
Expect ~16 s on a cold warehouse, ~7 s warm.

**Selecting an element set by time** (`worker/src/databricks/elset.ts`) — the SCD2 validity
match, with a half-open interval:

```
__START_AT <= t  AND  (__END_AT IS NULL OR t < __END_AT)
```

The start is inclusive so an instant landing exactly on an epoch is resolvable and belongs
to exactly one row. **A satellite with no matching row is not drawn at that time.** Know
what that costs before changing it: the chain is not continuous — 763 of 2,679 sampled rows
are followed by a gap (0 overlap, longest ~19.8 days), which puts 41-46% of an AST
satellite's history inside a gap, and **1,824 of 6,451 satellites have no open row at all**
(1,698 of them active in the last 30 days — dangling closes upstream, not decays), so they
are invisible at present time. Satellites therefore blink in and out as the clock moves.
The gap-immune alternative, should it be wanted, is to fall back to the greatest
`__START_AT` ≤ t when no interval matches.

One more verified fact about this table, useful whichever rule is in force: `__START_AT`
**is** the TLE epoch — across 1,145 sampled rows the epoch parsed out of `line1` and
`__START_AT` differ by 0 s. So a row's validity begins exactly at its own epoch.

**Launch dates are data, never config.** Two sources, because neither covers everything:

- The view's satcat **`LAUNCH`** column, for satellites the elset table has history for.
  Do not confuse it with a satellite's first `__START_AT`: the AST satellites launched
  2024-09-12 but the table's history for them begins 2025-04, so "not launched yet" and
  "no history that far back" are different facts, reported as different resolutions
  (`before-launch` vs `before-first`).
- **CelesTrak SATCAT**, via a group's `satcatSources` (see below), for satellites the
  elset table has _no rows for at all_ — which is 4 of the 9 AST satellites. Without it
  they resolve to `unknown`, keep their CelesTrak element set, and are drawn at every
  simulation time including years before they launched.

### `satcatSources` — launch dates for satellites the elset table cannot reach

A group may declare `satcatSources` alongside `sources`. They are fetched by the same
rate-limited pass (`collectSources` includes them) but read **only** for `LAUNCH_DATE`,
which `buildLaunchDates` turns into a satnum→date table and `enrichRecords` attaches as
`metadata.launchDate`. Nothing from a satcat source is ever served: `evaluateGroups` looks
at `def.sources` alone, so a satcat payload cannot become a record.

Give each element-set query a satcat twin — the endpoints take the same parameters:

```yaml
sources:
  - { url: "https://celestrak.org/NORAD/elements/gp.php?INTDES=2026-139&FORMAT=JSON" }
satcatSources:
  - { url: "https://celestrak.org/satcat/records.php?INTDES=2026-139&FORMAT=JSON" }
```

A failed satcat fetch is a warning, not a group failure: a missing launch date costs
pre-launch visibility correctness, not the satellite. A `launchDate` set explicitly in a
config `satellites` row wins over the fetched value.

Variable-length id lists travel as one comma-joined **bound parameter**
(`array_contains(split(:satNos, ','), ...)`), never interpolated — the API binds scalars
only. The table name _is_ interpolated (no API can bind an identifier) and so is validated
against `^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+){0,2}$` first.

`GET /api/elset/window?satnos=<ids>&from=<iso>&to=<iso>` is the route the app itself uses.
It returns every element set whose **validity interval overlaps** the window — which is
exactly the set that can answer any instant in it, a row starting before the window but
still in force included by the same condition — plus each satellite's `firstEpoch`. A
satellite with a `firstEpoch` but no rows in range had not launched yet; one listed in
`uncovered` is absent from the table entirely and must keep its CelesTrak element set.
Unlike the probe this route is live in production, so it is capped (≤200 satellites,
≤90-day span) and edge-cached for 15 min on normalized parameters.

Note `worker/test/` runs with `.dev.vars` loaded, so real credentials may be present in
the test env. The Databricks tests set the whole `DATABRICKS_*` triple explicitly and
assert no request escapes.

### Private plugin config (`data/custom/<plugin>/satvis.yaml`)

Private plugins are untracked directories under `data/custom/`, each holding a
declarative YAML config (same trust model as before — never commit private plugin
data). They replaced hand-written `sync.sh` scripts that `grep`/`sed`-ed the bundled
TLE files. A config has two independent top-level sections, both optional: `groups`
and `satellites`.

The generator **fails loudly** on a plugin directory holding a pre-YAML
`groups.json` with no `satvis.yaml` beside it — a silent skip would make that
plugin's groups vanish from the build.

`groups` entries take:

- **`satellites`** (preferred for known, individually-named satellites): an
  array of per-satellite rows, each co-locating a satellite's NORAD id, its
  expected upstream name, and its display name so a rename's three facts live
  together instead of being scattered across `select.noradIds` and `rename`:

  ```yaml
  satellites:
    - { noradId: 25544, upstreamName: ISS (ZARYA), name: ISS }
  ```

  A row matches by `noradId` when present (else by exact `upstreamName`), is
  unioned with `select`, and its `name` renames the matched record (taking
  precedence over the `rename` map). Omit `name` to keep the upstream name;
  omit `noradId` to select a satellite that only has an upstream name. When a
  row carries both id and `upstreamName`, an id match against a differently
  named record — or a row whose id matches nothing — surfaces a warning in
  `/api/groups.json` (the group's `warnings` array) so upstream renames and
  decays are caught.

  Optional per-row **`metadata`** (e.g. `{ swathStarboardKm: 205, swathPortKm: 205 }`)
  is lifted into the merged satellite table under that row's `noradId`, so it
  applies **wherever the record is served**, not only in this group — write a
  value once even when the satellite appears in several groups. Requires a
  `noradId` (matching is by id only) and must not be empty. Two places giving one
  satellite different values for a field is a build failure, not a precedence
  question.

  Optional **`decayed: true`** marks a satellite expected never to match again. It
  suppresses the "matched no record" warning (and warns in reverse if the id does
  match), so a permanently-gone satellite cannot bury the report of one that has
  just disappeared unexpectedly.

- **`select`** (for bulk/pattern selection): `noradIds`, `names`, or a
  `namePattern` regex, ORed together. Prefer `noradIds` over `names` — CelesTrak
  `OBJECT_NAME` values are matched exactly and lose the old fixed-width TLE
  padding, so name matches are brittle. Use `namePattern` for whole
  constellations (`^STARLINK`).
- **`rename`**: `{ "<OBJECT_NAME>": "<new name>" }`, applied after select to any
  record a `satellites` row did not already rename. Use for bulk/pattern renames;
  for a single known satellite prefer a `satellites` row.
- **`extraRecordsFile`**: a path (relative to the config) to a TLE text file for
  pseudo element sets (fake satnums that can't be expressed as OMM). The
  generator inlines it into `extraRecords`.
- **`include`**: compose groups by name. **Semantics differ from the old shell
  pipeline**: an included group contributes its FULL evaluated output —
  including its own `extraRecords` and renames — prepended before this group's
  records (the old sync.sh concatenated the base list _before_ appending
  extras). If you need the old ordering, split the extras into a separate
  included group. See the comment on `include` in `worker/src/gp/types.ts`.
- **`celestrakSup`**: use `{ celestrakSup: <file> }` sources for CelesTrak
  supplemental data (e.g. launch/pre-launch element sets).

The top-level **`satellites`** section (a sibling of `groups`, not nested inside
one) is the satellite table: static facts keyed by NORAD id, independent of any
group, because a satellite's swath is not a fact about a group. `name` there is
documentation only — matching is by id.

```yaml
satellites:
  - { noradId: 41335, name: SENTINEL-3A, swathStarboardKm: 1000, swathPortKm: 500 }
```

Everything in an entry except `noradId`, `name` and `decayed` **is** the metadata
bag, so adding a field is a data-only edit. Swath extents are per-side cross-track
distances from the ground track relative to flight direction (starboard = velocity
bearing + 90°) — not halves of a width, and required in both-or-neither pairs. Use
a group row's `metadata` when the row already exists; use this table otherwise —
and note that adding rows to a pass-all group (one with neither `satellites` nor
`select`) would filter it down to just those rows.

Deploy migration: write the plugin `satvis.yaml`, delete the old local `sync.sh`
and any pre-YAML `groups.json`, `pnpm deploy`, then force the first KV fill as
above.
