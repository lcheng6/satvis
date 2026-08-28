## Retrieve Up to Date TLE from Databricks

Use this page to iterative augment capability of satvis to perform data fetch from my Databricks account, display a particular group of satellites, help me with analysis. Use this page for discover, scratch pads, and status

### Background

I believe the current set of TLEs used in the application is static. I would like to use my Databricks connection to get to SCD2 TLE table at `space_force_demo_v2.dev_analyst_enablement_and_retrieval.elset_scd2_with_satcat`, and use it to get the best time appropriate TLE for any given satellites.

I'm also interested in visualizing a group of satellites lauched by AST SpaceMobile, here are their satellite launch daets, and NORAD IDs:

Name→NORAD mapping (payloads):

| Name                      | NORAD | Intl des   | Launch     |
|---------------------------| ----- | ---------- | ---------- |
| BLUEWALKER 3              | 53807 | 2022-111AL | 2022-09-10 |
| SPACEMOBILE-001           | 61047 | 2024-163C  | 2024-09-12 |
| SPACEMOBILE-002           | 61048 | 2024-163D  | 2024-09-12 |
| SPACEMOBILE-003           | 61045 | 2024-163A  | 2024-09-12 |
| SPACEMOBILE-004           | 61049 | 2024-163E  | 2024-09-12 |
| SPACEMOBILE-005           | 61046 | 2024-163B  | 2024-09-12 |
| BLUEBIRD 8 (provisional)  | 69589 | 2026-139A  | 2026-06-17 |
| BLUEBIRD 9 (provisional)  | 69590 | 2026-139B  | 2026-06-17 |
| BLUEBIRD 10 (provisional) | 69591 | 2026-139C  | 2026-06-17 |
| BLUEBIRD 11               | 100240| 2026-179A  | 2026-08-05 |
| BLUEBIRD 12               | 100241| 2026-179B  | 2026-08-05 |
| BLUEBIRD 13               | 100242| 2026-179C  | 2026-08-05 |

The last three are the **3 additional Bluebirds launched 2026-08-05**, identified from the
warehouse rather than transcribed — see "The 2026-08-05 trio" below for how, and for two
further AST objects (67232, 67233) this list does not mention.

### Taskings

1. Establish Databricks connection within worker
2. Add an addition icon in the top left corner of the UI, to set the start time of the simulation. The icon should be represent the start of clock.
3. Add a Satellite group, called "AST SpaceMobile", that include the ones I've listed before.
4. When the simulation time change, make sure you are using the right TLE appropriate for the time, i.e. the table's `__START_AT` < simulation_time < `__END_AT`, or if `__END_AT` is a null value, then use the TLE where `__START_AT` < simulation_time
   - To perform this within a good latency, you might need to cache some TLE entries around simulation time.
   - If a satellite has no valid TLE entry that satisfies the time condition, it's probably because it hasn't been launched yet, don't display that satellite during the simulation time.

### Status

| #   | Tasking                                  | State                                                     |
| --- | ---------------------------------------- | --------------------------------------------------------- |
| 1   | Databricks connection in worker          | ✅ **done**, live-verified 2026-07-30                     |
| 2   | Simulation start-time icon (top left)    | ✅ **done**, verified in browser                          |
| 3   | "AST SpaceMobile" satellite group        | ✅ **done**, all 9 render                                 |
| 4   | Time-appropriate TLE as sim time changes | ✅ **done**, live-verified end to end (one caveat, below) |

Plus one unrelated bug found and fixed along the way: the **globe rendered black**
(the original report). See "Blank globe" below.

---

#### The 2026-08-05 trio — found in the warehouse (2026-08-27)

**Three more AST satellites launched 2026-08-05.** They are in Databricks now, and finding
them turned up three things that change what this page previously concluded.

##### What they are

| Catalog no. | TLE id (Alpha-5) | Intl des | First element set (UTC) | Chain |
| ----------- | ---------------- | --------- | ----------------------- | ----- |
| 100240      | `A0240`          | 2026-179A | 2026-08-05 09:18:14     | 32 rows, **0 gaps**, open |
| 100241      | `A0241`          | 2026-179B | 2026-08-05 09:18:14     | 33 rows, **0 gaps**, open |
| 100242      | `A0242`          | 2026-179C | 2026-08-05 09:17:37     | 34 rows, **0 gaps**, open |

