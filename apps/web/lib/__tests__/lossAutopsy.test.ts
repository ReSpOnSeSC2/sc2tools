import { describe, expect, it } from "vitest";
import {
  fnv1a,
  lossAutopsy,
  type AutopsyGame,
  type PersonalMedians,
} from "@/lib/lossAutopsy";
import type {
  MacroBreakdownData,
  StatsEvent,
} from "@/components/analyzer/macro/MacroBreakdownPanel.types";

// ---------------------------------------------------------------------------
// Fixture builders — the shapes mirror the real client payloads:
// ProfileGame rows (Last5GamesTimeline) + MacroBreakdownData
// (GET /v1/games/:id/macro-breakdown) + `[m:ss] Name` buildLog lines.
// ---------------------------------------------------------------------------

function lossGame(over: Partial<AutopsyGame> = {}): AutopsyGame {
  return {
    id: "game-1",
    result: "Loss",
    game_length: 700,
    ...over,
  };
}

function breakdown(over: Partial<MacroBreakdownData> = {}): MacroBreakdownData {
  return {
    ok: true,
    race: "Zerg",
    game_length_sec: 700,
    ...over,
  };
}

/** Breakdown that fires ONLY the supply-block rule. */
function supplyBlockBreakdown(): MacroBreakdownData {
  return breakdown({
    raw: {
      supply_block_windows: [
        { start: 210, end: 240, blocked_sec: 25 },
        { start: 300, end: 320, blocked_sec: 16 },
      ],
      supply_blocked_seconds: 41,
    },
  });
}

/** Post-4:00 economy samples: mean bank 1000, peak 1400 at 4:30. */
function floatSamples(): StatsEvent[] {
  return [
    { time: 250, minerals_current: 1000 },
    { time: 260, minerals_current: 1200 },
    { time: 270, minerals_current: 1400 },
    { time: 280, minerals_current: 800 },
    { time: 290, minerals_current: 600 },
  ];
}

// ---------------------------------------------------------------------------
// [] cases.
// ---------------------------------------------------------------------------

describe("lossAutopsy — non-loss and insufficient data", () => {
  it("returns [] for wins", () => {
    expect(
      lossAutopsy({
        game: lossGame({ result: "Win", macroBreakdown: supplyBlockBreakdown() }),
      }),
    ).toEqual([]);
    expect(
      lossAutopsy({
        game: lossGame({
          result: "Victory",
          macroBreakdown: supplyBlockBreakdown(),
        }),
      }),
    ).toEqual([]);
  });

  it("returns [] when result is missing", () => {
    expect(
      lossAutopsy({
        game: lossGame({ result: null, macroBreakdown: supplyBlockBreakdown() }),
      }),
    ).toEqual([]);
  });

  it("returns [] for a loss with no usable data", () => {
    expect(lossAutopsy({ game: lossGame() })).toEqual([]);
    expect(
      lossAutopsy({ game: lossGame({ macroBreakdown: breakdown() }) }),
    ).toEqual([]);
  });

  it('treats "Defeat" as a loss', () => {
    const causes = lossAutopsy({
      game: lossGame({ result: "Defeat", macroBreakdown: supplyBlockBreakdown() }),
    });
    expect(causes.length).toBe(1);
    expect(causes[0].id).toBe("supply_block");
  });
});

// ---------------------------------------------------------------------------
// Rule 1 — supply blocks.
// ---------------------------------------------------------------------------

