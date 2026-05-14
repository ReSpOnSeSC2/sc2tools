"use strict";

// ArcadeService integration tests — exercises resolveQuests (window
// scoping, slim/heavy two-pass strategy, error-degrade behavior),
// the isoWeekStart / resolveWindowStart helpers, and unitStats.
//
// Predicate-level behavior is in services/arcadePredicates.test.js.
// The router-level wiring is in routes/arcade.test.js.

const {
  ArcadeService,
  isoWeekStart,
  resolveWindowStart,
} = require("../../src/services/arcade");

const w = (over = {}) => ({
  gameId: "x",
  result: "Win",
  date: new Date().toISOString(),
  ...over,
});
const l = (over = {}) => w({ result: "Loss", ...over });

describe("isoWeekStart / resolveWindowStart", () => {
  // The resolver lower-bounds games-in-window by the card's ISO week,
  // not by card.startedAt. This fixes the user-reported bug where a
  // Win-vs-Protoss game played earlier in the week didn't tick after
  // the bingo card was generated mid-week. These tests pin the
  // ISO-week boundary math + the precedence order.

  test("isoWeekStart returns Monday 00:00 UTC of the named ISO week", () => {
    // 2026-W20 — ISO week containing 2026-05-14 (today). Monday is
    // 2026-05-11.
    expect(isoWeekStart("2026-W20").toISOString()).toBe(
      "2026-05-11T00:00:00.000Z",
    );
    // 2026-W01 contains January 4, 2026 (a Sunday). Monday of that
    // week is 2025-12-29 — the boundary case the ISO week date
    // standard exists to handle.
    expect(isoWeekStart("2026-W01").toISOString()).toBe(
      "2025-12-29T00:00:00.000Z",
    );
    // A "53-week" year — 2020 ISO week 53 starts 2020-12-28.
    expect(isoWeekStart("2020-W53").toISOString()).toBe(
      "2020-12-28T00:00:00.000Z",
    );
  });

  test("isoWeekStart returns null for malformed input", () => {
    // Defensive: callers should be able to fall back to startedAt
    // without first validating the format.
    expect(isoWeekStart("")).toBeNull();
    expect(isoWeekStart("nonsense")).toBeNull();
    expect(isoWeekStart("2026-W00")).toBeNull(); // week 0 doesn't exist
    expect(isoWeekStart("2026-W54")).toBeNull(); // beyond max
    expect(isoWeekStart(null)).toBeNull();
    expect(isoWeekStart(undefined)).toBeNull();
  });

  test("resolveWindowStart prefers weekKey over startedAt", () => {
    // The user-visible source of truth on the card is weekKey. The
    // mid-week startedAt is a side effect of card generation, not the
    // start of "this week" the way the UI labels it.
    const out = resolveWindowStart({
      weekKey: "2026-W20",
      startedAt: "2026-05-13T12:00:00.000Z", // Wednesday
    });
    expect(out.toISOString()).toBe("2026-05-11T00:00:00.000Z"); // Monday
  });

  test("resolveWindowStart falls back to startedAt when weekKey is missing", () => {
    // Test fixtures / very old cards may omit weekKey. Falling back
    // to startedAt keeps them resolvable instead of opening the
    // window to the epoch.
    const out = resolveWindowStart({
      startedAt: "2026-05-13T12:00:00.000Z",
    });
    expect(out.toISOString()).toBe("2026-05-13T12:00:00.000Z");
  });

  test("resolveWindowStart falls back to epoch when both are missing", () => {
    // Last-resort safety: the Mongo $gte still has a Date, just one
    // that captures every game in the user's history. The 500-row
    // limit on the find() keeps a malformed card from scanning the
    // entire collection.
    const out = resolveWindowStart({});
    expect(out.getTime()).toBe(0);
  });
});