The TLE epoch agrees: `26217.3877` — day 217 of 2026 is **2026-08-05**, 09:18:14 UTC. Same
`__START_AT`-is-the-epoch identity this page established earlier.

Current elements (newest open row, `__START_AT` 2026-08-27 ~06:00 UTC):

```
1 A0240U 26179A   26239.25208651 +.00002028 +00000+0 +13021-3 0 99992
2 A0240  52.9951 228.4552 0006743  44.9288 315.2248 15.13060276003326
1 A0241U 26179B   26239.24963658 +.00002013 +00000+0 +12879-3 0 99991
2 A0241  52.9946 228.4379 0007046  50.3542 309.8070 15.13228991003321
1 A0242U 26179C   26239.24816583 +.00001025 +00000+0 +73714-4 0 99994
2 A0242  52.9952 228.4327 0006833  54.9279 305.2352 15.13316101003326
```

##### How they were identified — orbit, not name

The warehouse **carries no name for them**: `descriptor` and `origObjectId` are empty on
every row, and the satcat side is stale (below). The identification is the orbital
signature plus the designator shape, both of which are decisive here:

| | 2026-139A/B/C (17 Jun trio) | 2026-179A/B/C (5 Aug trio) |
| --- | --- | --- |
| Inclination | 52.995° | 52.995° |
| Period | 95.16–95.20 min | 95.16–95.17 min |
| Altitude | 524 × 531 km | 522 × 531 km |
| RAAN (2026-08-27) | 300.7–303.1° | 228.43–228.46° |

Identical shell, **different plane** — 228° vs 303° RAAN, i.e. AST is populating a second
plane rather than adding to the first. Three payloads, pieces A/B/C, exactly the shape of
the June launch. Nothing else entering the catalogue on 2026-08-05 is near this orbit: the
day's other new objects sit at 97.29° and 98.55° (sun-synchronous) or in GTO.

`100242` is the odd one of the three at insertion — its first element set is
53.52° / 0.0125 eccentricity (517 × 589 km) versus its siblings' near-circular 53.00°. It
has since circularised into formation with them.

##### ⚠️ Correction — "Databricks simply does not know these satellites" was wrong

This page states that 53807, 69589, 69590 and 69591 have **0 rows** and concludes the
warehouse has never heard of them. The first half is true of the **view**; the conclusion
is not. `elset_scd2_with_satcat` is

```sql
FROM ... elset_scd2 e JOIN ... satcat_scd1 s ON e.idOnOrbit = s.NORAD_CAT_ID
```

— an **inner** join, and **`satcat_scd1` is frozen**: last ingest **2026-04-13**, latest
`LAUNCH` **2026-03-30**. Anything catalogued since April falls out of the view entirely.

The base table `elset_scd2` is current to this hour and has them all:

| | `elset_scd2` (base) | `elset_scd2_with_satcat` (view) |
| --- | --- | --- |
| Rows | 28,715,420 | 5,209,422 |
| Distinct satellites | **38,066** | 6,450 |
| Latest `__START_AT` | **2026-08-27 12:59** | 2026-07-29 |
| 53807 BLUEWALKER 3 | **565 rows** | 0 |
| 69589 / 69590 / 69591 | **153 / 150 / 148 rows** | 0 |
| 100240 / 100241 / 100242 | **32 / 33 / 34 rows** | 0 |

So the CelesTrak fallback for those four is not compensating for missing data — it is
compensating for a **stale dimension join**. Reading `elset_scd2` directly (and joining
satcat as a `LEFT JOIN`, for names only) would give real element sets for all of them,
including the new trio. That is the one change worth making off the back of this.

##### ⚠️ `satNo` is null on 41% of rows — and the worker keys on it

Separate defect, found while chasing BLUEWALKER 3. The `satNo` column is frequently null
while `idOnOrbit` and the TLE lines carry the number correctly:

| Measure | Value |
| --- | --- |
| Rows with `satNo IS NULL` | **11,896,863 / 28,715,420 (41%)** |
| **Currently-open** rows with `satNo IS NULL` | **5,377 / 38,118 (14.1%)** |
| Satellites whose only open row has a null `satNo` | **5,377** |

