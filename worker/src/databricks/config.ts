// Resolve the Databricks connection from the Worker environment.
//
// Host and warehouse id are plain vars (wrangler.jsonc); the token is a secret
// (`wrangler secret put DATABRICKS_TOKEN`, or worker/.dev.vars locally). Every
// consumer goes through resolveDatabricks so "not configured" is one
// well-defined state rather than three separate undefined checks — the worker
// must keep serving CelesTrak data when no Databricks credentials exist.

import type { DatabricksConfig } from "./client.ts";

// The SCD2 element-set view. Overridable per-environment, so a fork can point
// at its own table without a code change.
export const DEFAULT_ELSET_TABLE = "space_force_demo_v2.dev_analyst_enablement_and_retrieval.elset_scd2_with_satcat";

// A table identifier can never be a bound parameter, so it is interpolated —
// and therefore must be validated. Unity Catalog names are
// catalog.schema.table, each part word characters only.
const TABLE_IDENTIFIER_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+){0,2}$/;

export interface DatabricksSettings extends DatabricksConfig {
  elsetTable: string;
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
  };
}
