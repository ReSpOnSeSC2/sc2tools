"use strict";

// Bingo objective resolver tests. Uses the in-memory predicate
// registry rather than the full Mongo path; the resolveQuests method
// is exercised in routes/arcade.test.js.
//
// Field naming: production game rows use the DB-canonical names
// ``durationSec`` and ``macroScore`` (see apps/api/src/validation/
// gameRecord.js). The client-side ``normaliseGame`` (apps/web/.../
// hooks/useArcadeData.ts) lifts them onto the legacy ``duration`` /
// ``macro_score`` aliases the SPA's older code expected. Both shapes
// land in the resolver under different code paths — direct DB reads
// vs. client-roundtripped fixtures — so each duration/macro predicate
// has two tests, one per shape, to pin the dual-field-name tolerance.

const { PREDICATES, ArcadeService } = require("../../src/services/arcade");

const w = (over = {}) => ({
  gameId: "x",
  result: "Win",
  date: new Date().toISOString(),
  ...over,
});
const l = (over = {}) => w({ result: "Loss", ...over });

describe("Bingo PREDICATES", () => {
  test("any_game ticks on the first game", () => {
    expect(PREDICATES.any_game([w({ gameId: "g1" })], {})).toBe("g1");
    expect(PREDICATES.any_game([], {})).toBe(null);
  });

  test("any_win ignores losses", () => {
    expect(
      PREDICATES.any_win([l({ gameId: "1" }), w({ gameId: "2" })], {}),
    ).toBe("2");
  });

  test("win_on_map matches case-insensitively (legacy back-compat)", () => {
    const games = [w({ gameId: "g", map: "Equilibrium" })];
    expect(PREDICATES.win_on_map(games, { map: "equilibrium" })).toBe("g");
    expect(PREDICATES.win_on_map(games, { map: "Frostline" })).toBe(null);
  });

  test("win_as_race + win_vs_race compare on the first letter", () => {
    expect(
      PREDICATES.win_as_race([w({ gameId: "g", myRace: "Protoss" })], { race: "P" }),
    ).toBe("g");
    expect(
      PREDICATES.win_vs_race([w({ gameId: "g", oppRace: "Zerg" })], { race: "Z" }),
    ).toBe("g");
  });

  test("win_vs_race reads nested opponent.race too", () => {
    // Direct DB rows put the opponent race under opponent.race; the
    // client-side normaliser lifts it to oppRace. The predicate must
    // tolerate either, otherwise server-side resolves never tick
    // anything because the slim row only has the nested form.
    expect(
      PREDICATES.win_vs_race(
        [w({ gameId: "g", opponent: { race: "Terran" } })],
        { race: "T" },
      ),
    ).toBe("g");
  });

  test("win_vs_higher_mmr requires a positive diff", () => {
    expect(
      PREDICATES.win_vs_higher_mmr(
        [w({ gameId: "g", myMmr: 4000, opponent: { mmr: 4150 } })],
        { diff: 100 },
      ),
    ).toBe("g");
    expect(
      PREDICATES.win_vs_higher_mmr(
        [w({ gameId: "g", myMmr: 4000, opponent: { mmr: 4050 } })],
        { diff: 100 },
      ),
    ).toBe(null);
  });

  test("win_close_mmr ticks when MMR is within ±delta", () => {
    expect(
      PREDICATES.win_close_mmr(
        [w({ gameId: "g", myMmr: 4000, opponent: { mmr: 4020 } })],
        { delta: 25 },
      ),
    ).toBe("g");
    expect(
      PREDICATES.win_close_mmr(
        [w({ gameId: "g", myMmr: 4000, opponent: { mmr: 4080 } })],
        { delta: 25 },
      ),
    ).toBe(null);
  });

  test("win_streak_n finds the Nth consecutive win", () => {
    expect(
      PREDICATES.win_streak_n(
        [l({ gameId: "1" }), w({ gameId: "2" }), w({ gameId: "3" }), w({ gameId: "4" })],
        { n: 3 },
      ),
    ).toBe("4");
    expect(
      PREDICATES.win_streak_n(
        [w({ gameId: "1" }), w({ gameId: "2" }), l({ gameId: "3" }), w({ gameId: "4" })],
        { n: 3 },
      ),
    ).toBe(null);
    // n=5 with only 4 wins available — must not match.
    expect(
      PREDICATES.win_streak_n(
        [w({ gameId: "1" }), w({ gameId: "2" }), w({ gameId: "3" }), w({ gameId: "4" })],
        { n: 5 },
      ),
    ).toBe(null);
  });

  test("three_in_a_row_win delegates to win_streak_n(3) (legacy alias)", () => {
    // Existing cards persisted under the v1 schema reference the old
    // predicate name; the resolver must still tick them.
    expect(
      PREDICATES.three_in_a_row_win(
        [w({ gameId: "1" }), w({ gameId: "2" }), w({ gameId: "3" })],
        {},
      ),
    ).toBe("3");
  });

  test("win_under_seconds reads durationSec (DB-canonical) AND duration (legacy)", () => {
    // DB-canonical field name — slim row direct from Mongo.
    expect(
      PREDICATES.win_under_seconds(
        [w({ gameId: "db", durationSec: 240 })],
        { maxSec: 360 },
      ),
    ).toBe("db");
    // Legacy field name — fixture created by normaliseGame.
    expect(
      PREDICATES.win_under_seconds(
        [w({ gameId: "leg", duration: 240 })],
        { maxSec: 360 },
      ),
    ).toBe("leg");
    // Past the cap → no tick. This was the silent failure before the
    // dual-field-name fix: durationSec rows were read as `g.duration`
    // (undefined → NaN → never less than the cap) and "Win under 6m"
    // cells never ticked even for sub-minute wins.
    expect(
      PREDICATES.win_under_seconds(
        [w({ gameId: "g", durationSec: 600 })],
        { maxSec: 360 },
      ),
    ).toBe(null);
  });

  test("win_over_seconds is inclusive at the floor (>=, not >)", () => {
    expect(
      PREDICATES.win_over_seconds(
        [w({ gameId: "exact", durationSec: 1500 })],
        { minSec: 1500 },
      ),
    ).toBe("exact");
    expect(
      PREDICATES.win_over_seconds(
        [w({ gameId: "under", durationSec: 1499 })],
        { minSec: 1500 },
      ),
    ).toBe(null);
  });

  test("win_as_race_under requires race AND duration", () => {
    expect(
      PREDICATES.win_as_race_under(
        [
          w({ gameId: "ok", myRace: "Zerg", durationSec: 300 }),
        ],
        { race: "Z", maxSec: 480 },
      ),
    ).toBe("ok");
    // Right race, wrong duration.
    expect(
      PREDICATES.win_as_race_under(
        [w({ gameId: "slow", myRace: "Zerg", durationSec: 900 })],
        { race: "Z", maxSec: 480 },
      ),
    ).toBe(null);
    // Right duration, wrong race.
    expect(
      PREDICATES.win_as_race_under(
        [w({ gameId: "wrong", myRace: "Protoss", durationSec: 300 })],
        { race: "Z", maxSec: 480 },
      ),
    ).toBe(null);
  });

  test("win_vs_race_over requires opponent race AND duration", () => {
    expect(
      PREDICATES.win_vs_race_over(
        [w({ gameId: "ok", opponent: { race: "Terran" }, durationSec: 1500 })],
        { race: "T", minSec: 1200 },
      ),
    ).toBe("ok");
    expect(
      PREDICATES.win_vs_race_over(
        [w({ gameId: "short", opponent: { race: "Terran" }, durationSec: 600 })],
        { race: "T", minSec: 1200 },
      ),
    ).toBe(null);
  });

  test("macro_above is INCLUSIVE at the threshold (the >= fix)", () => {
    // The previous strict-> comparison was the user-visible bug — a
    // macro score of exactly 70 wouldn't tick "Hit macro score 70+"
    // even though the label says 70 should count.
    expect(
      PREDICATES.macro_above([w({ gameId: "exact", macroScore: 70 })], { minScore: 70 }),
    ).toBe("exact");
    expect(
      PREDICATES.macro_above([w({ gameId: "over", macroScore: 80 })], { minScore: 70 }),
    ).toBe("over");
    expect(
      PREDICATES.macro_above([w({ gameId: "under", macroScore: 69 })], { minScore: 70 }),
    ).toBe(null);
  });

  test("macro_above reads macroScore (DB-canonical) AND macro_score (legacy)", () => {
    // DB rows from Mongo use ``macroScore`` (see gameRecord.js
    // schema). The previous predicate only checked ``macro_score``
    // — every production row failed silently. Both must tick now.
    expect(
      PREDICATES.macro_above([w({ gameId: "db", macroScore: 75 })], { minScore: 70 }),
    ).toBe("db");
    expect(
      PREDICATES.macro_above([w({ gameId: "leg", macro_score: 75 })], { minScore: 70 }),
    ).toBe("leg");
  });

  test("win_macro_below requires both a win AND a low macro score", () => {
    expect(
      PREDICATES.win_macro_below(
        [w({ gameId: "ok", macroScore: 30 })],
        { maxScore: 40 },
      ),
    ).toBe("ok");
    // Same macro but loss → must not tick.
    expect(
      PREDICATES.win_macro_below(
        [l({ gameId: "loss", macroScore: 30 })],
        { maxScore: 40 },
      ),
    ).toBe(null);
  });

  test("win_apm_above gates wins by APM", () => {
    expect(
      PREDICATES.win_apm_above([w({ gameId: "g", apm: 250 })], { minApm: 200 }),
    ).toBe("g");
    expect(
      PREDICATES.win_apm_above([w({ gameId: "slow", apm: 80 })], { minApm: 200 }),
    ).toBe(null);
  });

  test("win_build_contains matches myBuild case-insensitively", () => {
    expect(
      PREDICATES.win_build_contains(
        [w({ gameId: "g", myBuild: "Protoss - Cannon Rush" })],
        { keyword: "cannon rush" },
      ),
    ).toBe("g");
    expect(
      PREDICATES.win_build_contains(
        [w({ gameId: "g", myBuild: "Zerg - Macro Hatch" })],
        { keyword: "Cannon" },
      ),
    ).toBe(null);
    // Empty keyword params returns null instead of matching everything.
    expect(
      PREDICATES.win_build_contains(
        [w({ gameId: "g", myBuild: "Anything" })],
        { keyword: "" },
      ),
    ).toBe(null);
  });

  test("win_vs_strategy_contains matches opponent.strategy AND opp_strategy", () => {
    // Modern path — nested opponent.strategy.
    expect(
      PREDICATES.win_vs_strategy_contains(
        [w({ gameId: "g", opponent: { strategy: "Zerg - Cheese Pool" } })],
        { keyword: "cheese" },
      ),
    ).toBe("g");
    // Legacy top-level alias.
    expect(
      PREDICATES.win_vs_strategy_contains(
        [w({ gameId: "g2", opp_strategy: "Terran - Proxy Rax All-in" })],
        { keyword: "proxy" },
      ),
    ).toBe("g2");
  });

  test("play_n_games / win_n_games gate on count thresholds", () => {
    const games = [w({ gameId: "1" }), l({ gameId: "2" }), w({ gameId: "3" })];
    expect(PREDICATES.play_n_games(games, { n: 3 })).toBe("3");
    expect(PREDICATES.play_n_games(games, { n: 4 })).toBe(null);
    expect(PREDICATES.win_n_games(games, { n: 2 })).toBe("3");
    expect(PREDICATES.win_n_games(games, { n: 3 })).toBe(null);
  });

  test("win_after_loss requires a loss-then-win sequence", () => {
    expect(
      PREDICATES.win_after_loss(
        [w({ gameId: "1" }), l({ gameId: "2" }), w({ gameId: "3" })],
        {},
      ),
    ).toBe("3");
    // No losses → no bounce-back is possible.
    expect(
      PREDICATES.win_after_loss(
        [w({ gameId: "1" }), w({ gameId: "2" }), w({ gameId: "3" })],
        {},
      ),
    ).toBe(null);
  });

  test("revenge_win requires a prior loss to the same opponent", () => {
    expect(
      PREDICATES.revenge_win(
        [
          l({ gameId: "1", oppPulseId: "A" }),
          w({ gameId: "2", oppPulseId: "B" }),
          w({ gameId: "3", oppPulseId: "A" }),
        ],
        {},
      ),
    ).toBe("3");
    // Same opponent never beat the user — no revenge available.
    expect(
      PREDICATES.revenge_win(
        [
          w({ gameId: "1", oppPulseId: "A" }),
          w({ gameId: "2", oppPulseId: "A" }),
        ],
        {},
      ),
    ).toBe(null);
  });

  test("win_in_long_session needs N wins in one 4h window before another win", () => {
    const t0 = Date.parse("2026-05-11T10:00:00Z");
    const games = [
      // First session: three wins inside 30 min — the third one ticks.
      w({ gameId: "1", date: new Date(t0).toISOString() }),
      w({ gameId: "2", date: new Date(t0 + 10 * 60 * 1000).toISOString() }),
      w({ gameId: "3", date: new Date(t0 + 20 * 60 * 1000).toISOString() }),
    ];
    expect(
      PREDICATES.win_in_long_session(games, { minWinsBefore: 2 }),
    ).toBe("3");
    // Same three games but with a 5h gap between #2 and #3 → session
    // resets, third win is "1st of new session", no tick.
    const split = [
      w({ gameId: "1", date: new Date(t0).toISOString() }),
      w({ gameId: "2", date: new Date(t0 + 10 * 60 * 1000).toISOString() }),
      w({ gameId: "3", date: new Date(t0 + 5 * 60 * 60 * 1000).toISOString() }),
    ];
    expect(
      PREDICATES.win_in_long_session(split, { minWinsBefore: 2 }),
    ).toBe(null);
  });

  test("won_with_unit scans the build log", () => {
    expect(
      PREDICATES.won_with_unit(
        [w({ gameId: "g", buildLog: ["[5:00] Pylon", "[12:30] Mothership"] })],
        { unit: "Mothership" },
      ),
    ).toBe("g");
    expect(
      PREDICATES.won_with_unit(
        [w({ gameId: "g", buildLog: ["[5:00] Pylon"] })],
        { unit: "Mothership" },
      ),
    ).toBe(null);
    // Empty buildLog (no game_details loaded) → no tick, no throw.
    expect(
      PREDICATES.won_with_unit(
        [w({ gameId: "g" })],
        { unit: "Mothership" },
      ),
    ).toBe(null);
  });

  test("won_built_n_of_unit gates on match count", () => {
    const log = ["[2:00] Marine", "[2:30] Marine", "[3:00] Marine"];
    expect(
      PREDICATES.won_built_n_of_unit(
        [w({ gameId: "g", buildLog: log })],
        { unit: "Marine", count: 3 },
      ),
    ).toBe("g");
    expect(
      PREDICATES.won_built_n_of_unit(
        [w({ gameId: "g", buildLog: log })],
        { unit: "Marine", count: 4 },
      ),
    ).toBe(null);
  });

  test("won_built_opp_unit_seen scans the opponent's build log", () => {
    expect(
      PREDICATES.won_built_opp_unit_seen(
        [w({ gameId: "g", oppBuildLog: ["[10:00] Battlecruiser"] })],
        { unit: "Battlecruiser" },
      ),
    ).toBe("g");
  });
});