BLUEWALKER 3 is one of them. Its current open row:

```
satNo        (null)
idOnOrbit    53807
__START_AT   2026-08-27T11:59:31.875072Z
__END_AT     (null)
line1        1 53807U 22111AL  26239.49967448 ...
```

`worker/src/databricks/elset.ts` filters `array_contains(split(:satNos,','), cast(satNo AS
string))` and partitions `row_number() OVER (PARTITION BY satNo ...)`. Both miss these
rows, so a satellite in this state resolves to `no-valid-entry` and is **hidden even though
a valid open element set exists**. Keying on `idOnOrbit` (or
`coalesce(satNo, cast(idOnOrbit AS bigint))`) fixes it, and is the same column the view
already joins on.

Note this also means the earlier "1,824 / 6,451 satellites have no open row" figure
overstates the dangling-close problem — some share of it is this null instead.

##### Two AST objects this page has never listed

| Catalog no. | Intl des | Launch | In satcat? | Status |
| ----------- | --------- | ------- | ---------- | ------ |
| 67232 | 2025-309A | 2025-12-24 | ✅ `SPACEMOBILE-006` | open, 52.999° / 502 × 517 km |
| 67233 | 2025-309B | 2025-12-24 | ❌ not present | open, 52.93° / 490 × 506 km |

`SPACEMOBILE-006` launched **2025-12-24** and is fully covered by both the view and satcat —
it simply is not in the roster above. `67233` shares its launch and orbit but satcat carries
no row for it, so the warehouse cannot say whether it is the seventh payload or the upper
stage; **it is not claimed here as SPACEMOBILE-007.** Worth confirming against CelesTrak
before adding either to the group.

##### What this implies for the app (not yet done)

1. The `ast-spacemobile` group is sourced from CelesTrak by `INTDES` query — adding
   `INTDES=2026-179` (and `2025-309`) is the natural extension, subject to checking what
   CelesTrak lists these under.
2. **Alpha-5**: `line1`/`line2` render 100240 as `A0240`. Any code that parses the catalog
   number out of a TLE line needs the Alpha-5 mapping, or it will read `A0240` as garbage.
   The `satNo` column is plain `100240`, so the pipeline is only exposed where it reads the
   line.
3. The trio has **no chain gaps at all**, so unlike their older siblings they should render
   continuously from 2026-08-05 onward under the existing selection rule.

#### Tasking 4 — decisions taken (2026-07-30)

| Question                                  | Decision                                                                                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Which satellites use Databricks TLEs?     | **Any group Databricks covers**, not just AST SpaceMobile                                                                                 |
| No element set valid at the sim time?     | **Hide the satellite** — whether that is "not launched yet" or a gap in the chain (superseded the earlier "hide only before first epoch") |
| Satellite absent from the table entirely? | **Keep its CelesTrak element set** and stay visible — the table cannot speak to it at all                                                 |
| Latency                                   | **Prefetch a window** around the sim time, pick per-time locally                                                                          |

**Selection rule — as specified (corrected 2026-07-30):**

```
__START_AT <= t  AND  (__END_AT IS NULL OR t < __END_AT)
```

The interval is half-open. The tasking writes `__START_AT < t`; taking the **start
inclusively** is what keeps an instant landing exactly on an epoch resolvable at all, and
what makes each instant belong to exactly one row. A satellite with no matching row is not
displayed.

An earlier revision of this page omitted the `__END_AT IS NULL` arm, and this implementation
had used _greatest `__START_AT` ≤ t_ instead. That is now replaced by the rule above.

##### ⚠️ What this rule costs — measured, not estimated

The chain is **not continuous**, and that is not a rounding detail:

| Measure                                                     | Value                         |
| ----------------------------------------------------------- | ----------------------------- |
| Rows followed by a **gap** (`__END_AT` < next `__START_AT`) | **763 / 2,679 sampled (28%)** |
| Rows that **overlap**                                       | **0**                         |
| Longest single gap                                          | **~19.8 days**                |
| Share of each AST satellite's history **inside a gap**      | **41–46%**                    |
| Satellites in the view with **no open row at all**          | **1,824 / 6,451 (28.3%)**     |
| …of those, active within the last 30 days (so not decayed)  | **1,698**                     |

