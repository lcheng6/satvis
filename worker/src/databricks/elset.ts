// Time-appropriate element-set lookup against the SCD2 elset view.
//
// Selection rule — the SCD2 validity match, as specified in
// claude_requests/use_up_to_date_tle_from_databricks.md tasking 4:
//
//     __START_AT <= t AND (__END_AT IS NULL OR t < __END_AT)
//
// A row's validity interval is half-open, [__START_AT, __END_AT): an instant
// exactly on an epoch belongs to the row that starts there, and to exactly one
// row. (The tasking writes `__START_AT < t`; taking the start inclusively is
// what keeps an instant landing precisely on an epoch resolvable at all.)
//
// A satellite with no matching row is not displayed at that time — see
// SELECTION_HAS_GAPS below for what that costs.
//
// Facts about this table, verified against the live data:
//
//  1. __START_AT IS the TLE epoch — across 1,145 sampled rows the parsed epoch
//     of line1 and __START_AT differ by 0s.
//  2. The chain is NOT continuous. Across 2,679 sampled rows: 1,911 chain
//     exactly (__END_AT == the next __START_AT), 763 are followed by a GAP
//     (__END_AT < the next __START_AT), and 0 overlap. For the AST SpaceMobile
//     satellites those gaps cover 41-46% of each satellite's history, with the
//     longest single gap ~19.8 days. Under this rule a gap means invisible.
//     Selecting the greatest __START_AT <= t instead would be immune to the
//     gaps; it is deliberately NOT what this implements.
//  3. satNo is null on 41% of rows (11,896,863 of 28,715,420), and on 5,377 of
//     the 38,118 currently-open rows — 14%. idOnOrbit carries the number on
//     those rows and the TLE lines are intact, so they are good data behind a
//     null key. BLUEWALKER 3's current open row is one of them. Keying on satNo
//     alone therefore hides one satellite in seven at present time; every query
//     here keys on SAT_KEY_SQL below instead.

import type { TleRecord } from "../gp/types.ts";
import { query, rowsToObjects, type DatabricksConfig } from "./client.ts";
import { assertTableIdentifier } from "./config.ts";

// One element set as served by the view, normalized out of JSON_ARRAY's
// all-strings representation.
export interface ElsetRow {
  satNo: number;
  objectName: string | null;
  objectId: string | null;
  line1: string;
  line2: string;
  // __START_AT — the TLE epoch, ISO-8601 UTC.
  epoch: string;
  // __END_AT — when this row was superseded; null while it is the open row.
  supersededAt: string | null;
  source: string | null;
  dataMode: string | null;
}

export interface ElsetQueryOptions {
  satNos: number[];
  // Point in time to resolve against; defaults to now.
  asOf?: Date;
  timeoutMs?: number;
}

// The satellite key every query filters, groups and partitions on.
//
// satNo first, so a row that has it keeps using it; idOnOrbit only where satNo
// is null. The reverse order would be wrong: idOnOrbit is not always the
// catalog number — some rows carry a UUID there (satNo 81102-81104) — whereas
// on a null-satNo row it reliably holds the number. Written once and shared so
// the point lookup, the window fetch and their GROUP BY can never disagree
// about what identifies a satellite.
const SAT_KEY_SQL = "coalesce(cast(e.satNo AS string), e.idOnOrbit)";

// elset LEFT JOIN satcat. LEFT, not INNER: satcat is a stale dimension (latest
// LAUNCH 2026-03-30) and must contribute names and launch dates without
// deciding which satellites exist. The joined-view equivalent of this query
// returns nothing at all for BLUEWALKER 3 or any satellite catalogued since
// April.
function fromClause(elsetTable: string, satcatTable: string): string {
  return `${assertTableIdentifier(elsetTable)} e
      LEFT JOIN ${assertTableIdentifier(satcatTable)} s ON e.idOnOrbit = s.NORAD_CAT_ID`;
}

// The row whose SCD2 validity interval contains :asOf, one per satellite.
//
// `array_contains(split(:satNos, ','), ...)` is how a variable-length IN list
// is expressed here: the Statement Execution API binds scalars only, so the ids
// travel as one comma-joined string rather than being interpolated into SQL.
//
// __START_AT / __END_AT are STRING columns; both sides are pushed through
// to_timestamp so the comparisons are real instant comparisons and do not
// depend on every row carrying identical fractional-second precision.
//
// row_number() still guards against a satellite matching twice. It cannot
// happen in this table (0 overlaps measured), but a duplicate would otherwise
// silently double a satellite rather than being reduced to one answer.
function buildStatement(elsetTable: string, satcatTable: string): string {
  return `
    SELECT satNo, OBJECT_NAME, OBJECT_ID, line1, line2, __START_AT, __END_AT, source, dataMode
    FROM (
      SELECT
        ${SAT_KEY_SQL} AS satNo,
        s.OBJECT_NAME AS OBJECT_NAME, s.OBJECT_ID AS OBJECT_ID,
        e.line1 AS line1, e.line2 AS line2,
        e.__START_AT AS __START_AT, e.__END_AT AS __END_AT,
        e.source AS source, e.dataMode AS dataMode,
        row_number() OVER (PARTITION BY ${SAT_KEY_SQL} ORDER BY to_timestamp(e.__START_AT) DESC) AS rn
      FROM ${fromClause(elsetTable, satcatTable)}
      WHERE array_contains(split(:satNos, ','), ${SAT_KEY_SQL})
        AND to_timestamp(e.__START_AT) <= :asOf
        AND (e.__END_AT IS NULL OR :asOf < to_timestamp(e.__END_AT))
        AND e.line1 IS NOT NULL
        AND e.line2 IS NOT NULL
    )
    WHERE rn = 1
    ORDER BY satNo
  `;
}

