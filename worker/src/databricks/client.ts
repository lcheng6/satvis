// Databricks SQL client for the Worker runtime.
//
// Deliberately NOT the @databricks/sql npm driver: that driver speaks Thrift
// over Node sockets (node:http/node:net/node:zlib) and cannot run on workerd.
// The SQL Statement Execution API is plain HTTPS+JSON, so it needs nothing but
// fetch() and works unchanged in the Worker, in `wrangler dev`, and in tests.
//
// Shape of the exchange (docs: /api/workspace/statementexecution):
//   POST /api/2.0/sql/statements        -> { statement_id, status, manifest?, result? }
//   GET  /api/2.0/sql/statements/{id}   -> same, once the statement has settled
//   GET  <next_chunk_internal_link>     -> the next slice of result.data_array
//   POST /api/2.0/sql/statements/{id}/cancel
//
// The first POST waits inline for up to WAIT_TIMEOUT; anything slower (a cold
// serverless warehouse takes tens of seconds to start) falls through to polling.

// Values the API reports for a statement's lifecycle. PENDING/RUNNING are the
// two non-terminal ones; everything else ends the exchange.
export type StatementState = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED" | "CLOSED";

export interface DatabricksConfig {
  // Workspace URL, e.g. https://dbc-xxxxxxxx-xxxx.cloud.databricks.com
  host: string;
  warehouseId: string;
  // Bearer token: a PAT or an OAuth access token. Never logged.
  token: string;
}

// A named query parameter. The API binds these server-side, so callers never
// interpolate user input into SQL. `type` is a Databricks SQL type name
// ("STRING", "BIGINT", "TIMESTAMP", ...); omitted means STRING.
export interface StatementParameter {
  name: string;
  value: string | null;
  type?: string;
}

export interface QueryOptions {
  statement: string;
  parameters?: StatementParameter[];
  // Wall-clock budget for the whole exchange (submit + poll + chunk fetches).
  // A cold serverless warehouse can take ~30-60s to start, so the default is
  // generous; a cron refresh has room for it, an interactive probe should pass
  // something shorter.
  timeoutMs?: number;
  // Server-side cap on returned rows (API `row_limit`).
  maxRows?: number;
  catalog?: string;
  schema?: string;
}

export interface QueryResult {
  columns: string[];
  // Row-major, exactly as JSON_ARRAY returns it: every value is a string (or
  // null), including numbers. Callers coerce — see rowsToObjects / elset.ts.
  rows: (string | null)[][];
  statementId: string;
  // Wall-clock duration of the whole exchange.
  ms: number;
  // How many result chunks were fetched (1 unless the result spilled).
  chunks: number;
  // The API truncated the result to satisfy row_limit / the INLINE size cap.
  truncated: boolean;
}

// A statement that did not reach SUCCEEDED, or an HTTP/transport failure.
// Carries the statement id (when the submit got far enough to have one) so a
// failure can be looked up in the workspace query history.
export class DatabricksError extends Error {
  readonly state: StatementState | "HTTP";
  readonly statementId: string | undefined;
  readonly status: number | undefined;

  constructor(message: string, opts: { state: StatementState | "HTTP"; statementId?: string; status?: number }) {
    super(message);
    this.name = "DatabricksError";
    this.state = opts.state;
    this.statementId = opts.statementId;
    this.status = opts.status;
  }
}

// Inline wait on the initial POST. The API accepts "0s" or 5s-50s; 10s returns
// a warm warehouse's answer in the first round trip without holding the
// connection open for a cold start.
const WAIT_TIMEOUT = "10s";
const DEFAULT_TIMEOUT_MS = 90_000;
// Poll backoff: quick at first (a warm statement settles in well under a
// second), easing off so a cold-starting warehouse is not hammered.
const POLL_INITIAL_MS = 250;
const POLL_MAX_MS = 2_000;
const POLL_FACTOR = 1.5;

// Minimal shapes of the API responses — only the fields we read.
interface StatementResponse {
  statement_id?: string;
  status?: { state?: StatementState; error?: { error_code?: string; message?: string } };
  manifest?: { schema?: { columns?: { name?: string }[] }; truncated?: boolean };
  result?: ResultData;
}