Consequences now live in the app:

- **SPACEMOBILE-003 (61045) is invisible at present time.** Its newest row starts
  2026-07-28T18:03 and was _closed_ at 2026-07-29T00:21:45 — but the successor that closing
  implies was never written. There is no row for it after 2026-07-29T00:00, and the view has
  **zero** rows with null TLE lines anywhere, so nothing is being filtered out. It is a
  dangling close upstream. 28.3% of the catalog is in the same state.
- **Satellites blink in and out as the clock moves.** Verified in-browser: at 2026-07-09
  00:00 SPACEMOBILE-001 and -002 vanish (inside their gaps); at 18:00 the same day -001 is
  back and -004 has gone.

Neither is a bug in this implementation — both are the specified rule meeting the data. If
they are unwanted, the one-line change is to fall back to the greatest `__START_AT` ≤ t when
no interval matches, which is immune to gaps and dangling closes.

##### ✅ Worker half — done

`GET /api/elset/window?satnos=<ids>&from=<iso>&to=<iso>` →
`{ entries: [{ satNo, firstEpoch, elsets[] }], uncovered: [satNo] }`

- `fetchElsetWindow()` in `worker/src/databricks/elset.ts`, route in `src/gp/api.ts`.
- Returns every element set whose **validity interval overlaps** the window — which is
  exactly the set that can answer any instant in it. A row starting before the window but
  still in force overlaps, so it is included by the same condition.
- `LEFT JOIN` from a `firsts` CTE, so a satellite whose history starts after the window
  still returns, carrying `firstEpoch` and no rows: that is the "not launched yet" case,
  and it is distinguishable from `uncovered` (no rows in the table at all).
- Guards, because the route is unauthenticated and the warehouse is metered: ≤200
  satellites, ≤90-day span, and **edge-cached** on normalized parameters for 15 min.

Live-verified: the probe at present time reports `missing`
`[53807, 61045, 69589, 69590, 69591]` — 61045 for the dangling close above, the other four
for having no rows at all. Window fetch **17.4 s cold → 10 ms cached**, and a reordered id
list hits the same cache entry.

Worker suite: 96 passed, lint clean.

##### ✅ Frontend half — done

| File                                 | Role                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `src/modules/util/elsetWindow.ts`    | Fetch/parse a window; `resolveElset()` → `elset` / `before-first` / `no-valid-entry` / `unknown` |
| `src/modules/elsetSync.ts`           | Orchestration: clock → window → overrides + hidden set                                           |
| `src/modules/SatelliteCatalog.ts`    | `CatalogEntry` gains `baseRecord` + a record override; `applyRecordOverrides()`                  |
| `src/modules/satelliteActivation.ts` | `hiddenSatnums` — checked _before_ the enable rules                                              |
| `src/modules/SatelliteManager.ts`    | `applyElsetOverrides()`, `enabledSatnums()`                                                      |
| `src/modules/sceneSync.ts`           | Resync on clock change, activation change, and catalog load                                      |

`before-first` (not launched yet) and `no-valid-entry` (in a gap) are kept as **separate
resolutions** even though both hide the satellite, so the gap case stays visible rather
than being silently folded into "not launched". The gap case is logged.

Design points worth keeping:

- **The override sits beside the base record, never replacing it** (`baseRecord` +
  `#override`). Returning to live time is dropping the override, not refetching a group.
- **Metadata falls back to the base record.** An override is a bare element set —
  Databricks knows a TLE, not a swath — so a swap must not cost a satellite its swath
  extents or cone FOV.
- **A rebuild, not a mutation.** `Orbit` (and the pass predictor and sampled trajectory
  built on it) is constructed from the record, so a changed element set disposes and
  recreates the `SatelliteComponentCollection`. Tracking is carried across the rebuild.
- **Hidden beats every enable rule**, including tracking: with no element set valid at that
  instant there is nothing to propagate.
- **Bucketed window bounds** (6 h buckets, 7-day window) so scrubbing mostly resolves
  locally, and when it does refetch it lands on the worker's existing edge-cache entry.