// Fetch the time-appropriate element set for each requested satellite.
// Satellites with no row at or before `asOf` are simply absent from the result
// — the caller decides whether that is an error (see the missing-id report in
// the probe endpoint).
export async function fetchElsets(config: DatabricksConfig, table: string, satcatTable: string, options: ElsetQueryOptions): Promise<ElsetRow[]> {
  const satNos = [...new Set(options.satNos)];
  if (satNos.length === 0) {
    return [];
  }
  const asOf = options.asOf ?? new Date();
  const result = await query(config, {
    statement: buildStatement(table, satcatTable),
    parameters: [
      { name: "satNos", value: satNos.join(","), type: "STRING" },
      // The API parses a TIMESTAMP parameter from an ISO-8601 string; trimming
      // the "Z" and the millis keeps it in the form Spark accepts, and the
      // value is already UTC.
      {
        name: "asOf",
        value: asOf
          .toISOString()
          .replace("T", " ")
          .replace(/\.\d+Z$/, ""),
        type: "TIMESTAMP",
      },
    ],
    // One row per satellite by construction; the cap is a guard against a
    // future view change, not a real limit.
    maxRows: Math.max(satNos.length * 2, 100),
    timeoutMs: options.timeoutMs,
  });

  return rowsToObjects(result).flatMap((row) => {
    const satNo = Number(row["satNo"]);
    // `?? null` collapses both ways a value can be absent — SQL NULL and a
    // column the view stopped emitting (indexed access is `| undefined` under
    // noUncheckedIndexedAccess) — into the one case the guard below tests.
    const line1 = row["line1"] ?? null;
    const line2 = row["line2"] ?? null;
    const epoch = row["__START_AT"] ?? null;
    // Defensive: the WHERE clause already excludes null lines, so a row failing
    // here means the view changed shape. Drop it rather than emit a record that
    // would fail to propagate.
    if (!Number.isFinite(satNo) || line1 === null || line2 === null || epoch === null) {
      return [];
    }
    return [
      {
        satNo,
        objectName: row["OBJECT_NAME"] ?? null,
        objectId: row["OBJECT_ID"] ?? null,
        line1,
        line2,
        epoch,
        supersededAt: row["__END_AT"] ?? null,
        source: row["source"] ?? null,
        dataMode: row["dataMode"] ?? null,
      },
    ];
  });
}

// One satellite's slice of a window fetch: every element set that can be the
// answer for some instant inside the window, plus the one fact the window
// cannot carry — when this satellite's history begins.
export interface ElsetWindowEntry {
  satNo: number;
  // Earliest __START_AT the view holds for this satellite, ever. Not a launch
  // date — it is where this table's history happens to begin, which can be much
  // later (the AST satellites launched 2024-09-12, first row 2025-04).
  firstEpoch: string;
  // satcat LAUNCH — the authoritative date the satellite reached orbit. Null
  // when the view carries no launch date for it.
  launchDate: string | null;
  // Ascending by epoch. May be empty when nothing in the history overlaps the
  // window.
  elsets: ElsetRow[];
}

export interface ElsetWindowResult {
  entries: ElsetWindowEntry[];
  // Requested satellites the view holds no element set for at all. These are
  // not "not launched yet" — they are outside this table's coverage, and the
  // caller should leave them on their CelesTrak element set.
  uncovered: number[];
}

export interface ElsetWindowOptions {
  satNos: number[];
  from: Date;
  to: Date;
  timeoutMs?: number;
}