describe("lossAutopsy — supply blocks", () => {
  it("quantifies count + seconds from supply_block_windows", () => {
    const causes = lossAutopsy({
      game: lossGame({ macroBreakdown: supplyBlockBreakdown() }),
    });
    expect(causes.length).toBe(1);
    const cause = causes[0];
    expect(cause.id).toBe("supply_block");
    expect(cause.title).toBe("Supply blocks stalled production");
    // 41 blocked seconds appears in every template variant.
    expect(cause.detail).toContain("41 seconds");
    // severity = round(100 * 41 / 75) = 55.
    expect(cause.severityScore).toBe(55);
    // One timestamp per window start, formatted m:ss.
    expect(cause.timestamps).toEqual(["3:30", "5:00"]);
  });

  it("falls back to the aggregate supply_blocked_seconds scalar", () => {
    const causes = lossAutopsy({
      game: lossGame({
        macroBreakdown: breakdown({ raw: { supply_blocked_seconds: 30 } }),
      }),
    });
    expect(causes.length).toBe(1);
    expect(causes[0].id).toBe("supply_block");
    expect(causes[0].detail).toContain("30 seconds");
    // severity = round(100 * 30 / 75) = 40; no windows → no timestamps.
    expect(causes[0].severityScore).toBe(40);
    expect(causes[0].timestamps).toEqual([]);
  });

  it("ignores sub-threshold blocks (<10s)", () => {
    const causes = lossAutopsy({
      game: lossGame({
        macroBreakdown: breakdown({ raw: { supply_blocked_seconds: 6 } }),
      }),
    });
    expect(causes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — resource float.
// ---------------------------------------------------------------------------

describe("lossAutopsy — resource float", () => {
  it("computes peak/mean bank from stats_events", () => {
    const causes = lossAutopsy({
      game: lossGame({
        macroBreakdown: breakdown({ raw: {}, stats_events: floatSamples() }),
      }),
    });
    expect(causes.length).toBe(1);
    const cause = causes[0];
    expect(cause.id).toBe("resource_float");
    expect(cause.title).toBe("Unspent resources piled up");
    // Every variant bakes in peak (1400) and/or mean (1000).
    expect(cause.detail).toMatch(/1400|1000/);
    // severity = round(100 * (1000 - 400) / 1200) = 50.
    expect(cause.severityScore).toBe(50);
    // First three >=800 samples, chronological.
    expect(cause.timestamps).toEqual(["4:10", "4:20", "4:30"]);
  });

  it("stays silent when the bank stayed under control", () => {
    const causes = lossAutopsy({
      game: lossGame({
        macroBreakdown: breakdown({
          raw: {},
          stats_events: [
            { time: 250, minerals_current: 300 },
            { time: 260, minerals_current: 350 },
            { time: 270, minerals_current: 250 },
          ],
        }),
      }),
    });
    expect(causes).toEqual([]);
  });

  it("falls back to mineral_float_spikes on slim breakdowns", () => {
    const causes = lossAutopsy({
      game: lossGame({
        macroBreakdown: breakdown({
          raw: { mineral_float_spikes: 5 },
          all_leaks: [
            { name: "Mineral Float", mineral_cost: 750, time: 400 },
          ],
        }),
      }),
    });
    expect(causes.length).toBe(1);
    expect(causes[0].id).toBe("resource_float");
    expect(causes[0].detail).toContain("5");
    // severity = min(100, spikes * 8) = 40.
    expect(causes[0].severityScore).toBe(40);
    expect(causes[0].timestamps).toEqual(["6:40"]);
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — late expansion vs personal median.
// ---------------------------------------------------------------------------

describe("lossAutopsy — late expansion", () => {
  const medians: PersonalMedians = {
    expansionTimings: { Hatchery: 165 },
  };

  it("compares the natural's start time against the personal median", () => {
    const causes = lossAutopsy({
      game: lossGame({
        macroBreakdown: breakdown(),
        buildLog: [
          "[0:00] Hatchery", // starting base — must be skipped
          "[0:17] Overlord",
          "[0:45] SpawningPool",
          "[3:25] Hatchery", // the natural, 205s
        ],
      }),
      personalMedians: medians,
    });
    expect(causes.length).toBe(1);
    const cause = causes[0];
    expect(cause.id).toBe("late_expansion");
    expect(cause.title).toBe("Expanded later than usual");
    // 205 - 165 = 40 seconds late; both variants bake in the delta
    // and both clocks.
    expect(cause.detail).toContain("40");
    expect(cause.detail).toContain("3:25");
    expect(cause.detail).toContain("2:45");
    // severity = round(100 * 40 / 120) = 33.
    expect(cause.severityScore).toBe(33);
    expect(cause.timestamps).toEqual(["3:25"]);
  });

  it("treats the first logged townhall as the natural when the log omits the starting base", () => {
    const causes = lossAutopsy({
      game: lossGame({
        macroBreakdown: breakdown(),
        buildLog: ["[0:17] Overlord", "[3:25] Hatchery"],
      }),
      personalMedians: medians,
    });
    expect(causes.length).toBe(1);
    expect(causes[0].id).toBe("late_expansion");
    expect(causes[0].timestamps).toEqual(["3:25"]);
  });

  it("skips the rule when personalMedians is absent", () => {
    const causes = lossAutopsy({
      game: lossGame({
        macroBreakdown: breakdown(),
        buildLog: ["[0:00] Hatchery", "[5:00] Hatchery"],
      }),
    });
    expect(causes).toEqual([]);
  });

  it("stays silent for ordinary variance (<20s late)", () => {
    const causes = lossAutopsy({
      game: lossGame({
        macroBreakdown: breakdown(),
        buildLog: ["[0:00] Hatchery", "[3:00] Hatchery"], // 180s, 15s late
      }),
      personalMedians: medians,
    });
    expect(causes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rule 4 — production idle (missed injects / chronos / MULEs).
// ---------------------------------------------------------------------------

describe("lossAutopsy — production idle", () => {
  it("fires on missed injects using raw actual/expected", () => {
    const causes = lossAutopsy({
      game: lossGame({
        macroBreakdown: breakdown({
          raw: { injects_actual: 10, injects_expected: 20 },
          all_leaks: [{ name: "Inject Efficiency", mineral_cost: 900 }],
        }),
      }),
    });
    expect(causes.length).toBe(1);
    const cause = causes[0];
    expect(cause.id).toBe("production_idle");
    expect(cause.title).toBe("Missed injects");
    expect(cause.detail).toContain("10");
    expect(cause.detail).toContain("20");
    // severity = round(100 * (1 - 0.5) * 1.3) = 65.
    expect(cause.severityScore).toBe(65);
  });

  it("uses the Protoss chrono fields and title", () => {
    const causes = lossAutopsy({
      game: lossGame({
        macroBreakdown: breakdown({
          race: "Protoss",
          raw: { chronos_actual: 4, chronos_expected: 12 },
        }),
      }),
    });
    expect(causes.length).toBe(1);
    expect(causes[0].title).toBe("Missed chrono boosts");
    expect(causes[0].detail).toContain("12");
  });

  it("stays silent at healthy usage or tiny expected counts", () => {
    // 18/20 = 90% — fine.
    expect(
      lossAutopsy({
        game: lossGame({
          macroBreakdown: breakdown({
            raw: { injects_actual: 18, injects_expected: 20 },
          }),
        }),
      }),
    ).toEqual([]);
    // expected 4 < 5 — sample too small to judge.
    expect(
      lossAutopsy({
        game: lossGame({
          macroBreakdown: breakdown({
            raw: { injects_actual: 0, injects_expected: 4 },
          }),
        }),
      }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rule 5 — one-sided fight (army_value series on both sides).
// ---------------------------------------------------------------------------

describe("lossAutopsy — one-sided fight", () => {
  it("finds the largest one-sided army-value drop", () => {
    const causes = lossAutopsy({
      game: lossGame({
        macroBreakdown: breakdown({
          raw: {},
          stats_events: [
            { time: 300, army_value: 2000 },
            { time: 310, army_value: 2000 },
            { time: 340, army_value: 600 },
          ],
          opp_stats_events: [
            { time: 300, army_value: 1800 },
            { time: 340, army_value: 1600 },
          ],
        }),
      }),
    });
    expect(causes.length).toBe(1);
    const cause = causes[0];
    expect(cause.id).toBe("one_sided_fight");
    expect(cause.title).toBe("Lost a one-sided fight");
    expect(cause.detail).toContain("1400");
    expect(cause.detail).toContain("5:00");
    // severity = round(100 * (1400 - 200) / 2500) = 48.
    expect(cause.severityScore).toBe(48);
    expect(cause.timestamps).toEqual(["5:00", "5:40"]);
  });

  it("stays silent on an even trade", () => {
    const causes = lossAutopsy({
      game: lossGame({
        macroBreakdown: breakdown({
          raw: {},
          stats_events: [
            { time: 300, army_value: 2000 },
            { time: 340, army_value: 600 },
          ],
          opp_stats_events: [
            { time: 300, army_value: 1800 },
            { time: 340, army_value: 500 }, // opponent lost 1300 too
          ],
        }),
      }),
    });
    expect(causes).toEqual([]);
  });

  it("stays silent when army_value is missing (pre-v0.5.11 payloads)", () => {
    const causes = lossAutopsy({
      game: lossGame({
        macroBreakdown: breakdown({
          raw: {},
          stats_events: [
            { time: 300, food_used: 100 },
            { time: 340, food_used: 60 },
          ],
          opp_stats_events: [{ time: 300 }, { time: 340 }],
        }),
      }),
    });
    expect(causes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Ranking + cap.
// ---------------------------------------------------------------------------

describe("lossAutopsy — ranking", () => {
  it("ranks by severity desc and caps at 3 causes", () => {
    const samples: StatsEvent[] = floatSamples().map((s, i) => ({
      ...s,
      // Army collapses 2000 → 1400 across the same window (600 lost).
      army_value: i === 4 ? 1400 : 2000,
    }));
    const causes = lossAutopsy({
      game: lossGame({
        macroBreakdown: breakdown({
          raw: {
            // supply block: severity 55
            supply_block_windows: [
              { start: 210, end: 240, blocked_sec: 25 },
              { start: 300, end: 320, blocked_sec: 16 },
            ],
            // production idle: severity 65
            injects_actual: 10,
            injects_expected: 20,
          },
          // resource float: severity 50 (mean 1000)
          stats_events: samples,
          // one-sided fight: severity 16 (net 400) — fires but is
          // pushed out by the three bigger causes.
          opp_stats_events: [
            { time: 250, army_value: 1800 },
            { time: 290, army_value: 1600 },
          ],
        }),
      }),
    });
    expect(causes.map((c) => c.id)).toEqual([
      "production_idle",
      "supply_block",
      "resource_float",
    ]);
    expect(causes.map((c) => c.severityScore)).toEqual([65, 55, 50]);
  });
});

// ---------------------------------------------------------------------------
// Template determinism.
// ---------------------------------------------------------------------------

describe("lossAutopsy — template determinism", () => {
  it("renders the identical sentence for the same game every time", () => {
    const input = {
      game: lossGame({ macroBreakdown: supplyBlockBreakdown() }),
    };
    const first = lossAutopsy(input);
    const second = lossAutopsy(input);
    expect(second).toEqual(first);
  });

  it("selects the variant by fnv1a(gameId) % variants", () => {
    // Find two game ids that land on different variant indices for the
    // 3-variant supply-block rule — deterministic, no hardcoded hashes.
    const candidates = ["g0", "g1", "g2", "g3", "g4", "g5", "g6", "g7"];
    const byIndex = new Map<number, string>();
    for (const id of candidates) {
      const idx = fnv1a(id) % 3;
      if (!byIndex.has(idx)) byIndex.set(idx, id);
      if (byIndex.size >= 2) break;
    }
    const [idA, idB] = [...byIndex.values()];
    expect(idA).toBeDefined();
    expect(idB).toBeDefined();

    const run = (id: string) =>
      lossAutopsy({
        game: lossGame({ id, macroBreakdown: supplyBlockBreakdown() }),
      })[0];
    const causeA = run(idA);
    const causeB = run(idB);
    // Different variant → different sentence; same facts → same numbers.
    expect(causeA.detail).not.toBe(causeB.detail);
    expect(causeA.detail).toContain("41 seconds");
    expect(causeB.detail).toContain("41 seconds");
    // Severity and timestamps are template-independent.
    expect(causeA.severityScore).toBe(causeB.severityScore);
    expect(causeA.timestamps).toEqual(causeB.timestamps);
    // And each id is itself stable across calls.
    expect(run(idA).detail).toBe(causeA.detail);
    expect(run(idB).detail).toBe(causeB.detail);
  });

  it("handles a missing game id deterministically", () => {
    const input = {
      game: lossGame({ id: null, macroBreakdown: supplyBlockBreakdown() }),
    };
    expect(lossAutopsy(input)).toEqual(lossAutopsy(input));
  });
});