- **Live time is left alone** — CelesTrak is hours old at most, so an override there would
  be the same answer bought with a warehouse query.
- Past the 200-satellite cap the override is **skipped entirely** rather than applied to an
  arbitrary subset, which would mix two epochs of data in one view.

Verified in-browser against the live warehouse, AST SpaceMobile enabled:

| Simulation time  | Missing from the globe     | Why                                      |
| ---------------- | -------------------------- | ---------------------------------------- |
| 2026-07-30 12:00 | SPACEMOBILE-**003**        | dangling close — no open row             |
| 2026-07-09 00:00 | SPACEMOBILE-**001**, -002  | inside their chain gaps                  |
| 2026-07-09 18:00 | SPACEMOBILE-**004**        | -001 back; -004 now in its own gap       |
| 2025-01-10       | the whole SPACEMOBILE five | before their first epoch (~2025-04)      |
| live             | none                       | overrides dropped, back to CelesTrak OMM |

Frontend suite: 294 passed. Lint and type-check clean.

##### Launch dates come from the table, not from config

`resolveElset` reports **`before-launch`** using the view's satcat **`LAUNCH`**
column (`max(LAUNCH)` per satellite in the window query) — authoritative, and never
transcribed into YAML or code. Live values: `2024-09-12` for all five covered AST
satellites, matching this page exactly.

This matters because `LAUNCH` and `firstEpoch` are genuinely different facts: the five
launched **2024-09-12** but the table's history for them starts **2025-04**. So the
resolutions are kept apart —

| Resolution       | Meaning                                             | Drawn?  |
| ---------------- | --------------------------------------------------- | ------- |
| `before-launch`  | before satcat `LAUNCH` — not in orbit yet           | no      |
| `before-first`   | in orbit, but the table's history starts later      | no      |
| `no-valid-entry` | in orbit and covered, but the instant is in a gap   | no      |
| `unknown`        | not in the table at all — keeps its CelesTrak elset | **yes** |

##### ✅ Fixed: the 4 uncovered satellites no longer show before they launched

Sourcing launch dates from the table fixes nothing for **53807, 69589, 69590, 69591**,
because the table has **no rows at all** for them — so no `LAUNCH` either. Verified twice
over: `elset_scd2_with_satcat` returns 0 rows, and `satcat_clean` in the same schema also
returns 0 rows for all four. Databricks simply does not know these satellites.

They therefore resolve to `unknown`, keep their CelesTrak element set, and render at
**any** simulation time. At 2026-05-09 the globe draws SPACEMOBILE-008/009/010, five weeks
before their 2026-06-17 launch. A CelesTrak OMM record carries no launch date — only a
current epoch, which propagates backwards indefinitely.

**A real source does exist** (checked, not assumed): CelesTrak's SATCAT covers all four —

| NORAD | `LAUNCH_DATE` (CelesTrak SATCAT) |
| ----- | -------------------------------- |
| 53807 | 2022-09-11                       |
| 69589 | 2026-06-17                       |
| 69590 | 2026-06-17                       |
| 69591 | 2026-06-17                       |

**Implemented 2026-07-30.** A group may now declare `satcatSources` beside `sources`;
they take the same query parameters, are fetched by the same rate-limited pass, and are
read **only** for `LAUNCH_DATE`. `buildLaunchDates` turns them into a satnum→date table,
`enrichRecords` attaches `metadata.launchDate`, and `elsetSync.launchHiddenSatnums` hides
on it — on every path, including when Databricks is unconfigured or over the cap, because
a launch date is knowable without an element set. No hand-entered dates anywhere.

Live-verified at the reported time, **2026-05-09 09:16 UTC**: SPACEMOBILE-008/009/010 are
gone. Visible: BLUEWALKER 3, SPACEMOBILE-001/002/003/005 (-004 is in a chain gap). All
nine records now carry a `launchDate` from SATCAT.

Note SATCAT gives BLUEWALKER 3 as **2022-09-11**, one day later than this page's
2022-09-10. The fetched value is used, since it is the source of record.

---

#### Tasking 2 — Simulation start-time control ✅

A seventh button in the left toolbar (`lucide:calendar-clock`) opening a
**Simulation time** panel: a UTC `datetime-local` field, **Set start time**, and
**Resume live**. `src/components/Satvis.vue`, styles in `src/css/main.css`.

