// Fetch-handler routing for the GP data API.

import { resolveDatabricks, type DatabricksSettings } from "../databricks/config.ts";
import { fetchElsets, fetchElsetWindow } from "../databricks/elset.ts";
import { coerceIndex } from "./evaluate.ts";
import { refreshAll } from "./refresh.ts";
import { GP_INDEX_KEY, GP_KEY_PREFIX, type GroupWriteMetadata } from "./store.ts";

const GROUP_NAME_RE = /^[a-zA-Z0-9_-]+$/;
// Cooldown for POST /api/refresh: within this window of the last refresh (manual
// OR cron) the endpoint will not re-hit CelesTrak. Long enough to keep a public,
// unauthenticated trigger from hammering a rate-limited upstream, short enough
// for iterative debugging.
const REFRESH_COOLDOWN_MS = 60_000;

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
}

function notFound(): Response {
  return jsonResponse({ error: "Not Found" }, { status: 404 });
}

// GET /api/gp/<group>.json — serve a group's records from KV with caching
// headers and conditional-request (If-None-Match -> 304) support.
async function handleGroup(name: string, request: Request, env: Env): Promise<Response> {
  if (!GROUP_NAME_RE.test(name)) {
    return notFound();
  }
  const { value, metadata } = await env.GP_KV.getWithMetadata<GroupWriteMetadata>(GP_KEY_PREFIX + name, {
    type: "text",
    cacheTtl: 300,
  });
  if (value === null) {
    return notFound();
  }

  const updated = metadata?.updated;
  const updatedMs = updated ? Date.parse(updated) : Date.now();
  const etag = `W/"${name}-${updatedMs}"`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=300",
    ETag: etag,
    "Last-Modified": new Date(updatedMs).toUTCString(),
  };

  if (request.headers.get("If-None-Match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(value, { headers });
}

async function handleIndex(env: Env): Promise<Response> {
  const index = await env.GP_KV.get(GP_INDEX_KEY, "text");
  if (index === null) {
    return jsonResponse({ updated: "", groups: [] });
  }
  return new Response(index, {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
  });
}

// POST /api/refresh — run the same refresh as the cron (fetch every source,
// evaluate, write KV) and return a per-source diagnostic report. Public but
// rate-limited: within REFRESH_COOLDOWN_MS of the last refresh it does NOT
// re-fetch, instead returning the cached index (errors included) with 429 so a
// caller keeps visibility without spending CelesTrak's per-GROUP download budget
// (which would otherwise 403 the next scheduled run). Whatever it does fetch is
// persisted, so — unlike a read-only probe — it never wastes a download. Its
// diagnostics matter most run against the deployed Worker, where failures like
// Cloudflare 522s reproduce (they never do from a laptop).
async function handleRefresh(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method Not Allowed" }, { status: 405, headers: { Allow: "POST" } });
  }

  const previous = coerceIndex(await env.GP_KV.get(GP_INDEX_KEY, "json"));
  const sinceMs = Date.now() - Date.parse(previous.updated);
  if (Number.isFinite(sinceMs) && sinceMs < REFRESH_COOLDOWN_MS) {
    const retryAfterMs = REFRESH_COOLDOWN_MS - sinceMs;
    return jsonResponse(
      { refreshed: false, reason: "cooldown", updatedAt: previous.updated, retryAfterMs, groups: previous.groups },
      { status: 429, headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)), "Cache-Control": "no-store" } },
    );
  }

  const report = await refreshAll(env);
  return jsonResponse(
    {
      refreshed: true,
      updatedAt: report.index.updated,
      durationMs: report.durationMs,
      written: report.written,
      skipped: report.skipped,
      sources: report.sources,
      groups: report.index.groups,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

// Satellites the probe resolves when the caller names none. A convenience
// default for the AST SpaceMobile working set — NOT configuration: nothing else
// reads it, and a real group belongs in satvis.core.yaml.
const PROBE_DEFAULT_SATNOS = [53807, 61045, 61046, 61047, 61048, 61049, 67232, 69589, 69590, 69591, 100240, 100241, 100242];
// Bound on how many satellites one probe call may resolve, so the endpoint
// cannot be turned into a bulk extractor against a metered warehouse.
const PROBE_MAX_SATNOS = 50;

// GET /api/databricks/probe — resolve the time-appropriate element set for a
// few satellites and report what came back. This is the connectivity check for
// the Databricks integration: it exercises auth, the warehouse, the view, and
// the selection rule in one call.
//
// Disabled unless DATABRICKS_PROBE is "1". It is unauthenticated and every call
// spins a metered SQL warehouse, so it stays off in production and is enabled
// in worker/.dev.vars for local work.
async function handleDatabricksProbe(request: Request, env: Env): Promise<Response> {
  if (env.DATABRICKS_PROBE !== "1") {
    return notFound();
  }

  let settings: ReturnType<typeof resolveDatabricks>;
  try {
    settings = resolveDatabricks(env);
  } catch (err) {
    return jsonResponse({ configured: false, error: err instanceof Error ? err.message : String(err) }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
  if (settings === null) {
    return jsonResponse(
      { configured: false, error: "Databricks is not configured — set DATABRICKS_HOST, DATABRICKS_WAREHOUSE_ID and DATABRICKS_TOKEN" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const url = new URL(request.url);
  const satnosParam = url.searchParams.get("satnos");
  const satNos = satnosParam
    ? satnosParam
        .split(",")
        .map((part) => Number(part.trim()))
        .filter((n) => Number.isInteger(n) && n > 0)
    : PROBE_DEFAULT_SATNOS;
  if (satNos.length === 0) {
    return jsonResponse({ error: "satnos must be a comma-separated list of positive integers" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  if (satNos.length > PROBE_MAX_SATNOS) {
    return jsonResponse({ error: `satnos accepts at most ${PROBE_MAX_SATNOS} ids` }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  const atParam = url.searchParams.get("at");
  const asOf = atParam ? new Date(atParam) : new Date();
  if (Number.isNaN(asOf.getTime())) {
    return jsonResponse({ error: `at is not a valid date: ${JSON.stringify(atParam)}` }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  const started = Date.now();
  try {
    const rows = await fetchElsets(settings, settings.elsetTable, settings.satcatTable, { satNos, asOf });
    const found = new Set(rows.map((row) => row.satNo));
    return jsonResponse(
      {
        configured: true,
        // Host and warehouse identify the connection; the token never appears.
        host: settings.host,
        warehouseId: settings.warehouseId,
        table: settings.elsetTable,
        asOf: asOf.toISOString(),
        ms: Date.now() - started,
        requested: satNos.length,
        // Satellites the view has no element set for at or before asOf.
        missing: satNos.filter((satNo) => !found.has(satNo)),
        elsets: rows.map((row) => ({
          satNo: row.satNo,
          objectName: row.objectName,
          objectId: row.objectId,
          epoch: row.epoch,
          // How stale the chosen element set is relative to the requested time —
          // the number that says whether this TLE is fit to propagate.
          epochAgeHours: Math.round(((asOf.getTime() - Date.parse(row.epoch)) / 3_600_000) * 10) / 10,
          supersededAt: row.supersededAt,
          source: row.source,
          dataMode: row.dataMode,
          line1: row.line1,
          line2: row.line2,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.warn(`databricks probe failed after ${Date.now() - started}ms: ${err instanceof Error ? err.message : String(err)}`);
    return jsonResponse(
      {
        configured: true,
        host: settings.host,
        warehouseId: settings.warehouseId,
        table: settings.elsetTable,
        ms: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}

// Bounds on GET /api/elset/window. Unlike the probe this route is meant to be
// live in production, so the caps are what keep an unauthenticated endpoint
// from becoming a bulk extractor — or a bill — against a metered warehouse.
const WINDOW_MAX_SATNOS = 200;
const WINDOW_MAX_SPAN_MS = 90 * 24 * 3_600_000;
// Answers are immutable for a given (satnos, from, to): the view only ever
// gains rows *after* the newest epoch, and the frontend buckets its window
// bounds, so repeated scrubbing lands on the same key. Cached at the edge so a
// second viewer of the same window never reaches Databricks at all.
const WINDOW_CACHE_SECONDS = 900;

function parseSatnos(raw: string | null): number[] | null {
  if (raw === null || raw.trim() === "") {
    return null;
  }
  const parsed = raw.split(",").map((part) => Number(part.trim()));
  if (parsed.some((n) => !Number.isInteger(n) || n <= 0)) {
    return null;
  }
  return [...new Set(parsed)];
}

// GET /api/elset/window?satnos=<ids>&from=<iso>&to=<iso>
//
// Every element set needed to resolve any instant in [from, to], plus each
// satellite's first-ever epoch. One round trip per window, so the frontend can
// scrub time inside it without touching the network — and can tell "not yet
// launched" (time before firstEpoch) apart from "not in this table" (listed in
// `uncovered`, and left on its CelesTrak element set).
async function handleElsetWindow(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let settings: DatabricksSettings | null;
  try {
    settings = resolveDatabricks(env);
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
  if (settings === null) {
    // Not an error: a deployment without Databricks serves CelesTrak data and
    // the frontend simply never overrides an element set.
    return jsonResponse({ configured: false, entries: [], uncovered: [] }, { headers: { "Cache-Control": "public, max-age=300" } });
  }

  const url = new URL(request.url);
  const satNos = parseSatnos(url.searchParams.get("satnos"));
  if (satNos === null) {
    return jsonResponse({ error: "satnos must be a comma-separated list of positive integers" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  if (satNos.length > WINDOW_MAX_SATNOS) {
    return jsonResponse({ error: `satnos accepts at most ${WINDOW_MAX_SATNOS} ids (got ${satNos.length})` }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  const from = new Date(url.searchParams.get("from") ?? "");
  const to = new Date(url.searchParams.get("to") ?? "");
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return jsonResponse({ error: "from and to must be ISO-8601 timestamps" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const spanMs = to.getTime() - from.getTime();
  if (spanMs <= 0) {
    return jsonResponse({ error: "to must be after from" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  if (spanMs > WINDOW_MAX_SPAN_MS) {
    return jsonResponse({ error: `window may span at most ${WINDOW_MAX_SPAN_MS / (24 * 3_600_000)} days` }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  // Cache on the normalized parameters rather than the raw url, so the same
  // window asked for with the ids in a different order is one cache entry.
  const cacheUrl = new URL(url.origin + url.pathname);
  cacheUrl.searchParams.set("satnos", [...satNos].toSorted((a, b) => a - b).join(","));
  cacheUrl.searchParams.set("from", from.toISOString());
  cacheUrl.searchParams.set("to", to.toISOString());
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
  // workerd's CacheStorage has `default` (it is the edge cache), but the DOM
  // lib's CacheStorage — which also reaches this compilation — does not. The
  // cast covers that typing gap rather than an assumption about the runtime.
  const cache = (caches as unknown as { default: Cache }).default;

  const hit = await cache.match(cacheKey);
  if (hit) {
    return hit;
  }

  const started = Date.now();
  try {
    const result = await fetchElsetWindow(settings, settings.elsetTable, settings.satcatTable, { satNos, from, to });
    const response = jsonResponse(
      {
        configured: true,
        from: from.toISOString(),
        to: to.toISOString(),
        ms: Date.now() - started,
        entries: result.entries,
        uncovered: result.uncovered,
      },
      { headers: { "Cache-Control": `public, max-age=${WINDOW_CACHE_SECONDS}` } },
    );
    // Populate the cache without holding the response back; the body must be
    // cloned because the caller consumes the original.
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (err) {
    console.warn(`elset window failed after ${Date.now() - started}ms: ${err instanceof Error ? err.message : String(err)}`);
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}

// Route any /api/* request. Returns null for non-api paths so the caller can
// fall through to static assets.
export async function handleApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith("/api/")) {
    return null;
  }

  const groupMatch = /^\/api\/gp\/([^/]+)\.json$/.exec(path);
  if (groupMatch) {
    // Malformed percent-encoding (e.g. /api/gp/%zz.json) throws URIError; treat
    // it as an unknown group rather than a 500 (handleGroup's name check rejects
    // anything exotic that does decode anyway).
    let name: string;
    try {
      name = decodeURIComponent(groupMatch[1]!);
    } catch {
      return notFound();
    }
    return handleGroup(name, request, env);
  }
  if (path === "/api/groups.json") {
    return handleIndex(env);
  }
  if (path === "/api/refresh") {
    return handleRefresh(request, env);
  }
  if (path === "/api/databricks/probe") {
    return handleDatabricksProbe(request, env);
  }
  if (path === "/api/elset/window") {
    return handleElsetWindow(request, env, ctx);
  }
  return notFound();
}
