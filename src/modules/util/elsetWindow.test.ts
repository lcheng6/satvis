import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchElsetWindow, hidesSatellite, MAX_WINDOW_SATNOS, resolveElset, windowBoundsFor, windowCovers, type ElsetWindow } from "./elsetWindow";

const LINE1_A = "1 61047U 24163C   26209.07670880 +.00000291 +00000+0 +27807-4 0 99997";
const LINE2_A = "2 61047  52.9688 116.5418 0006088 238.0390 122.0013 15.20690064104132";
const LINE1_B = "1 61047U 24163C   26210.06254632 -.00000042 +00000+0 +12824-4 0 99999";
const LINE2_B = "2 61047  52.9688 116.5418 0006088 238.0390 122.0013 15.20690064104132";

function windowResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

// A window built by hand, for the pure resolution tests.
function makeWindow(overrides: Partial<ElsetWindow> = {}): ElsetWindow {
  return {
    fromMs: Date.parse("2026-07-25T00:00:00Z"),
    toMs: Date.parse("2026-08-01T00:00:00Z"),
    configured: true,
    bySatnum: new Map(),
    uncovered: new Set(),
    requested: new Set(),
    ...overrides,
  };
}

describe("windowBoundsFor", () => {
  it("snaps nearby times onto the same window, so scrubbing does not refetch", () => {
    const a = windowBoundsFor(Date.parse("2026-07-28T00:10:00Z"));
    const b = windowBoundsFor(Date.parse("2026-07-28T05:59:00Z"));
    expect(a).toEqual(b);
  });

  it("moves to a new window once the bucket is left", () => {
    const a = windowBoundsFor(Date.parse("2026-07-28T05:59:00Z"));
    const b = windowBoundsFor(Date.parse("2026-07-28T06:01:00Z"));
    expect(a).not.toEqual(b);
  });

  it("spans a week around the requested time", () => {
    const { fromMs, toMs } = windowBoundsFor(Date.parse("2026-07-28T00:00:00Z"));
    expect(toMs - fromMs).toBe(7 * 24 * 3_600_000);
  });
});

describe("windowCovers", () => {
  const time = Date.parse("2026-07-28T00:00:00Z");
  const bounds = windowBoundsFor(time);

  it("accepts a window with the same bounds and every satellite asked for", () => {
    const window = makeWindow({ ...bounds, requested: new Set(["61047", "61048"]) });
    expect(windowCovers(window, time, ["61047"])).toBe(true);
  });

  it("rejects a window that never asked about one of the satellites", () => {
    // Enabling a new group is exactly this case: without it the newcomers would
    // silently keep their CelesTrak element sets.
    const window = makeWindow({ ...bounds, requested: new Set(["61047"]) });
    expect(windowCovers(window, time, ["61047", "61048"])).toBe(false);
  });

  it("rejects a window for a different time bucket", () => {
    const window = makeWindow({ ...bounds, requested: new Set(["61047"]) });
    expect(windowCovers(window, Date.parse("2026-08-15T00:00:00Z"), ["61047"])).toBe(false);
  });

  it("rejects a missing window", () => {
    expect(windowCovers(undefined, time, ["61047"])).toBe(false);
  });
});