describe("ArcadeService.resolveQuests card shape", () => {
  // Regression guard: the client BingoState ships `card.cells`, not
  // `card.objectives`. A prior version of the resolver checked the
  // wrong field and silently returned an empty array for every call,
  // so Bingo cells never ticked even when the user satisfied them.
  // These tests pin the contract to the client shape.

  /**
   * @param {any[]} [games]
   * @param {Map<string, any>|null} [detailsMap]
   */
  const makeService = (games = [], detailsMap = null) => {
    const fakeColl = /** @type {any} */ ({
      find: () => ({
        sort: () => ({
          limit: () => ({
            toArray: async () => games,
          }),
        }),
      }),
    });
    /** @type {any} */
    const deps = { games: null };
    if (detailsMap) {
      deps.gameDetails = {
        findMany: async () => detailsMap,
      };
    }
    return new ArcadeService(
      /** @type {any} */ ({ games: fakeColl }),
      deps,
    );
  };

  test("ticks a cell when the predicate matches", async () => {
    const svc = makeService([
      w({ gameId: "g1", myRace: "Protoss" }),
    ]);
    const card = {
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      cells: [
        { id: "c1", predicate: "win_as_race", params: { race: "P" } },
        { id: "c2", predicate: "win_as_race", params: { race: "Z" } },
      ],
    };
    const out = await svc.resolveQuests("user1", card);
    expect(out.resolved).toEqual([
      { id: "c1", ticked: true, gameId: "g1" },
      { id: "c2", ticked: false },
    ]);
  });

  test("returns empty resolved array when card.cells is missing", async () => {
    const svc = makeService([w({ gameId: "g1" })]);
    const out = await svc.resolveQuests("user1", /** @type {any} */ ({
      startedAt: new Date().toISOString(),
    }));
    expect(out.resolved).toEqual([]);
  });

  test("unknown predicate keys produce a non-ticked entry, not a throw", async () => {
    const svc = makeService([w({ gameId: "g1" })]);
    const out = await svc.resolveQuests("user1", {
      startedAt: new Date().toISOString(),
      cells: [{ id: "c1", predicate: "not_a_real_predicate" }],
    });
    expect(out.resolved).toEqual([{ id: "c1", ticked: false }]);
  });

  test("heavy predicate fetches game_details lazily and ticks on match", async () => {
    // The slim row only carries gameId+date+result; the buildLog
    // lives in game_details. The resolver must bulk-load details
    // and merge them onto the slim rows before running the
    // won_with_unit predicate, otherwise the cell stays un-ticked.
    const detailsMap = new Map([
      ["g1", { buildLog: ["[5:00] Pylon", "[10:00] Mothership"] }],
    ]);
    const svc = makeService([w({ gameId: "g1" })], detailsMap);
    const out = await svc.resolveQuests("user1", {
      startedAt: new Date().toISOString(),
      cells: [
        { id: "c1", predicate: "won_with_unit", params: { unit: "Mothership" } },
        { id: "c2", predicate: "won_with_unit", params: { unit: "Carrier" } },
      ],
    });
    expect(out.resolved).toEqual([
      { id: "c1", ticked: true, gameId: "g1" },
      { id: "c2", ticked: false },
    ]);
  });

  test("heavy predicate degrades to false when game_details is missing", async () => {
    // Either the GameDetailsService is not wired (test harness) or
    // the heavy store throws — either way the slim-row results
    // must still resolve. The heavy cell stays un-ticked.
    const svc = makeService([w({ gameId: "g1", myRace: "Zerg" })]);
    const out = await svc.resolveQuests("user1", {
      startedAt: new Date().toISOString(),
      cells: [
        { id: "c1", predicate: "win_as_race", params: { race: "Z" } },
        { id: "c2", predicate: "won_with_unit", params: { unit: "Mothership" } },
      ],
    });
    expect(out.resolved).toEqual([
      { id: "c1", ticked: true, gameId: "g1" },
      { id: "c2", ticked: false },
    ]);
  });

  test("heavy-store failure must not erase slim-row ticks", async () => {
    // Pathological: gameDetails.findMany throws. The resolver should
    // still return slim-row ticks instead of bubbling. We assert that
    // the previously-resolved slim cells stay ticked.
    const svc = new ArcadeService(
      /** @type {any} */ ({
        games: {
          find: () => ({
            sort: () => ({
              limit: () => ({
                toArray: async () => [w({ gameId: "g1", myRace: "Protoss" })],
              }),
            }),
          }),
        },
      }),
      /** @type {any} */ ({
        games: null,
        gameDetails: {
          findMany: async () => {
            throw new Error("simulated heavy-store outage");
          },
        },
      }),
    );
    const out = await svc.resolveQuests("user1", {
      startedAt: new Date().toISOString(),
      cells: [
        { id: "c1", predicate: "win_as_race", params: { race: "P" } },
        { id: "c2", predicate: "won_with_unit", params: { unit: "Mothership" } },
      ],
    });
    expect(out.resolved).toEqual([
      { id: "c1", ticked: true, gameId: "g1" },
      { id: "c2", ticked: false },
    ]);
  });
});