Almost no new machinery was needed — the app already models "live vs pinned time"
(`CONTEXT.md`). The panel just writes `cesiumStore.setTime(iso)`, and the existing
`sceneSync` watcher moves the Cesium clock and rewrites the `time` url parameter.

Verified in-browser: setting `2026-03-15T06:30` moved the clock to
`Mar 15 2026 06:30 UTC`, rescaled the timeline, and produced
`?time=2026-03-15T06:30Z`.

Two details worth knowing:

- The field is **UTC**, matching every other time in the app and the url parameter.
  `datetime-local` carries no zone of its own, so the trailing `Z` is added on write
  and stripped on read.
- **Resume live** moves the clock first and clears the pin second. The other order
  leaves the clock parked where it was, merely unpinned.

#### Tasking 3 — AST SpaceMobile group ✅

Group `ast-spacemobile` in `worker/src/config/satvis.core.yaml`, surfaced as the tag
**AST SpaceMobile** in `src/config/presets.ts`. (Group names must be url-safe; tags
only bar commas — which is why the group is hyphenated and the tag is not.)

Sourced from **CelesTrak, not Databricks** — Databricks has only 5 of the 9 (see the
coverage gap below), while CelesTrak has all 9. Three small queries rather than the
whole `active` catalog: `CATNR=53807`, `INTDES=2024-163`, `INTDES=2026-139`. The
`satellites` rows exclude the five debris objects sharing the 2024-163 launch.

Live refresh: 9 records, **zero warnings** — every `noradId`↔`upstreamName` pair
matched, which is what confirms the names below are current.

**Naming**: upstream now calls the 2026-139 trio `SPACEMOBILE-008/009/010`, having
settled what this page listed as the provisional "BLUEBIRD 8/9/10". They keep the
upstream names, consistent with their five siblings. `BLUEWALKER-3` is renamed to
`BLUEWALKER 3` to match this page. Say the word if you'd rather see BLUEBIRD.

#### Blank globe (the original report) ✅ fixed

`data/cesium-assets` and `data/models` are **uninitialised submodules** — `git
submodule status` shows both with a `-` prefix and the directories are empty.

The app already has a fallback for exactly this (`offlineFallback` in
`src/modules/CesiumLayerProviders.ts`), which swaps `OfflineHighres` for the bundled
`Offline` layer. It was not firing: it probed `tilemapresource.xml` and accepted any
**HTTP 200** — but the Vite dev server answers a missing path with the SPA
`index.html`, also a 200. So the probe concluded the imagery was present, no swap
happened, and Cesium parsed that HTML as XML and threw
`RuntimeError: Invalid XMLHttpRequest response type` with the globe already black.

Fixed by recognising the manifest by content (`<TileMap`) rather than by status.
The globe now renders via the `Offline` layer. **To get the high-resolution imagery
back, run `git submodule update --init`** — that is the real fix; this only makes the
degraded path work as designed.

---

#### Tasking 1 — Databricks connection in the worker ✅

Live-verified: the Worker resolves real element sets out of Unity Catalog through
`GET /api/databricks/probe`. Cold warehouse ~16 s, warm ~7 s.

New code, all in `worker/`:

| File                       | Role                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `src/databricks/client.ts` | SQL Statement Execution REST client — submit, poll, walk result chunks, cancel on deadline |
| `src/databricks/config.ts` | Resolve the connection from env; validate the table identifier                             |
| `src/databricks/elset.ts`  | Time-appropriate element-set lookup + projection to the pipeline's `TleRecord`             |
| `src/gp/api.ts`            | New route `GET /api/databricks/probe`                                                      |
| `test/databricks.test.ts`  | 20 tests, fetch stubbed — no network, no credentials needed                                |

Config lives in `wrangler.jsonc` vars + a `DATABRICKS_TOKEN` secret; locally in
`worker/.dev.vars` (see `.dev.vars.example`). All blank → integration off, CelesTrak
path untouched. Partially set → hard error. Full table in `AGENTS.md`
("Databricks configuration").

Worker suite: 88 passed. `pnpm --filter satvis-worker lint` clean.