describe("resolveElset", () => {
  // Two closed rows that chain exactly, then a gap, then the open row — the
  // three shapes this table actually contains.
  const window = makeWindow({
    requested: new Set(["61047", "53807"]),
    bySatnum: new Map([
      [
        "61047",
        {
          firstEpochMs: Date.parse("2025-04-11T09:59:46Z"),
          launchMs: Date.parse("2024-09-12"),
          elsets: [
            {
              epochMs: Date.parse("2026-07-28T00:00:00Z"),
              endMs: Date.parse("2026-07-28T12:00:00Z"),
              line1: LINE1_A,
              line2: LINE2_A,
              name: "SPACEMOBILE-001",
            },
            // Gap: the previous row ended at 12:00, this one starts at 18:00.
            {
              epochMs: Date.parse("2026-07-28T18:00:00Z"),
              endMs: null,
              line1: LINE1_B,
              line2: LINE2_B,
              name: "SPACEMOBILE-001",
            },
          ],
        },
      ],
    ]),
  });

  it("uses the row whose validity interval contains the instant", () => {
    expect(resolveElset(window, "61047", Date.parse("2026-07-28T06:00:00Z"))).toEqual({ kind: "elset", line1: LINE1_A, line2: LINE2_A });
  });

  it("treats the interval as half-open: the start is inside, the end is not", () => {
    expect(resolveElset(window, "61047", Date.parse("2026-07-28T00:00:00Z"))).toEqual({ kind: "elset", line1: LINE1_A, line2: LINE2_A });
    // Exactly __END_AT belongs to the next interval, not this one — and here
    // that instant is in the gap.
    expect(resolveElset(window, "61047", Date.parse("2026-07-28T12:00:00Z"))).toEqual({ kind: "no-valid-entry" });
  });

  it("uses the open row for any instant at or after its start", () => {
    expect(resolveElset(window, "61047", Date.parse("2026-07-28T18:00:00Z"))).toEqual({ kind: "elset", line1: LINE1_B, line2: LINE2_B });
    expect(resolveElset(window, "61047", Date.parse("2030-01-01T00:00:00Z"))).toEqual({ kind: "elset", line1: LINE1_B, line2: LINE2_B });
  });

  it("reports an instant inside a chain gap as having no valid entry", () => {
    // Covered and long launched, but no interval contains 15:00. Hidden, per
    // the selection rule — this is the case that costs 41-46% of the timeline.
    expect(resolveElset(window, "61047", Date.parse("2026-07-28T15:00:00Z"))).toEqual({ kind: "no-valid-entry" });
  });

  it("reports a time before the satcat launch date as before-launch", () => {
    expect(resolveElset(window, "61047", Date.parse("2024-01-01T00:00:00Z"))).toEqual({ kind: "before-launch" });
  });

  it("distinguishes 'in orbit but no history that far back' from 'not launched'", () => {
    // 2024-10 is after the 2024-09-12 launch but before this table's first row
    // (2025-04-11) — the satellite existed, the data does not reach it. Both
    // hide, but conflating them would misreport a coverage hole as a launch.
    expect(resolveElset(window, "61047", Date.parse("2024-10-01T00:00:00Z"))).toEqual({ kind: "before-first" });
  });

  it("falls back to the first epoch when the table carries no launch date", () => {
    const noLaunch = makeWindow({
      requested: new Set(["61047"]),
      bySatnum: new Map([["61047", { firstEpochMs: Date.parse("2025-04-11T09:59:46Z"), launchMs: null, elsets: [] }]]),
    });
    expect(resolveElset(noLaunch, "61047", Date.parse("2024-01-01T00:00:00Z"))).toEqual({ kind: "before-first" });
  });

  it("says nothing about a satellite the table does not cover", () => {
    // 53807 was requested but has no entry — it must keep its CelesTrak element
    // set and stay visible, NOT be hidden.
    expect(resolveElset(window, "53807", Date.parse("2026-07-29T00:00:00Z"))).toEqual({ kind: "unknown" });
  });

  it("hides on every no-element-set resolution and on neither of the others", () => {
    expect(hidesSatellite({ kind: "before-launch" })).toBe(true);
    expect(hidesSatellite({ kind: "before-first" })).toBe(true);
    expect(hidesSatellite({ kind: "no-valid-entry" })).toBe(true);
    // "unknown" must NOT hide: the table simply has nothing to say, so the
    // satellite keeps its CelesTrak element set and stays visible.
    expect(hidesSatellite({ kind: "unknown" })).toBe(false);
    expect(hidesSatellite({ kind: "elset", line1: LINE1_A, line2: LINE2_A })).toBe(false);
  });
});

describe("fetchElsetWindow", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("unmocked fetch");
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requests the bucketed window and parses the entries", async () => {
    const spy = vi.mocked(globalThis.fetch).mockResolvedValue(
      windowResponse({
        configured: true,
        entries: [
          {
            satNo: 61047,
            firstEpoch: "2025-04-11T09:59:46Z",
            launchDate: "2024-09-12",
            elsets: [{ epoch: "2026-07-29T01:30:04Z", supersededAt: null, line1: LINE1_B, line2: LINE2_B, objectName: "SPACEMOBILE-001" }],
          },
        ],
        uncovered: [53807],
      }),
    );

    const window = await fetchElsetWindow(["61047", "53807"], Date.parse("2026-07-29T12:00:00Z"));

    const url = String(spy.mock.calls[0]![0]);
    const bounds = windowBoundsFor(Date.parse("2026-07-29T12:00:00Z"));
    expect(url).toContain("satnos=61047,53807");
    expect(url).toContain(`from=${encodeURIComponent(new Date(bounds.fromMs).toISOString())}`.replace(/%3A/g, ":"));
    expect(window.configured).toBe(true);
    expect(window.bySatnum.get("61047")?.firstEpochMs).toBe(Date.parse("2025-04-11T09:59:46Z"));
    expect(window.uncovered).toEqual(new Set(["53807"]));
    expect(window.requested).toEqual(new Set(["61047", "53807"]));
  });

  it("treats an unconfigured deployment as an empty window, not a failure", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(windowResponse({ configured: false, entries: [], uncovered: [] }));

    const window = await fetchElsetWindow(["61047"], Date.now());

    expect(window.configured).toBe(false);
    expect(window.bySatnum.size).toBe(0);
  });

  it("does not call the api for alpha-5 satnums, which the table cannot key on", async () => {
    const spy = vi.mocked(globalThis.fetch);
    const window = await fetchElsetWindow(["E8493"], Date.now());
    expect(spy).not.toHaveBeenCalled();
    expect(window.configured).toBe(false);
  });

  it("does not call the api past the satellite cap", async () => {
    const spy = vi.mocked(globalThis.fetch);
    const satnums = Array.from({ length: MAX_WINDOW_SATNOS + 1 }, (_, i) => String(10_000 + i));
    await fetchElsetWindow(satnums, Date.now());
    expect(spy).not.toHaveBeenCalled();
  });

  it("raises on an HTTP failure so the caller can leave element sets alone", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("nope", { status: 502 }));
    await expect(fetchElsetWindow(["61047"], Date.now())).rejects.toThrow(/HTTP 502/);
  });
});