// Every element set whose validity interval overlaps [from, to], in one query —
// which is exactly the set that can answer any instant in the window under the
// SCD2 match. A row starting before the window but still valid inside it
// overlaps, so it is included by the same condition; no separate "row before
// the window" is needed.
//
// LEFT JOIN from `firsts`, so a satellite whose history lies entirely after the
// window still comes back — carrying its firstEpoch and no rows, which is the
// "not launched yet at this time" case the caller must render as absent rather
// than as missing data.
function buildWindowStatement(elsetTable: string, satcatTable: string): string {
  return `
    WITH src AS (
      SELECT ${SAT_KEY_SQL} AS satNo,
             s.OBJECT_NAME AS OBJECT_NAME, s.OBJECT_ID AS OBJECT_ID, s.LAUNCH AS LAUNCH,
             e.line1 AS line1, e.line2 AS line2,
             e.__START_AT AS __START_AT, e.__END_AT AS __END_AT,
             e.source AS source, e.dataMode AS dataMode,
             to_timestamp(e.__START_AT) AS start_ts,
             CASE WHEN e.__END_AT IS NULL THEN NULL ELSE to_timestamp(e.__END_AT) END AS end_ts
      FROM ${fromClause(elsetTable, satcatTable)}
      WHERE array_contains(split(:satNos, ','), ${SAT_KEY_SQL})
        AND e.line1 IS NOT NULL
        AND e.line2 IS NOT NULL
    ),
    firsts AS (
      -- LAUNCH comes from the satcat LEFT join and is the authoritative launch
      -- date where it exists. It is not derivable from element sets: a TLE
      -- propagates backwards past its own launch perfectly happily, and this
      -- table's history for a satellite can begin long after it reached orbit
      -- (the AST satellites launched 2024-09-12 but have no rows before
      -- 2025-04). NULL for anything catalogued after satcat went stale — those
      -- satellites get their launch date from the group's CelesTrak
      -- satcatSources instead.
      SELECT satNo, min(__START_AT) AS first_epoch, max(LAUNCH) AS launch_date
      FROM src GROUP BY satNo
    ),
    picked AS (
      SELECT * FROM src
      WHERE start_ts <= :windowTo
        AND (end_ts IS NULL OR end_ts > :windowFrom)
    )
    SELECT f.satNo AS satNo, f.first_epoch AS first_epoch, f.launch_date AS launch_date,
           p.OBJECT_NAME, p.OBJECT_ID, p.line1, p.line2, p.__START_AT, p.__END_AT, p.source, p.dataMode
    FROM firsts f
    LEFT JOIN picked p ON p.satNo = f.satNo
    ORDER BY f.satNo, p.__START_AT
  `;
}

// Spark accepts a TIMESTAMP parameter as "YYYY-MM-DD HH:MM:SS"; the value is
// already UTC, so dropping the "T" and the sub-second part loses nothing.
function toSparkTimestamp(value: Date): string {
  return value
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "");
}

// Fetch every element set covering [from, to] for the requested satellites, in
// a single statement, so scrubbing time inside the window costs no further
// round trip.
export async function fetchElsetWindow(config: DatabricksConfig, table: string, satcatTable: string, options: ElsetWindowOptions): Promise<ElsetWindowResult> {
  const satNos = [...new Set(options.satNos)];
  if (satNos.length === 0) {
    return { entries: [], uncovered: [] };
  }
  const result = await query(config, {
    statement: buildWindowStatement(table, satcatTable),
    parameters: [
      { name: "satNos", value: satNos.join(","), type: "STRING" },
      { name: "windowFrom", value: toSparkTimestamp(options.from), type: "TIMESTAMP" },
      { name: "windowTo", value: toSparkTimestamp(options.to), type: "TIMESTAMP" },
    ],
    timeoutMs: options.timeoutMs,
  });

  const bySatNo = new Map<number, ElsetWindowEntry>();
  for (const row of rowsToObjects(result)) {
    const satNo = Number(row["satNo"]);
    const firstEpoch = row["first_epoch"] ?? null;
    if (!Number.isFinite(satNo) || firstEpoch === null) {
      continue;
    }
    let entry = bySatNo.get(satNo);
    if (entry === undefined) {
      entry = { satNo, firstEpoch, launchDate: row["launch_date"] ?? null, elsets: [] };
      bySatNo.set(satNo, entry);
    }
    // The LEFT JOIN's null row: this satellite is covered, but has nothing in
    // or before the window. Its firstEpoch above is the whole answer.
    const line1 = row["line1"] ?? null;
    const line2 = row["line2"] ?? null;
    const epoch = row["__START_AT"] ?? null;
    if (line1 === null || line2 === null || epoch === null) {
      continue;
    }
    entry.elsets.push({
      satNo,
      objectName: row["OBJECT_NAME"] ?? null,
      objectId: row["OBJECT_ID"] ?? null,
      line1,
      line2,
      epoch,
      supersededAt: row["__END_AT"] ?? null,
      source: row["source"] ?? null,
      dataMode: row["dataMode"] ?? null,
    });
  }

  return {
    entries: [...bySatNo.values()],
    uncovered: satNos.filter((satNo) => !bySatNo.has(satNo)),
  };
}

// Project an element set onto the pipeline's TleRecord shape, so Databricks
// rows can flow through the same evaluate/enrich path as CelesTrak records.
// Kept separate from fetchElsets: the query is useful on its own (the probe
// reports epochs and provenance, which TleRecord has nowhere to put).
export function toTleRecord(row: ElsetRow): TleRecord {
  return {
    OBJECT_NAME: row.objectName ?? `SATNO ${row.satNo}`,
    TLE_LINE1: row.line1,
    TLE_LINE2: row.line2,
  };
}
