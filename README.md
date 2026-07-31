# [satvis.space](https://satvis.space) ![Node CI](https://github.com/Flowm/satvis/workflows/Node%20CI/badge.svg)

Satellite orbit visualization and pass prediction.

> [!NOTE]
> The `next` branch contains many improvements from a bigger refactoring and is the recommended branch currently.
> This version is currently deployed to [satvis.space](https://satvis.space).
> Planning to merge this back to the ~~master~~ main in the next few months.

![Screenshot](https://user-images.githubusercontent.com/1117666/47623704-f0c3e900-db14-11e8-9cf9-7bf13acb267c.png)

## Features

- Calculate position and orbit of satellites from CelesTrak GP element sets (OMM/TLE)
- Set groundstation through geolocation or pick on map
- Calculate passes for a set groundstation
- Local browser notifications for passes
- Serverless architecture
- Works offline as Progressive Web App (PWA)

## Built With

- [CesiumJS](https://cesiumjs.org)
- [Satellite.js](https://github.com/shashwatak/satellite-js)
- [Vue.js](https://vuejs.org)
- [Nuxt UI](https://ui.nuxt.com)
- [Cloudflare Workers](https://workers.cloudflare.com)
- [Workbox](https://developers.google.com/web/tools/workbox)

## Development

### Setup

Initialize submodules and install build dependencies:

```
git submodule update --init
mise trust && mise install   # toolchain (Node 24, pnpm 11, prek; see mise.toml)
mise setup                   # install the pre-commit hooks
pnpm install
```

A single `pnpm install` at the repository root installs dependencies for both
the SPA and the `worker/` package.

### Run

The app is two processes: the **frontend** (Vite, `:5173`) and the **backend**
(the Cloudflare Worker via Wrangler, `:8080`). The frontend never imports the
worker — it calls it over HTTP through a Vite proxy.

**Frontend only** — the quickest start. `/api` is proxied to
<https://satvis.space>, so satellite data works with no local worker:

```
pnpm dev
```

- `pnpm dev:host` to expose the dev server on the local network
- `pnpm build` to build the application (output in `dist` folder)
- `pnpm preview` to preview the production build locally
- `pnpm update-gp` to refresh the static satellite-data snapshot (see below)

### Full-stack dev (with the worker)

Use this whenever you change anything under `worker/` — including group config
in `satvis.core.yaml`, whose groups do **not** exist on the deployed API.

```
mkdir -p dist                                       # wrangler's assets binding needs it to exist

pnpm dev:worker                                     # terminal 1 — wrangler dev on :8080
SATVIS_API_PROXY=http://localhost:8080 pnpm dev     # terminal 2 — frontend proxies /api → local worker
```

> [!IMPORTANT]
> Without `SATVIS_API_PROXY`, `pnpm dev` talks to **production**, not to the
> worker you just started. The app looks healthy while ignoring your changes;
> a group you added locally shows up as `0/0` in the satellite browser.

Workers KV starts **empty**, so `/api/gp/<group>.json` 404s until it is filled
once. Either trigger a refresh directly:

```
curl -X POST http://localhost:8080/api/refresh
```

or run the cron once (wrangler dev is started with `--test-scheduled`):

```
curl "http://localhost:8080/__scheduled?cron=23+*%2F3+*+*+*"
```

Then `GET /api/groups.json` lists the refreshed groups and
`GET /api/gp/starlink.json` returns an OMM element-set array.

The whole sequence, to copy:

```sh
mkdir -p dist                                       # once
pnpm dev:worker                                     # terminal 1 → :8080
SATVIS_API_PROXY=http://localhost:8080 pnpm dev     # terminal 2 → :5173
curl -X POST http://localhost:8080/api/refresh      # KV starts empty
pnpm doctor                                         # confirm every layer
```

### Stopping

Ctrl-C in each terminal. **Check nothing survived**, though — stopping Wrangler
does not always reap its `workerd` child, which leaves a process holding the
port, so the next `pnpm dev:worker` starts against a port that looks free and
misbehaves:

```sh
pgrep -fl "wrangler dev|workerd|vite"    # expect no output
```

Anything left over:

```sh
pkill -f "wrangler dev"; pkill -f workerd; pkill -f vite
```

### Checking the setup

```
pnpm doctor
```

Read-only; it starts and repairs nothing. It checks, in the order that makes the
first failure the root cause: submodules / `dist/` / `worker/.dev.vars`, the
worker and whether KV actually holds records, the frontend, **whether `/api` is
proxied to your local worker or to production**, and the Databricks connection.
Each failure prints the command that fixes it, and the exit code is non-zero if
any hard check failed (warnings describe a setup that still runs).

```
pnpm doctor --no-databricks     # skip the slow warehouse probe
SATVIS_API_URL=… SATVIS_WEB_URL=… pnpm doctor    # non-default ports
```

### Databricks (optional)

The worker can serve element sets from a Unity Catalog SCD2 table, so that
pinning the simulation clock propagates each satellite from the element set that
was current at that moment. It is **off unless configured**, and the CelesTrak
path is unaffected. Copy `worker/.dev.vars.example` to `worker/.dev.vars` and
fill it in; see the "Databricks configuration" section of `AGENTS.md` for what
each variable does and how element sets are selected by time.

## Satellite data

Element sets come from [CelesTrak](https://celestrak.org) as OMM JSON
(CelesTrak is phasing out TLE for new objects). The Cloudflare Worker in
`worker/` fetches and serves them:

- A cron trigger (every 3 h) refreshes each group into Workers KV; failed
  sources keep the last-known-good copy.
- `GET /api/gp/<group>.json` — one group's element sets (OMM array, with
  per-satellite metadata attached; see below).
- `GET /api/groups.json` — the group index (also the frontend's worker probe).

Configuration is **declarative** YAML, not shell scripts. Each config file
contributes two independent sections: `groups` (what is served, as which unit) and
`satellites` (static per-satellite facts, keyed by NORAD id).

- The core config lives in `worker/src/config/satvis.core.yaml` (CelesTrak
  pass-throughs, plus the satellite table).
- Plugins add `data/custom/<plugin>/satvis.yaml` with
  `sources` / `select` / `rename` / `include` / `extraRecordsFile`. Example
  (`data/custom/example/satvis.yaml`):

  ```yaml
  groups:
    - name: iss
      sources: [{ celestrak: stations }]
      satellites:
        - { noradId: 25544, upstreamName: ISS (ZARYA), name: ISS }
  ```

`pnpm --filter satvis-worker generate-groups` merges the core config with every
`data/custom/*/satvis.yaml` (inlining `extraRecordsFile` element sets) into the
gitignored `worker/src/config/satvis.generated.json` used by the worker.

### Worker-less deployments

For plain static hosting (or forks without a worker), run
`pnpm update-gp` before `pnpm build`. It runs the same refresh pipeline as the
cron — including metadata enrichment — and writes a static snapshot into
`data/gp/` (`<group>.json`, `index.json`; gitignored). At runtime the app probes
`/api/groups.json`; if that fails it falls back to the static `data/gp/`
snapshot, so all presets keep working without the worker.

### Satellite metadata

Static per-satellite facts — per-side swath extents, sensor cone FOV, model URL,
operator — live in the `satellites` table of `satvis.core.yaml` (and of any plugin
config), keyed by NORAD id. The refresh attaches each matching satellite's facts to
its served record under a lowercase `metadata` key, so metadata travels with the
element set instead of being matched against a separate rule list in the browser.
Satellites absent from the table carry no metadata and fall back to the defaults in
`src/config/satelliteMetadata.ts`.

Swath extents are **per-side** cross-track distances from the ground track,
relative to flight direction — not halves of a total width, because a tilted sensor
reaches further one way than the other. See
`docs/adr/0002-static-satellite-metadata.md`.

## iOS App

To provide pass notifications on iOS where local browser notifications are [not
supported](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API#Browser_compatibility)
a simple app wraps the webview and handles the scheduling of
[UserNotifications](https://developer.apple.com/documentation/usernotifications).

<p align="center"><a href="https://apps.apple.com/app/satvis/id1441084766"><img src="src/assets/app-store-badge.svg" width="250" /></a></p>

## License

This project is licensed under the MIT License - see `LICENSE` file for details.

## Acknowledgements

Inspired by a visualization developed for the [MOVE-II CubeSat project](https://www.move2space.de) by Jonathan, Marco and Flo.
