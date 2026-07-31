#!/usr/bin/env node
// `pnpm doctor` — check that a local dev setup is actually working, and say
// which layer is broken when it is not.
//
// The checks are ordered so the first failure is the root cause: prerequisites,
// then the worker, then the data it serves, then the frontend, then the seam
// between them, then Databricks. Each failure carries the command that fixes it,
// because the failures here are all ones with a single known remedy.
//
// Every check is read-only. Nothing is started, filled or refreshed — a doctor
// that repaired things would hide the problem it is meant to name.

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const API = (process.env.SATVIS_API_URL ?? "http://localhost:8080").replace(/\/+$/, "");
const WEB = (process.env.SATVIS_WEB_URL ?? "http://localhost:5173").replace(/\/+$/, "");
const SKIP_DATABRICKS = process.argv.includes("--no-databricks");

// A cold serverless SQL warehouse takes ~20s to answer its first query, so the
// Databricks check gets its own budget; everything else is local and instant.
const HTTP_TIMEOUT_MS = 10_000;
const DATABRICKS_TIMEOUT_MS = 90_000;

const results = [];

function record(status, name, detail, fix) {
  results.push({ status, name, detail, fix });
  const mark = { pass: "[32m✔[0m", fail: "[31m✖[0m", warn: "[33m![0m", skip: "[90m-[0m" }[status];
  console.log(`  ${mark} ${name.padEnd(34)} ${detail}`);
  if (fix) {
    console.log(`      [90mfix:[0m ${fix}`);
  }
}

async function getJson(url, timeoutMs = HTTP_TIMEOUT_MS) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    // A worker-less or misrouted setup answers /api with the SPA's index.html
    // and a 200, which is the single most confusing failure mode here.
    throw new Error(`non-JSON response (starts with ${JSON.stringify(text.slice(0, 40))})`);
  }
}

function section(title) {
  console.log(`\n[1m${title}[0m`);
}

// --- prerequisites ---------------------------------------------------------

function checkPrerequisites() {
  section("Prerequisites");

  // Cesium imagery and the 3D models live in submodules. An empty checkout is
  // what makes the globe render black.
  const assets = path.join(repoRoot, "data", "cesium-assets");
  const populated = existsSync(assets) && readdirSync(assets).length > 0;
  record(
    populated ? "pass" : "warn",
    "submodules",
    populated ? "data/cesium-assets populated" : "data/cesium-assets is empty — globe falls back to low-res imagery",
    populated ? undefined : "git submodule update --init",
  );

  // wrangler's assets binding points at ../dist and refuses to start without it.
  const dist = path.join(repoRoot, "dist");
  const hasDist = existsSync(dist);
  record(hasDist ? "pass" : "fail", "dist/", hasDist ? "present" : "missing — wrangler dev will not start", hasDist ? undefined : "mkdir -p dist   (or: pnpm build)");

  // Not required, but its absence explains every Databricks check below.
  const devVars = path.join(repoRoot, "worker", ".dev.vars");
  const hasDevVars = existsSync(devVars);
  record(
    hasDevVars ? "pass" : "warn",
    "worker/.dev.vars",
    hasDevVars ? "present" : "absent — Databricks features stay off",
    hasDevVars ? undefined : "cp worker/.dev.vars.example worker/.dev.vars && edit",
  );
}

// --- backend ---------------------------------------------------------------

// Returns the worker's group index, or null when the worker is unreachable —
// every later check needs it, and there is no point diagnosing them separately.
async function checkBackend() {
  section(`Backend (${API})`);
  let index;
  try {
    index = await getJson(`${API}/api/groups.json`);
  } catch (error) {
    record("fail", "worker reachable", String(error.message), "pnpm dev:worker");
    return null;
  }
  record("pass", "worker reachable", "GET /api/groups.json → 200");

  // KV is empty on a fresh start, so the index exists but every group is empty
  // and the UI shows 0/0 everywhere.
  const groups = index.groups ?? [];
  const filled = groups.filter((group) => (group.count ?? 0) > 0);
  record(
    filled.length > 0 ? "pass" : "fail",
    "KV populated",
    filled.length > 0 ? `${filled.length}/${groups.length} groups have records (updated ${index.updated || "never"})` : "index is empty — no group has any records",
    filled.length > 0 ? undefined : `curl -X POST ${API}/api/refresh`,
  );

  // Serving a real group proves the whole read path, not just the index.
  const sample = filled[0];
  if (sample) {
    try {
      const records = await getJson(`${API}/api/gp/${encodeURIComponent(sample.name)}.json`);
      const count = Array.isArray(records) ? records.length : 0;
      record(count > 0 ? "pass" : "fail", "group serves records", `${sample.name}: ${count} records`, count > 0 ? undefined : `curl -X POST ${API}/api/refresh`);
    } catch (error) {
      record("fail", "group serves records", `${sample.name}: ${error.message}`, `curl -X POST ${API}/api/refresh`);
    }
  }

  const warned = groups.filter((group) => group.lastError);
  if (warned.length > 0) {
    record(
      "warn",
      "group refresh errors",
      warned
        .map((group) => `${group.name}: ${group.lastError}`)
        .join("; ")
        .slice(0, 120),
    );
  }
  return index;
}