**`@databricks/sql` was removed** from `worker/package.json`. That driver speaks Thrift
over Node sockets (`node:http`/`node:net`/`node:zlib`) and cannot run on workerd. The
Statement Execution REST API is plain HTTPS+JSON, so it works unchanged in the Worker,
in `wrangler dev` and in tests.

#### Discoveries about the table

Workspace: `ase-databricks-sandbox2` (`dbc-42ae1585-962e`) — the only one of the three
`~/.databrickscfg` profiles whose token is still valid (`sandbox1` and `kl2tech` both
return "Invalid access token"). Warehouse used: `0a18af80804df935` (Serverless Starter,
X-Small).

It is a **VIEW**. 5,209,422 rows, 6,450 distinct `satNo`, 6,458 open rows,
`__START_AT` spanning 2024-01-08 → 2026-07-29 (current as of today). Carries ready-made
69-char `line1`/`line2` TLE strings, so records can flow straight into the pipeline's
existing `TleRecord` shape — no OMM→TLE conversion needed.

Two findings that decide how a TLE must be selected:

1. **`__START_AT` IS the TLE epoch.** Parsed the epoch out of `line1` for 1,145 rows and
   compared: max difference **0 seconds**. So "latest row at or before _t_" is also
   "nearest preceding epoch".
2. **The SCD2 chain has holes.** Measured by direction (the first pass only counted
   inequality): **763 of 2,679 sampled rows are followed by a gap, 0 overlap.** Longest gap
   ~19.8 days. **1,824 of 6,451 satellites (28.3%) have no open row at all**, 1,698 of them
   active within the last 30 days — dangling closes, not decays. 61045 is one: its newest
   row was closed at 2026-07-29T00:21:45 and the successor was never written.

#### Superseded design note (kept for the record)

Before tasking 4 was corrected, this implementation used **greatest `__START_AT` ≤ _t_**
instead of the validity match, on the grounds that the chain's gaps would otherwise hide
satellites. That reasoning was right about the gaps but is no longer the chosen behaviour:
the specified rule is now the SCD2 validity match, and the measured cost of it is set out
under "What this rule costs" above.

The alternative remains a one-line fallback if the blinking turns out to be unwanted:
when no interval matches, take the greatest `__START_AT` ≤ _t_.

One thing the old rule got wrong either way, now moot: it left a **decayed** satellite
resolving to its last-ever TLE forever. The validity match ends a decayed satellite
naturally, at its final `__END_AT`.

#### ⚠️ Coverage gap for the AST SpaceMobile set (blocks tasking 3)

Only **5 of the 9** requested satellites exist in this view:

| NORAD | Name            | In table?     | History starts |
| ----- | --------------- | ------------- | -------------- |
| 53807 | BLUEWALKER 3    | ❌ **0 rows** | —              |
| 61045 | SPACEMOBILE-003 | ✅ 483 rows   | 2025-04        |
| 61046 | SPACEMOBILE-005 | ✅ 581 rows   | 2025-04        |
| 61047 | SPACEMOBILE-001 | ✅ 553 rows   | 2025-04-11     |
| 61048 | SPACEMOBILE-002 | ✅ 592 rows   | 2025-04-12     |
| 61049 | SPACEMOBILE-004 | ✅ 470 rows   | 2025-04        |
| 69589 | BLUEBIRD 8      | ❌ **0 rows** | —              |
| 69590 | BLUEBIRD 9      | ❌ **0 rows** | —              |
| 69591 | BLUEBIRD 10     | ❌ **0 rows** | —              |

Also note history for the SPACEMOBILE five begins **~2025-04**, not at their 2024-09-12
launch — so "as of" queries before April 2025 correctly return nothing for them.

The four missing satellites need a decision: fall back to CelesTrak for them, source them
from another table, or ship the group with five. All five present satellites carry
`source = "18th SPCS"`, `dataMode = "REAL"`.

#### Verify tasking 1 yourself

```sh
mkdir -p dist                       # wrangler dev needs the assets dir to exist
cd worker && npx wrangler dev --port 8080
curl -s "http://localhost:8080/api/databricks/probe" | python3 -m json.tool
curl -s "http://localhost:8080/api/databricks/probe?satnos=61047&at=2026-01-15T12:00:00Z"
```