interface ResultData {
  data_array?: (string | null)[][];
  next_chunk_internal_link?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeHost(host: string): string {
  const trimmed = host.trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

// One authenticated call to the workspace API. Throws DatabricksError on any
// non-2xx so every caller gets the same failure type; the body sample is kept
// because Databricks puts the useful part of an error there, not in the status.
async function apiCall(config: DatabricksConfig, path: string, init: { method: "GET" | "POST"; body?: unknown; signal: AbortSignal }): Promise<StatementResponse> {
  const res = await fetch(`${normalizeHost(config.host)}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new DatabricksError(`HTTP ${res.status} from ${path}: ${text.slice(0, 300)}`, { state: "HTTP", status: res.status });
  }
  try {
    return JSON.parse(text) as StatementResponse;
  } catch {
    throw new DatabricksError(`${path} returned non-JSON (starts with ${JSON.stringify(text.slice(0, 60))})`, { state: "HTTP", status: res.status });
  }
}

// Best-effort cancel so an abandoned statement stops occupying the warehouse.
// Never throws: we are already on a failure path and the original error is the
// one worth reporting.
async function cancelStatement(config: DatabricksConfig, statementId: string): Promise<void> {
  try {
    await apiCall(config, `/api/2.0/sql/statements/${statementId}/cancel`, { method: "POST", signal: AbortSignal.timeout(5_000) });
  } catch (err) {
    console.warn(`databricks: cancel of statement ${statementId} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function isTerminal(state: StatementState | undefined): boolean {
  return state !== undefined && state !== "PENDING" && state !== "RUNNING";
}

// Run a statement to completion and return every row.
//
// Uses INLINE disposition, which the API caps at 25 MiB per result — ample for
// per-satellite element-set lookups, but a whole-catalog dump would need
// EXTERNAL_LINKS instead.
export async function query(config: DatabricksConfig, options: QueryOptions): Promise<QueryResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // One deadline for the whole exchange, so polling and chunk fetching cannot
  // extend it past what the caller allowed.
  const deadline = AbortSignal.timeout(timeoutMs);

  let response = await apiCall(config, "/api/2.0/sql/statements", {
    method: "POST",
    signal: deadline,
    body: {
      warehouse_id: config.warehouseId,
      statement: options.statement,
      parameters: options.parameters,
      catalog: options.catalog,
      schema: options.schema,
      row_limit: options.maxRows,
      format: "JSON_ARRAY",
      disposition: "INLINE",
      wait_timeout: WAIT_TIMEOUT,
      // Keep the statement running past the inline wait and pick it up by
      // polling; CANCEL would throw away a cold-start we already paid for.
      on_wait_timeout: "CONTINUE",
    },
  });

  const statementId = response.statement_id;
  if (statementId === undefined) {
    throw new DatabricksError("submit returned no statement_id", { state: "HTTP" });
  }

  // Poll until the statement settles or the deadline aborts the in-flight GET.
  // Intentionally sequential: each poll's result decides whether there is a next
  // one, so this cannot be a Promise.all.
  let backoff = POLL_INITIAL_MS;
  while (!isTerminal(response.status?.state)) {
    if (deadline.aborted) {
      // eslint-disable-next-line no-await-in-loop -- sequential poll (see above)
      await cancelStatement(config, statementId);
      throw new DatabricksError(`statement ${statementId} did not finish within ${timeoutMs}ms (last state ${response.status?.state ?? "unknown"})`, {
        state: response.status?.state ?? "PENDING",
        statementId,
      });
    }
    // eslint-disable-next-line no-await-in-loop -- sequential poll (see above)
    await delay(backoff);
    backoff = Math.min(Math.round(backoff * POLL_FACTOR), POLL_MAX_MS);
    // eslint-disable-next-line no-await-in-loop -- sequential poll (see above)
    response = await apiCall(config, `/api/2.0/sql/statements/${statementId}`, { method: "GET", signal: deadline });
  }

  const state = response.status?.state;
  if (state !== "SUCCEEDED") {
    const detail = response.status?.error?.message ?? "no error message";
    const code = response.status?.error?.error_code;
    throw new DatabricksError(`statement ${statementId} ${state}: ${code ? `[${code}] ` : ""}${detail}`, { state: state ?? "FAILED", statementId });
  }

  const columns = (response.manifest?.schema?.columns ?? []).map((column, i) => column.name ?? `col_${i}`);
  const rows: (string | null)[][] = [...(response.result?.data_array ?? [])];

  // Walk the chunk chain. Each link is a workspace-relative path, so it goes
  // through apiCall and inherits the same auth and deadline. Sequential by
  // construction: a chunk names its successor, so none can be fetched early.
  let chunks = 1;
  let nextLink = response.result?.next_chunk_internal_link;
  while (nextLink !== undefined) {
    // eslint-disable-next-line no-await-in-loop -- the chain is discovered one link at a time
    const chunk = await apiCall(config, nextLink, { method: "GET", signal: deadline });
    // A chunk response carries the same envelope shape, but the payload may sit
    // at the top level rather than under `result`.
    const data = chunk.result ?? (chunk as ResultData);
    rows.push(...(data.data_array ?? []));
    nextLink = data.next_chunk_internal_link;
    chunks++;
  }

  return {
    columns,
    rows,
    statementId,
    ms: Date.now() - started,
    chunks,
    truncated: response.manifest?.truncated === true,
  };
}

// Zip a JSON_ARRAY result into per-row objects keyed by column name. Values stay
// strings (or null) — JSON_ARRAY stringifies everything, including numbers.
export function rowsToObjects(result: QueryResult): Record<string, string | null>[] {
  return result.rows.map((row) => {
    const obj: Record<string, string | null> = {};
    for (let i = 0; i < result.columns.length; i++) {
      obj[result.columns[i]!] = row[i] ?? null;
    }
    return obj;
  });
}