// --- frontend + the seam between them --------------------------------------

async function checkFrontend(workerIndex) {
  section(`Frontend (${WEB})`);
  try {
    const response = await fetch(`${WEB}/`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    record("pass", "dev server reachable", "GET / → 200");
  } catch (error) {
    record("fail", "dev server reachable", String(error.message), "pnpm dev");
    return;
  }

  // The check that matters most, and the one nothing else reveals: `pnpm dev`
  // proxies /api to PRODUCTION by default, so the app can look perfectly
  // healthy while ignoring the worker being debugged. Compared by group list
  // rather than by any one group name, so this keeps working as config changes.
  let proxied;
  try {
    proxied = await getJson(`${WEB}/api/groups.json`);
  } catch (error) {
    record("fail", "/api proxy works", String(error.message), "check the `proxy` block in vite.config.ts");
    return;
  }

  if (workerIndex === null) {
    record("warn", "/api proxy target", "cannot compare — the local worker is down");
    return;
  }
  const names = (index) =>
    (index.groups ?? [])
      .map((group) => group.name)
      .toSorted()
      .join(",");
  const sameAsLocal = names(proxied) === names(workerIndex);
  record(
    sameAsLocal ? "pass" : "fail",
    "/api proxy target",
    sameAsLocal
      ? "matches the local worker"
      : `does NOT match the local worker (${(proxied.groups ?? []).length} groups vs ${(workerIndex.groups ?? []).length}) — almost certainly pointing at production`,
    sameAsLocal ? undefined : `SATVIS_API_PROXY=${API} pnpm dev`,
  );
}

// --- databricks ------------------------------------------------------------

async function checkDatabricks() {
  section("Databricks (optional)");
  if (SKIP_DATABRICKS) {
    record("skip", "probe", "skipped (--no-databricks)");
    return;
  }
  console.log("  [90m… a cold SQL warehouse can take ~20s to answer[0m");

  let payload;
  try {
    payload = await getJson(`${API}/api/databricks/probe?satnos=25544`, DATABRICKS_TIMEOUT_MS);
  } catch (error) {
    // 404 is the deliberate "probe disabled" answer, not a malfunction.
    if (String(error.message).includes("404")) {
      record("skip", "probe", 'disabled (DATABRICKS_PROBE is not "1")', "set DATABRICKS_PROBE=1 in worker/.dev.vars");
      return;
    }
    record("fail", "probe", String(error.message), "check DATABRICKS_* in worker/.dev.vars");
    return;
  }

  if (payload.configured === false) {
    record("skip", "probe", "Databricks is not configured", "fill DATABRICKS_* in worker/.dev.vars");
    return;
  }
  if (payload.error) {
    record("fail", "probe", String(payload.error).slice(0, 120), "check the token and warehouse id in worker/.dev.vars");
    return;
  }
  record("pass", "probe", `answered in ${payload.ms}ms via ${payload.warehouseId}`);
}

// --- run -------------------------------------------------------------------

console.log("[1msatvis doctor[0m");
console.log(`  api  ${API}`);
console.log(`  web  ${WEB}`);

checkPrerequisites();
const workerIndex = await checkBackend();
await checkFrontend(workerIndex);
await checkDatabricks();

const counted = (status) => results.filter((result) => result.status === status).length;
const failed = counted("fail");
console.log(`\n${failed > 0 ? "[31m" : "[32m"}${failed} failed[0m, ${counted("pass")} passed, ${counted("warn")} warnings, ${counted("skip")} skipped`);

// Non-zero on a hard failure only: warnings describe a setup that still runs.
process.exit(failed > 0 ? 1 : 0);
