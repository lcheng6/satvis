import { createExecutionContext, createScheduledController, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import generatedConfig from "../src/config/satvis.generated.json" with { type: "json" };
import { collectSources } from "../src/gp/evaluate.ts";
import type { GroupsConfig, GroupsIndex, OmmRecord } from "../src/gp/types.ts";
import worker from "../src/index.ts";

// Number of distinct upstream requests one refresh makes (sources deduped
// across all generated groups). Asserted against the fetch spy after each
// refresh test so no upstream request goes missing or leaks between tests.
const SOURCE_COUNT = collectSources((generatedConfig as GroupsConfig).groups).length;

const UPDATED = "2026-07-04T00:00:00.000Z";
const UPDATED_MS = Date.parse(UPDATED);

function ommArray(...pairs: [string, number][]): OmmRecord[] {
  return pairs.map(([name, id]) => ({ OBJECT_NAME: name, NORAD_CAT_ID: id }));
}

async function seedGroup(name: string, records: OmmRecord[], updated = UPDATED): Promise<void> {
  await env.GP_KV.put(`gp:${name}`, JSON.stringify(records), { metadata: { updated, count: records.length } });
}

describe("GET /api/gp/<group>.json", () => {
  beforeEach(async () => {
    await seedGroup("weather", ommArray(["GOES 16", 41866], ["NOAA 20 (JPSS-1)", 43013]));
  });

  it("serves records with caching headers", async () => {
    const res = await SELF.fetch("https://satvis.space/api/gp/weather.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(res.headers.get("ETag")).toBe(`W/"weather-${UPDATED_MS}"`);
    expect(res.headers.get("Last-Modified")).toBe(new Date(UPDATED_MS).toUTCString());
    const body = (await res.json()) as OmmRecord[];
    expect(body.map((r) => r.OBJECT_NAME)).toEqual(["GOES 16", "NOAA 20 (JPSS-1)"]);
  });

  it("returns 304 for matching If-None-Match", async () => {
    const etag = `W/"weather-${UPDATED_MS}"`;
    const res = await SELF.fetch("https://satvis.space/api/gp/weather.json", { headers: { "If-None-Match": etag } });
    expect(res.status).toBe(304);
    expect(res.headers.get("ETag")).toBe(etag);
    expect(await res.text()).toBe("");
  });

  it("returns 200 (not 304) for a stale If-None-Match", async () => {
    const res = await SELF.fetch("https://satvis.space/api/gp/weather.json", { headers: { "If-None-Match": 'W/"weather-1"' } });
    expect(res.status).toBe(200);
  });

  it("404s an unknown group", async () => {
    const res = await SELF.fetch("https://satvis.space/api/gp/nonesuch.json");
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  it("404s an invalid group name", async () => {
    const res = await SELF.fetch("https://satvis.space/api/gp/..%2Fsecret.json");
    expect(res.status).toBe(404);
  });

  it("404s malformed percent-encoding (not 500)", async () => {
    const res = await SELF.fetch("https://satvis.space/api/gp/%zz.json");
    expect(res.status).toBe(404);
  });
});

describe("index route", () => {
  it("serves gp:index at /api/groups.json", async () => {
    const index: GroupsIndex = { updated: UPDATED, groups: [{ name: "weather", updated: UPDATED, count: 2 }] };
    await env.GP_KV.put("gp:index", JSON.stringify(index));
    const res = await SELF.fetch("https://satvis.space/api/groups.json");
    expect(res.status).toBe(200);
    const body = (await res.json()) as GroupsIndex;
    expect(body.groups[0]?.name).toBe("weather");
  });

  it("serves an empty index when none is stored", async () => {
    await env.GP_KV.delete("gp:index");
    const res = await SELF.fetch("https://satvis.space/api/groups.json");
    expect(res.status).toBe(200);
    const body = (await res.json()) as GroupsIndex;
    expect(body.groups).toEqual([]);
  });

  // Metadata is no longer shipped as a separate rule set for the browser to
  // match: records carry it, attached at refresh time.
  it("404s the retired /api/metadata.json", async () => {
    const res = await SELF.fetch("https://satvis.space/api/metadata.json");
    expect(res.status).toBe(404);
  });

  it("404s an unknown /api/* path", async () => {
    const res = await SELF.fetch("https://satvis.space/api/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });
});

describe("scheduled() refresh", () => {
  // The refresh reaches upstream through the global fetch (see refreshAll), so
  // stubbing globalThis.fetch intercepts it. The default stub rejects every
  // request (the old disableNetConnect); interceptCelestrak() swaps in the
  // celestrak reply and sets the number of upstream calls the test must make.
  let fetchSpy: MockInstance<typeof fetch>;
  let expectedFetches = 0;

  beforeEach(() => {
    expectedFetches = 0;
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      throw new Error(`unmocked fetch: ${new Request(input, init).url}`);
    });
  });
  // Assert the exact upstream request count, so a missing or extra fetch fails
  // the test that caused it instead of leaking into the next one.
  afterEach(() => {
    expect(fetchSpy).toHaveBeenCalledTimes(expectedFetches);
    vi.restoreAllMocks();
  });

  // Reply to every celestrak request (regular gp.php GROUP=<g> and supplemental
  // sup-gp.php FILE=<f>) — one per distinct source — with a synthetic response,
  // so the refresh never hits the network. Anything else stays rejected.
  function interceptCelestrak(reply: (group: string) => unknown, opts?: { status?: number }): void {
    expectedFetches = SOURCE_COUNT;
    fetchSpy.mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const isGp = url.pathname === "/NORAD/elements/gp.php" || url.pathname === "/NORAD/elements/supplemental/sup-gp.php";
      // Satcat sources ride the same fetch pass but are a different endpoint and
      // a different payload — read only for LAUNCH_DATE, never served.
      const isSatcat = url.pathname === "/satcat/records.php";
      if (request.method !== "GET" || url.origin !== "https://celestrak.org" || !(isGp || isSatcat)) {
        throw new Error(`unmocked fetch: ${request.method} ${request.url}`);
      }
      if (isSatcat) {
        return new Response(JSON.stringify([{ NORAD_CAT_ID: 53807, OBJECT_NAME: "BLUEWALKER-3", LAUNCH_DATE: "2022-09-11" }]), { status: opts?.status ?? 200 });
      }
      const source = url.searchParams.get("GROUP") ?? url.searchParams.get("FILE") ?? "";
      return new Response(JSON.stringify(reply(source)), { status: opts?.status ?? 200 });
    });
  }

  it("writes evaluated groups to KV and builds the index", async () => {
    interceptCelestrak((group) => [{ OBJECT_NAME: `${group.toUpperCase()}-1`, NORAD_CAT_ID: 10000 + group.length }]);

    const ctx = createExecutionContext();
    const controller = createScheduledController({ scheduledTime: Date.now(), cron: "23 */3 * * *" });
    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);

    const weather = await env.GP_KV.get("gp:weather", "json");
    expect(Array.isArray(weather)).toBe(true);

    const index = (await env.GP_KV.get("gp:index", "json")) as GroupsIndex;
    const weatherStatus = index.groups.find((g) => g.name === "weather");
    expect(weatherStatus?.count).toBeGreaterThan(0);
    expect(weatherStatus?.lastError).toBeUndefined();
    // The example `iss` plugin group documents ISS (ZARYA) as a satellites row
    // with noradId 25544; our synthetic STATIONS-1 record (id 10008) matches
    // neither the id nor the upstreamName, so the row raises a matched-no-record
    // warning that must surface in the index. This exercises the warning path
    // end-to-end through the real generated config.
    const issStatus = index.groups.find((g) => g.name === "iss");
    expect(issStatus).toBeDefined();
    expect(issStatus?.lastError).toBeUndefined();
    expect(issStatus?.warnings).toEqual(expect.arrayContaining([expect.stringContaining("matched no record")]));
  });

  it("preserves last-known-good on failure", async () => {
    // Seed a good weather value and index first.
    await seedGroup("weather", ommArray(["GOOD SAT", 1]), "2026-01-01T00:00:00.000Z");
    await env.GP_KV.put(
      "gp:index",
      JSON.stringify({ updated: "2026-01-01T00:00:00.000Z", groups: [{ name: "weather", updated: "2026-01-01T00:00:00.000Z", count: 1 }] } satisfies GroupsIndex),
    );

    // All upstream requests now fail (HTTP 503).
    interceptCelestrak(() => [], { status: 503 });

    const ctx = createExecutionContext();
    const controller = createScheduledController({ scheduledTime: Date.now(), cron: "23 */3 * * *" });
    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);

    // Last-known-good value stays in KV.
    const weather = (await env.GP_KV.get("gp:weather", "json")) as OmmRecord[];
    expect(weather.map((r) => r.OBJECT_NAME)).toEqual(["GOOD SAT"]);

    // Index keeps the old `updated` and records lastError.
    const index = (await env.GP_KV.get("gp:index", "json")) as GroupsIndex;
    const weatherStatus = index.groups.find((g) => g.name === "weather");
    expect(weatherStatus?.updated).toBe("2026-01-01T00:00:00.000Z");
    expect(weatherStatus?.lastError).toBeTruthy();
    expect(weatherStatus?.lastErrorAt).toBeTruthy();
  });

  it("runs the refresh and reports per-source diagnostics on POST /api/refresh", async () => {
    // An old index means we are past the cooldown, so the refresh runs.
    await env.GP_KV.put("gp:index", JSON.stringify({ updated: "2020-01-01T00:00:00.000Z", groups: [] } satisfies GroupsIndex));
    interceptCelestrak((group) => [{ OBJECT_NAME: `${group.toUpperCase()}-1`, NORAD_CAT_ID: 42 }]);

    const res = await SELF.fetch("https://satvis.space/api/refresh", { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const body = (await res.json()) as {
      refreshed: boolean;
      written: number;
      sources: { key: string; ok: boolean; status?: number; records?: number }[];
      groups: { name: string }[];
    };
    expect(body.refreshed).toBe(true);
    expect(body.written).toBeGreaterThan(0);
    expect(body.sources).toHaveLength(SOURCE_COUNT);
    expect(body.sources.every((s) => s.ok && s.status === 200 && (s.records ?? 0) > 0)).toBe(true);
    // Whatever it fetched was persisted (unlike a read-only probe).
    expect(Array.isArray(await env.GP_KV.get("gp:weather", "json"))).toBe(true);
  });

  it("rate-limits POST /api/refresh within the cooldown and returns the cached index", async () => {
    // A very recent index puts us inside the cooldown window. interceptCelestrak()
    // is not called, so the afterEach assertion proves no upstream fetch was made.
    const recent = new Date().toISOString();
    await env.GP_KV.put(
      "gp:index",
      JSON.stringify({ updated: recent, groups: [{ name: "weather", updated: recent, count: 2, lastError: "source celestrak:weather failed: HTTP 522" }] } satisfies GroupsIndex),
    );

    const res = await SELF.fetch("https://satvis.space/api/refresh", { method: "POST" });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    const body = (await res.json()) as { refreshed: boolean; reason: string; retryAfterMs: number; groups: { name: string; lastError?: string }[] };
    expect(body.refreshed).toBe(false);
    expect(body.reason).toBe("cooldown");
    expect(body.retryAfterMs).toBeGreaterThan(0);
    // The cached index (with its errors) is still returned for visibility.
    expect(body.groups.find((g) => g.name === "weather")?.lastError).toContain("HTTP 522");
  });

  it("rejects a non-POST /api/refresh with 405", async () => {
    const res = await SELF.fetch("https://satvis.space/api/refresh");
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });
});