describe("ArcadeService.resolveQuests window", () => {
  // Regression guard for the "Win vs Protoss never ticks" bug: the
  // user generated the card on Wednesday but beat Protoss on Monday.
  // The old resolver scoped to card.startedAt, so the Monday game
  // fell outside the window. The fix lower-bounds by the ISO-week
  // start derived from card.weekKey.

  test("scopes the games query by ISO-week start when weekKey is present", async () => {
    let capturedQuery = null;
    const fakeColl = /** @type {any} */ ({
      find: (q) => {
        capturedQuery = q;
        return {
          sort: () => ({
            limit: () => ({
              toArray: async () => [],
            }),
          }),
        };
      },
    });
    const svc = new ArcadeService(
      /** @type {any} */ ({ games: fakeColl }),
      /** @type {any} */ ({ games: null }),
    );
    await svc.resolveQuests("user1", {
      weekKey: "2026-W20",
      // Wednesday — earlier-in-the-week games would be silently
      // dropped under the old window.
      startedAt: "2026-05-13T12:00:00.000Z",
      cells: [{ id: "c1", predicate: "win_vs_race", params: { race: "P" } }],
    });
    expect(capturedQuery).toBeTruthy();
    expect(capturedQuery.date.$gte.toISOString()).toBe(
      "2026-05-11T00:00:00.000Z",
    );
  });

  test("ticks Win vs Protoss when the win predates startedAt but is in the same ISO week", async () => {
    // Full integration check: the predicate finds the game even
    // though it was played BEFORE the card was first opened, because
    // the resolver now scopes by week.
    const svc = new ArcadeService(
      /** @type {any} */ ({
        games: {
          find: () => ({
            sort: () => ({
              limit: () => ({
                toArray: async () => [
                  w({
                    gameId: "monday-pvp",
                    date: "2026-05-11T15:00:00.000Z",
                    opponent: { race: "Protoss" },
                  }),
                ],
              }),
            }),
          }),
        },
      }),
      /** @type {any} */ ({ games: null }),
    );
    const out = await svc.resolveQuests("user1", {
      weekKey: "2026-W20",
      startedAt: "2026-05-13T12:00:00.000Z",
      cells: [
        { id: "c1", predicate: "win_vs_race", params: { race: "P" } },
      ],
    });
    expect(out.resolved).toEqual([
      { id: "c1", ticked: true, gameId: "monday-pvp" },
    ]);
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

describe("ArcadeService.unitStats", () => {
  /**
   * @param {any[]} games
   * @param {Map<string, any>|null} [detailsMap]
   */
  const makeService = (games, detailsMap = null) => {
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

  test("aggregates buildLog unit counts and units_lost across games", async () => {
    const svc = makeService(
      [w({ gameId: "g1" }), w({ gameId: "g2" })],
      new Map([
        [
          "g1",
          {
            buildLog: ["[2:00] Marine", "[2:10] Marine", "[3:00] Marauder"],
            macroBreakdown: { player_stats: { me: { units_lost: 12 } } },
          },
        ],
        [
          "g2",
          {
            buildLog: ["[2:00] Marine", "[3:30] Reaper"],
            macroBreakdown: { player_stats: { me: { units_lost: 8 } } },
          },
        ],
      ]),
    );
    const out = await svc.unitStats("user1");
    expect(out.scannedGames).toBe(2);
    expect(out.builtByUnit.Marine).toBe(3);
    expect(out.builtByUnit.Marauder).toBe(1);
    expect(out.builtByUnit.Reaper).toBe(1);
    expect(out.totalUnitsLost).toBe(20);
    expect(out.lostGames).toBe(2);
  });

  test("filters out structure names so they don't dominate the histogram", async () => {
    // Without the structure filter, Pylons and SCVs would always be
    // the most-built "unit" and the trivia would be deathly boring.
    const svc = makeService(
      [w({ gameId: "g1" })],
      new Map([
        [
          "g1",
          {
            buildLog: [
              "[0:20] Pylon",
              "[0:25] Pylon",
              "[2:00] Zealot",
              "[2:30] Zealot",
            ],
          },
        ],
      ]),
    );
    const out = await svc.unitStats("user1");
    expect(out.builtByUnit.Zealot).toBe(2);
    expect(out.builtByUnit.Pylon).toBeUndefined();
  });

  test("degrades gracefully when gameDetails is missing", async () => {
    const svc = makeService([w({ gameId: "g1" })]);
    const out = await svc.unitStats("user1");
    expect(out.scannedGames).toBe(1);
    expect(out.builtByUnit).toEqual({});
    expect(out.totalUnitsLost).toBe(0);
  });

  test("degrades gracefully when the heavy store throws", async () => {
    const fakeColl = /** @type {any} */ ({
      find: () => ({
        sort: () => ({
          limit: () => ({
            toArray: async () => [w({ gameId: "g1" })],
          }),
        }),
      }),
    });
    const svc = new ArcadeService(
      /** @type {any} */ ({ games: fakeColl }),
      /** @type {any} */ ({
        games: null,
        gameDetails: {
          findMany: async () => {
            throw new Error("simulated heavy-store outage");
          },
        },
      }),
    );
    const out = await svc.unitStats("user1");
    expect(out.scannedGames).toBe(1);
    expect(out.builtByUnit).toEqual({});
    expect(out.totalUnitsLost).toBe(0);
  });

  test("returns the all-zeros payload for a user with no games", async () => {
    const svc = makeService([]);
    const out = await svc.unitStats("user1");
    expect(out).toEqual({
      scannedGames: 0,
      builtByUnit: {},
      totalUnitsLost: 0,
      lostGames: 0,
    });
  });
});
