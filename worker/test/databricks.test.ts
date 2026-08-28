import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { DatabricksError, query, rowsToObjects, type DatabricksConfig } from "../src/databricks/client.ts";
import { assertTableIdentifier, DEFAULT_ELSET_TABLE, resolveDatabricks } from "../src/databricks/config.ts";
import { fetchElsets, fetchElsetWindow, toTleRecord, type ElsetRow } from "../src/databricks/elset.ts";

const CONFIG: DatabricksConfig = { host: "https://example.cloud.databricks.com", warehouseId: "wh123", token: "secret-token" };
const TABLE = "cat.sch.elsets";
const SATCAT_TABLE = "cat.sch.satcat";

// The two real TLE lines of SPACEMOBILE-001 at epoch 2026-07-29T01:30:04Z, so
// the record mapping is exercised against data of the right shape and width.
const LINE1 = "1 61047U 24163C   26210.06254632 -.00000042 +00000+0 +12824-4 0 99999";
const LINE2 = "2 61047 053.1554 210.4451 0002104 083.7211 276.4022 15.13952880 90123";

// A statement-execution envelope. `state` drives the polling loop; `rows` and
// `nextLink` shape the result.
function envelope(state: string, opts: { rows?: (string | null)[][]; columns?: string[]; nextLink?: string; error?: string } = {}): unknown {
  return {
    statement_id: "stmt-1",
    status: { state, ...(opts.error ? { error: { error_code: "BAD_REQUEST", message: opts.error } } : {}) },
    manifest: { schema: { columns: (opts.columns ?? ["a", "b"]).map((name) => ({ name })) }, truncated: false },
    result: { data_array: opts.rows ?? [], ...(opts.nextLink ? { next_chunk_internal_link: opts.nextLink } : {}) },
  };
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("databricks client", () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      throw new Error(`unmocked fetch: ${new Request(input, init).url}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("submits with bearer auth, bound parameters and INLINE JSON_ARRAY", async () => {
    fetchSpy.mockImplementation(async () => jsonOk(envelope("SUCCEEDED", { rows: [["1", "x"]] })));

    const result = await query(CONFIG, { statement: "SELECT 1", parameters: [{ name: "n", value: "5", type: "BIGINT" }], maxRows: 10 });

    expect(result.rows).toEqual([["1", "x"]]);
    expect(result.columns).toEqual(["a", "b"]);
    expect(result.statementId).toBe("stmt-1");
    expect(result.chunks).toBe(1);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://example.cloud.databricks.com/api/2.0/sql/statements");
    expect(init!.method).toBe("POST");
    expect((init!.headers as Record<string, string>)["Authorization"]).toBe("Bearer secret-token");
    const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
    expect(body["warehouse_id"]).toBe("wh123");
    expect(body["format"]).toBe("JSON_ARRAY");
    expect(body["disposition"]).toBe("INLINE");
    expect(body["on_wait_timeout"]).toBe("CONTINUE");
    expect(body["row_limit"]).toBe(10);
    // Parameters are bound server-side, never interpolated into the SQL text.
    expect(body["parameters"]).toEqual([{ name: "n", value: "5", type: "BIGINT" }]);
    expect(String(body["statement"])).not.toContain("5");
  });

  it("polls a statement that is still running when the inline wait expires", async () => {
    fetchSpy
      .mockImplementationOnce(async () => jsonOk(envelope("PENDING")))
      .mockImplementationOnce(async () => jsonOk(envelope("RUNNING")))
      .mockImplementationOnce(async () => jsonOk(envelope("SUCCEEDED", { rows: [["done", null]] })));

    const result = await query(CONFIG, { statement: "SELECT 1" });

    expect(result.rows).toEqual([["done", null]]);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    // The follow-ups are GETs against the statement id, not fresh submits.
    expect(String(fetchSpy.mock.calls[1]![0])).toBe("https://example.cloud.databricks.com/api/2.0/sql/statements/stmt-1");
    expect(fetchSpy.mock.calls[1]![1]?.method).toBe("GET");
  });

  it("follows the chunk chain until it ends", async () => {
    fetchSpy
      .mockImplementationOnce(async () => jsonOk(envelope("SUCCEEDED", { rows: [["1", "a"]], nextLink: "/api/2.0/sql/statements/stmt-1/result/chunks/1" })))
      .mockImplementationOnce(async () => jsonOk({ data_array: [["2", "b"]], next_chunk_internal_link: "/api/2.0/sql/statements/stmt-1/result/chunks/2" }))
      .mockImplementationOnce(async () => jsonOk({ data_array: [["3", "c"]] }));

    const result = await query(CONFIG, { statement: "SELECT 1" });

    expect(result.rows).toEqual([
      ["1", "a"],
      ["2", "b"],
      ["3", "c"],
    ]);
    expect(result.chunks).toBe(3);
  });

  it("raises the statement error message on FAILED", async () => {
    fetchSpy.mockImplementation(async () => jsonOk(envelope("FAILED", { error: "TABLE_OR_VIEW_NOT_FOUND" })));

    await expect(query(CONFIG, { statement: "SELECT 1" })).rejects.toThrow(DatabricksError);
    await expect(query(CONFIG, { statement: "SELECT 1" })).rejects.toThrow(/FAILED.*TABLE_OR_VIEW_NOT_FOUND/);
  });

  it("raises on a non-2xx response and keeps a body sample", async () => {
    fetchSpy.mockImplementation(async () => new Response("no soup for you", { status: 403 }));

    await expect(query(CONFIG, { statement: "SELECT 1" })).rejects.toThrow(/HTTP 403.*no soup for you/);
  });

  it("zips rows into objects keyed by column name", () => {
    const objects = rowsToObjects({ columns: ["satNo", "line1"], rows: [["61047", null]], statementId: "s", ms: 1, chunks: 1, truncated: false });
    expect(objects).toEqual([{ satNo: "61047", line1: null }]);
  });
});

function envWith(overrides: Partial<Env>): Env {
  return { DATABRICKS_HOST: "", DATABRICKS_WAREHOUSE_ID: "", DATABRICKS_TOKEN: "", DATABRICKS_ELSET_TABLE: "", DATABRICKS_PROBE: "0", ...overrides } as Env;
}

describe("databricks config", () => {
  it("reports not-configured when nothing is set", () => {
    expect(resolveDatabricks(envWith({}))).toBeNull();
  });

  it("fails loudly on a partial configuration", () => {
    expect(() => resolveDatabricks(envWith({ DATABRICKS_HOST: "https://x" }))).toThrow(/missing DATABRICKS_WAREHOUSE_ID, DATABRICKS_TOKEN/);
  });

  it("defaults the elset table and accepts an override", () => {
    const base = { DATABRICKS_HOST: "https://x", DATABRICKS_WAREHOUSE_ID: "w", DATABRICKS_TOKEN: "t" };
    expect(resolveDatabricks(envWith(base))?.elsetTable).toBe(DEFAULT_ELSET_TABLE);
    expect(resolveDatabricks(envWith({ ...base, DATABRICKS_ELSET_TABLE: "c.s.t" }))?.elsetTable).toBe("c.s.t");
  });

  it("rejects a table identifier that could carry SQL", () => {
    expect(() => assertTableIdentifier("cat.sch.t; DROP TABLE x")).toThrow(/invalid table identifier/);
    expect(() => assertTableIdentifier("cat.sch.t")).not.toThrow();
  });
});

describe("fetchElsets", () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      throw new Error(`unmocked fetch: ${new Request(input, init).url}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const COLUMNS = ["satNo", "OBJECT_NAME", "OBJECT_ID", "line1", "line2", "__START_AT", "__END_AT", "source", "dataMode"];

  function elsetRows(...rows: (string | null)[][]): unknown {
    return envelope("SUCCEEDED", { columns: COLUMNS, rows });
  }

  it("selects the latest row at or before asOf, deduping ids", async () => {
    fetchSpy.mockImplementation(async () => jsonOk(elsetRows(["61047", "SPACEMOBILE-001", "2024-163C", LINE1, LINE2, "2026-07-29T01:30:04.002048Z", null, "18th SPCS", "REAL"])));

    const rows = await fetchElsets(CONFIG, TABLE, SATCAT_TABLE, { satNos: [61047, 61047, 61048], asOf: new Date("2026-07-30T00:00:00Z") });

    expect(rows).toEqual<ElsetRow[]>([
      {
        satNo: 61047,
        objectName: "SPACEMOBILE-001",
        objectId: "2024-163C",
        line1: LINE1,
        line2: LINE2,
        epoch: "2026-07-29T01:30:04.002048Z",
        supersededAt: null,
        source: "18th SPCS",
        dataMode: "REAL",
      },
    ]);

    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body)) as Record<string, unknown>;
    const statement = String(body["statement"]);
    // The SCD2 validity match, with a half-open interval: start inclusive, end
    // exclusive, and a null end meaning still in force.
    expect(statement).toContain("to_timestamp(e.__START_AT) <= :asOf");
    expect(statement).toContain("(e.__END_AT IS NULL OR :asOf < to_timestamp(e.__END_AT))");
    expect(statement).toContain(TABLE);
    // Satellites are keyed on satNo falling back to idOnOrbit, never satNo
    // alone: satNo is null on 14% of the table's currently-open rows, and
    // keying on it drops those satellites entirely (BLUEWALKER 3 is one).
    expect(statement).toContain("coalesce(cast(e.satNo AS string), e.idOnOrbit)");
    expect(statement).not.toContain("array_contains(split(:satNos, ','), cast(satNo AS string))");
    // satcat is joined LEFT, so a satellite it has never heard of still
    // resolves its element sets — it simply carries no name or launch date.
    expect(statement).toContain(`LEFT JOIN ${SATCAT_TABLE}`);
    expect(body["parameters"]).toEqual([
      { name: "satNos", value: "61047,61048", type: "STRING" },
      { name: "asOf", value: "2026-07-30 00:00:00", type: "TIMESTAMP" },
    ]);
  });

  it("short-circuits without a request when no satellites are asked for", async () => {
    expect(await fetchElsets(CONFIG, TABLE, SATCAT_TABLE, { satNos: [] })).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("drops a row the view returned without usable TLE lines", async () => {
    fetchSpy.mockImplementation(async () =>
      jsonOk(
        elsetRows(
          ["61047", "SPACEMOBILE-001", "2024-163C", LINE1, LINE2, "2026-07-29T01:30:04.002048Z", null, "18th SPCS", "REAL"],
          ["61048", "SPACEMOBILE-002", "2024-163D", null, LINE2, "2026-07-28T09:22:12.040896Z", null, "18th SPCS", "REAL"],
        ),
      ),
    );

    const rows = await fetchElsets(CONFIG, TABLE, SATCAT_TABLE, { satNos: [61047, 61048] });
    expect(rows.map((row) => row.satNo)).toEqual([61047]);
  });

  it("projects an element set onto the pipeline's TleRecord shape", () => {
    const row: ElsetRow = {
      satNo: 61047,
      objectName: "SPACEMOBILE-001",
      objectId: null,
      line1: LINE1,
      line2: LINE2,
      epoch: "2026-07-29T01:30:04Z",
      supersededAt: null,
      source: null,
      dataMode: null,
    };
    expect(toTleRecord(row)).toEqual({ OBJECT_NAME: "SPACEMOBILE-001", TLE_LINE1: LINE1, TLE_LINE2: LINE2 });
    expect(toTleRecord({ ...row, objectName: null }).OBJECT_NAME).toBe("SATNO 61047");
  });
});

describe("fetchElsetWindow", () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      throw new Error(`unmocked fetch: ${new Request(input, init).url}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const WINDOW_COLUMNS = ["satNo", "first_epoch", "launch_date", "OBJECT_NAME", "OBJECT_ID", "line1", "line2", "__START_AT", "__END_AT", "source", "dataMode"];

  function windowRows(...rows: (string | null)[][]): unknown {
    return envelope("SUCCEEDED", { columns: WINDOW_COLUMNS, rows });
  }

  it("groups rows per satellite and carries the first-ever epoch", async () => {
    fetchSpy.mockImplementation(async () =>
      jsonOk(
        windowRows(
          ["61047", "2025-04-11T09:59:46Z", "2024-09-12", "SPACEMOBILE-001", "2024-163C", LINE1, LINE2, "2026-07-28T01:00:00Z", null, "18th SPCS", "REAL"],
          ["61047", "2025-04-11T09:59:46Z", "2024-09-12", "SPACEMOBILE-001", "2024-163C", LINE1, LINE2, "2026-07-29T01:30:04Z", null, "18th SPCS", "REAL"],
        ),
      ),
    );

    const result = await fetchElsetWindow(CONFIG, TABLE, SATCAT_TABLE, { satNos: [61047], from: new Date("2026-07-28T00:00:00Z"), to: new Date("2026-07-30T00:00:00Z") });

    expect(result.uncovered).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.satNo).toBe(61047);
    expect(result.entries[0]!.firstEpoch).toBe("2025-04-11T09:59:46Z");
    expect(result.entries[0]!.elsets.map((e) => e.epoch)).toEqual(["2026-07-28T01:00:00Z", "2026-07-29T01:30:04Z"]);

    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body)) as Record<string, unknown>;
    const statement = String(body["statement"]);
    // Every row whose validity interval overlaps the window — which includes a
    // row that started before it and is still in force, so no separate
    // "row before the window" is needed.
    expect(statement).toContain("start_ts <= :windowTo");
    expect(statement).toContain("(end_ts IS NULL OR end_ts > :windowFrom)");
    // LEFT JOIN from firsts, so a not-yet-launched satellite still comes back.
    expect(statement).toContain("FROM firsts f");
    expect(statement).toContain("LEFT JOIN picked p");
    expect(body["parameters"]).toEqual([
      { name: "satNos", value: "61047", type: "STRING" },
      { name: "windowFrom", value: "2026-07-28 00:00:00", type: "TIMESTAMP" },
      { name: "windowTo", value: "2026-07-30 00:00:00", type: "TIMESTAMP" },
    ]);
  });

  it("keeps a covered satellite with no rows in range, so 'not yet launched' stays distinguishable", async () => {
    // The LEFT JOIN's null row: covered (it has a firstEpoch) but nothing at or
    // before the window, because the window predates its first element set.
    fetchSpy.mockImplementation(async () => jsonOk(windowRows(["69589", "2026-06-18T00:00:00Z", "2026-06-17", null, null, null, null, null, null, null, null])));

    const result = await fetchElsetWindow(CONFIG, TABLE, SATCAT_TABLE, { satNos: [69589], from: new Date("2026-03-01T00:00:00Z"), to: new Date("2026-03-08T00:00:00Z") });

    expect(result.uncovered).toEqual([]);
    // The satcat launch date rides along even when no element set does — it is
    // what lets the caller say "not launched yet" rather than "no data".
    expect(result.entries).toEqual([{ satNo: 69589, firstEpoch: "2026-06-18T00:00:00Z", launchDate: "2026-06-17", elsets: [] }]);
  });

  it("reports satellites the view holds nothing for as uncovered", async () => {
    fetchSpy.mockImplementation(async () =>
      jsonOk(windowRows(["61047", "2025-04-11T09:59:46Z", "2024-09-12", "SPACEMOBILE-001", "2024-163C", LINE1, LINE2, "2026-07-29T01:30:04Z", null, null, null])),
    );

    const result = await fetchElsetWindow(CONFIG, TABLE, SATCAT_TABLE, { satNos: [61047, 53807], from: new Date("2026-07-28T00:00:00Z"), to: new Date("2026-07-30T00:00:00Z") });

    // 53807 is absent from the table entirely — not "not launched yet", so the
    // caller must leave it on its CelesTrak element set rather than hide it.
    expect(result.uncovered).toEqual([53807]);
    expect(result.entries.map((e) => e.satNo)).toEqual([61047]);
  });

  it("short-circuits without a request when no satellites are asked for", async () => {
    expect(await fetchElsetWindow(CONFIG, TABLE, SATCAT_TABLE, { satNos: [], from: new Date(), to: new Date() })).toEqual({ entries: [], uncovered: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

function setCredentials(host: string, warehouseId: string, token: string): void {
  env.DATABRICKS_HOST = host;
  env.DATABRICKS_WAREHOUSE_ID = warehouseId;
  env.DATABRICKS_TOKEN = token;
}

// The test pool loads worker/.dev.vars, so a developer's real credentials may
// be present here. Every case below therefore sets the whole DATABRICKS_* triple
// explicitly and asserts no request escapes — a probe test must never depend on,
// or reach, a real warehouse.
describe("Databricks-backed routes", () => {
  const original = { probe: env.DATABRICKS_PROBE, host: env.DATABRICKS_HOST, warehouse: env.DATABRICKS_WAREHOUSE_ID, token: env.DATABRICKS_TOKEN };
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      throw new Error(`probe tests must not reach the network: ${new Request(input, init).url}`);
    });
  });

  afterEach(() => {
    env.DATABRICKS_PROBE = original.probe;
    env.DATABRICKS_HOST = original.host;
    env.DATABRICKS_WAREHOUSE_ID = original.warehouse;
    env.DATABRICKS_TOKEN = original.token;
    vi.restoreAllMocks();
  });

  it("404s unless explicitly enabled, so production never exposes it", async () => {
    env.DATABRICKS_PROBE = "0";
    setCredentials("https://x", "w", "t");
    const res = await SELF.fetch("https://satvis.space/api/databricks/probe");
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports not-configured rather than failing when credentials are absent", async () => {
    env.DATABRICKS_PROBE = "1";
    setCredentials("", "", "");
    const res = await SELF.fetch("https://satvis.space/api/databricks/probe");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ configured: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("500s on a half-set configuration instead of silently degrading", async () => {
    env.DATABRICKS_PROBE = "1";
    setCredentials("https://x", "", "");
    const res = await SELF.fetch("https://satvis.space/api/databricks/probe");
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ configured: false, error: expect.stringContaining("missing DATABRICKS_WAREHOUSE_ID") });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a malformed satnos list without touching Databricks", async () => {
    env.DATABRICKS_PROBE = "1";
    setCredentials("https://x", "w", "t");
    const res = await SELF.fetch("https://satvis.space/api/databricks/probe?satnos=abc");
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an unparseable at= without touching Databricks", async () => {
    env.DATABRICKS_PROBE = "1";
    setCredentials("https://x", "w", "t");
    const res = await SELF.fetch("https://satvis.space/api/databricks/probe?at=not-a-date");
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an oversized or malformed window without touching Databricks", async () => {
    setCredentials("https://x", "w", "t");
    const cases = [
      "?satnos=abc&from=2026-07-01T00:00:00Z&to=2026-07-08T00:00:00Z",
      "?satnos=61047&from=nope&to=2026-07-08T00:00:00Z",
      // to before from
      "?satnos=61047&from=2026-07-08T00:00:00Z&to=2026-07-01T00:00:00Z",
      // span beyond the 90-day cap
      "?satnos=61047&from=2025-01-01T00:00:00Z&to=2026-07-01T00:00:00Z",
    ];
    const statuses = await Promise.all(cases.map(async (search) => (await SELF.fetch(`https://satvis.space/api/elset/window${search}`)).status));
    expect(statuses).toEqual(cases.map(() => 400));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("caps how many satellites one window may ask for", async () => {
    setCredentials("https://x", "w", "t");
    const satnos = Array.from({ length: 201 }, (_, i) => 10_000 + i).join(",");
    const res = await SELF.fetch(`https://satvis.space/api/elset/window?satnos=${satnos}&from=2026-07-01T00:00:00Z&to=2026-07-08T00:00:00Z`);
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("serves an unconfigured deployment an empty window rather than an error", async () => {
    setCredentials("", "", "");
    const res = await SELF.fetch("https://satvis.space/api/elset/window?satnos=61047&from=2026-07-01T00:00:00Z&to=2026-07-08T00:00:00Z");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false, entries: [], uncovered: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns the window and marks uncovered satellites", async () => {
    setCredentials("https://x", "w", "super-secret");
    fetchSpy.mockImplementation(async () =>
      jsonOk(
        envelope("SUCCEEDED", {
          columns: ["satNo", "first_epoch", "launch_date", "OBJECT_NAME", "OBJECT_ID", "line1", "line2", "__START_AT", "__END_AT", "source", "dataMode"],
          rows: [["61047", "2025-04-11T09:59:46Z", "2024-09-12", "SPACEMOBILE-001", "2024-163C", LINE1, LINE2, "2026-07-29T01:30:04Z", null, "18th SPCS", "REAL"]],
        }),
      ),
    );

    // A distinct window per test run would be ideal, but the edge cache is keyed
    // on the normalized parameters — these bounds are used by no other test.
    const res = await SELF.fetch("https://satvis.space/api/elset/window?satnos=53807,61047&from=2026-07-29T00:00:00Z&to=2026-07-29T12:00:00Z");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: { satNo: number; firstEpoch: string; elsets: unknown[] }[]; uncovered: number[] };
    expect(body.uncovered).toEqual([53807]);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]!.firstEpoch).toBe("2025-04-11T09:59:46Z");
    expect(JSON.stringify(body)).not.toContain("super-secret");
  });

  it("reports found and missing satellites, and never echoes the token", async () => {
    env.DATABRICKS_PROBE = "1";
    setCredentials("https://x", "w", "super-secret");
    fetchSpy.mockImplementation(async () =>
      jsonOk(
        envelope("SUCCEEDED", {
          columns: ["satNo", "OBJECT_NAME", "OBJECT_ID", "line1", "line2", "__START_AT", "__END_AT", "source", "dataMode"],
          rows: [["61047", "SPACEMOBILE-001", "2024-163C", LINE1, LINE2, "2026-07-29T00:00:00Z", null, "18th SPCS", "REAL"]],
        }),
      ),
    );

    const res = await SELF.fetch("https://satvis.space/api/databricks/probe?satnos=61047,53807&at=2026-07-30T00:00:00Z");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { missing: number[]; elsets: { satNo: number; epochAgeHours: number }[] };
    expect(body.missing).toEqual([53807]);
    expect(body.elsets).toHaveLength(1);
    expect(body.elsets[0]!.satNo).toBe(61047);
    expect(body.elsets[0]!.epochAgeHours).toBe(24);
    expect(JSON.stringify(body)).not.toContain("super-secret");
  });
});
