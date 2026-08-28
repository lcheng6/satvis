// Resolve the Databricks connection from the Worker environment.
//
// Host and warehouse id are plain vars (wrangler.jsonc); the token is a secret
// (`wrangler secret put DATABRICKS_TOKEN`, or worker/.dev.vars locally). Every
// consumer goes through resolveDatabricks so "not configured" is one
// well-defined state rather than three separate undefined checks — the worker
// must keep serving CelesTrak data when no Databricks credentials exist.

import type { DatabricksConfig } from "./client.ts";

// The SCD2 element-set table. Overridable per-environment, so a fork can point
// at its own table without a code change.
//
// This is the BASE table, not the elset_scd2_with_satcat view. The view is
// `elset_scd2 JOIN satcat_scd1 ON idOnOrbit = NORAD_CAT_ID` — an INNER join,
// and the satcat side is stale (last ingest 2026-04-13, latest LAUNCH
// 2026-03-30). Every satellite catalogued since then falls out of the view
// entirely: it holds 6,450 satellites against the base table's 38,066, and has
// no rows at all for BLUEWALKER 3 (53807), SPACEMOBILE-008/009/010
// (69589-69591) or SPACEMOBILE-011/012/013 (100240-100242).
//
// Reading the base table and joining satcat with a LEFT join keeps the names
// and launch dates where satcat has them, without letting a stale dimension
// decide which satellites exist.
export const DEFAULT_ELSET_TABLE = "space_force_demo_v2.dev_analyst_enablement_and_retrieval.elset_scd2";

// The satcat dimension, joined LEFT for OBJECT_NAME / OBJECT_ID / LAUNCH only.
// Never filters: a satellite missing here still resolves its element sets, it
// just carries no name or launch date from Databricks.
export const DEFAULT_SATCAT_TABLE = "space_force_demo_v2.dev_analyst_enablement_and_retrieval.satcat_scd1";

// A table identifier can never be a bound parameter, so it is interpolated —
// and therefore must be validated. Unity Catalog names are
// catalog.schema.table, each part word characters only.
const TABLE_IDENTIFIER_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+){0,2}$/;

export interface DatabricksSettings extends DatabricksConfig {
  elsetTable: string;
  satcatTable: string;
}

// Assert a fully-qualified name is safe to interpolate into SQL.
export function assertTableIdentifier(name: string): string {
  if (!TABLE_IDENTIFIER_RE.test(name)) {
    throw new Error(`invalid table identifier ${JSON.stringify(name)}`);
  }
  return name;
}

// The settings, or null when the environment carries no Databricks
// configuration at all. Throws when the configuration is present but partial:
// a half-set connection is a deployment mistake, not a "feature off" signal,
// and silently degrading would hide it.
export function resolveDatabricks(env: Env): DatabricksSettings | null {
  const host = env.DATABRICKS_HOST?.trim();
  const warehouseId = env.DATABRICKS_WAREHOUSE_ID?.trim();
  const token = env.DATABRICKS_TOKEN?.trim();

  if (!host && !warehouseId && !token) {
    return null;
  }
  const missing = [
    ["DATABRICKS_HOST", host],
    ["DATABRICKS_WAREHOUSE_ID", warehouseId],
    ["DATABRICKS_TOKEN", token],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Databricks is partially configured — missing ${missing.join(", ")}`);
  }

  return {
    host: host!,
    warehouseId: warehouseId!,
    token: token!,
    elsetTable: assertTableIdentifier(env.DATABRICKS_ELSET_TABLE?.trim() || DEFAULT_ELSET_TABLE),
    satcatTable: assertTableIdentifier(env.DATABRICKS_SATCAT_TABLE?.trim() || DEFAULT_SATCAT_TABLE),
  };
}
