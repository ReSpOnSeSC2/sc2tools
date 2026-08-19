"use strict";

const { validateGameRecord } = require("../src/validation/gameRecord");

describe("validateGameRecord", () => {
  test("validates in place instead of cloning heavy replay payloads", () => {
    const raw = {
      gameId: "memory-bounded",
      date: "2026-05-04T12:00:00.000Z",
      result: "Victory",
      myRace: "Protoss",
      map: "Goldenaura",
      buildLog: ["[0:00] Nexus"],
    };
    const r = validateGameRecord(raw);
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.value).toBe(raw);
  });

  test("accepts a minimal real-shaped record", () => {
    const r = validateGameRecord({
      gameId: "abc-123",
      date: "2026-05-04T12:00:00.000Z",
      result: "Victory",
      myRace: "Protoss",
      map: "Goldenaura",
    });
    expect(r.valid).toBe(true);
  });

  test("fails fast without retaining one error per invalid heavy-array item", () => {
    const r = validateGameRecord({
      gameId: "bounded-validation-errors",
      date: "2026-05-04T12:00:00.000Z",
      result: "Victory",
      myRace: "Protoss",
      map: "Goldenaura",
      buildLog: Array.from({ length: 5000 }, () => 123),
      oppBuildLog: Array.from({ length: 5000 }, () => ({ invalid: true })),
    });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.errors.length).toBeLessThanOrEqual(1);
  });

  test.each([
    { top3Leaks: [{ name: "X".repeat(121) }] },
    { top3Leaks: Array.from({ length: 4 }, () => ({ name: "Supply block" })) },
    { duration: { giant: true } },
    { macro_score: { giant: true } },
    { oppMmr: { giant: true } },
    { oppPulseId: { giant: true } },
    { oppRace: { giant: true } },
    { opp_strategy: { giant: true } },
  ])("rejects an unbounded allow-listed slim value", (extra) => {
    const r = validateGameRecord({
      gameId: "bounded-slim-alias",
      date: "2026-05-04T12:00:00.000Z",
      result: "Victory",
      myRace: "Protoss",
      map: "Goldenaura",
      ...extra,
    });
    expect(r.valid).toBe(false);
  });

  test("accepts unit timeline side maps at the memory-safety boundaries", () => {
    const my = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [
      `SyntheticUnit${String(i).padStart(3, "0")}`,
      1,
    ]));
    my["X".repeat(64)] = 1;
    delete my.SyntheticUnit000;
    const r = validateGameRecord({
      gameId: "timeline-boundary",
      date: "2026-05-04T12:00:00.000Z",
      result: "Victory",
      myRace: "Protoss",
      map: "Goldenaura",
      macroBreakdown: {
        unit_timeline: [{ time: 100, my, opp: { Stalker: 4 } }],
      },
    });
    expect(r.valid).toBe(true);
  });

  test.each([
    { ["X".repeat(65)]: 1 },
    Object.fromEntries(Array.from({ length: 257 }, (_, i) => [
      `SyntheticUnit${String(i).padStart(3, "0")}`,
      1,
    ])),
  ])("rejects an unbounded unit timeline side map", (my) => {
    const r = validateGameRecord({
      gameId: "timeline-unbounded",
      date: "2026-05-04T12:00:00.000Z",
      result: "Victory",
      myRace: "Protoss",
      map: "Goldenaura",
      macroBreakdown: { unit_timeline: [{ time: 100, my, opp: {} }] },
    });
    expect(r.valid).toBe(false);
  });

  test("bounds every uploaded build-log line", () => {
    const base = {
      gameId: "bounded-log-line",
      date: "2026-05-04T12:00:00.000Z",
      result: "Victory",
      myRace: "Protoss",
      map: "Goldenaura",
    };
    expect(validateGameRecord({
      ...base,
      buildLog: ["X".repeat(256)],
      earlyBuildLog: ["X".repeat(256)],
      oppBuildLog: ["X".repeat(256)],
      oppEarlyBuildLog: ["X".repeat(256)],
    }).valid).toBe(true);
    for (const field of [
      "buildLog", "earlyBuildLog", "oppBuildLog", "oppEarlyBuildLog",
    ]) {
      expect(validateGameRecord({
        ...base,
        [field]: ["X".repeat(257)],
      }).valid).toBe(false);
    }
  });

  test("accepts a bounded resume marker with unique game-id aliases", () => {
    const r = validateGameRecord({
      gameId: "resume-3",
      date: "2026-08-10T03:57:19.000Z",
      result: "Victory",
      myRace: "Zerg",
      map: "Old Sun Temple LE",
      isResumedFromReplay: true,
      resumedReplayGameIds: ["resume-1", "resume-2"],
    });
    expect(r.valid).toBe(true);
  });

  test.each([
    { isResumedFromReplay: "true" },
    { resumedReplayGameIds: ["same", "same"] },
    { resumedReplayGameIds: Array.from({ length: 51 }, (_, i) => `g-${i}`) },
    { resumedReplayGameIds: [""] },
  ])("rejects malformed resume marker fields: %j", (fields) => {
    const r = validateGameRecord({
      gameId: "resume-invalid",
      date: "2026-08-10T03:57:19.000Z",
      result: "Victory",
      myRace: "Zerg",
      map: "Old Sun Temple LE",
      ...fields,
    });
    expect(r.valid).toBe(false);
  });

  test.each(["1v1", "team", "ffa", "other"])(
    "accepts and preserves matchFormat=%s",
    (matchFormat) => {
      const r = validateGameRecord({
        gameId: `format-${matchFormat}`,
        date: "2026-05-04T12:00:00.000Z",
        result: "Victory",
        myRace: "Protoss",
        map: "Goldenaura",
        matchFormat,
      });
      expect(r.valid).toBe(true);
      if (r.valid) {
        expect(/** @type {any} */ (r.value).matchFormat).toBe(matchFormat);
      }
    },
  );

  test("rejects an unknown matchFormat", () => {
    const r = validateGameRecord({
      gameId: "format-unknown",
      date: "2026-05-04T12:00:00.000Z",
      result: "Victory",
      myRace: "Protoss",
      map: "Goldenaura",
      matchFormat: "8-player",
    });
    expect(r.valid).toBe(false);
  });

  test("accepts and preserves an optional selected ladder race", () => {
    const r = validateGameRecord({
      gameId: "abc-123",
      date: "2026-05-04T12:00:00.000Z",
      result: "Victory",
      myRace: "Protoss",
      myLadderRace: "Random",
      map: "Goldenaura",
    });
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(/** @type {any} */ (r.value).myLadderRace).toBe("Random");
    }
  });

  test("rejects a non-string selected ladder race", () => {
    const r = validateGameRecord({
      gameId: "abc-123",
      date: "2026-05-04T12:00:00.000Z",
      result: "Victory",
      myRace: "Protoss",
      myLadderRace: true,
      map: "Goldenaura",
    });
    expect(r.valid).toBe(false);
  });

  test("rejects bad result enum", () => {
    const r = validateGameRecord({
      gameId: "abc-123",
      date: "2026-05-04T12:00:00.000Z",
      result: "Win",
      myRace: "Protoss",
      map: "Goldenaura",
    });
    expect(r.valid).toBe(false);
  });

  test("rejects missing gameId", () => {
    const r = validateGameRecord({
      date: "2026-05-04T12:00:00.000Z",
      result: "Victory",
      myRace: "Protoss",
      map: "Goldenaura",
    });
    expect(r.valid).toBe(false);
  });

  test("rejects non-ISO date", () => {
    const r = validateGameRecord({
      gameId: "abc-123",
      date: "May 4 2026",
      result: "Victory",
      myRace: "Protoss",
      map: "Goldenaura",
    });
    expect(r.valid).toBe(false);
  });

  test("accepts and preserves an optional exact replay start time", () => {
    const r = validateGameRecord({
      gameId: "abc-123",
      date: "2026-05-04T12:00:00.000Z",
      startedAt: "2026-05-04T11:50:00.000Z",
      result: "Victory",
      myRace: "Protoss",
      map: "Goldenaura",
    });
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(/** @type {any} */ (r.value).startedAt).toBe(
        "2026-05-04T11:50:00.000Z",
      );
    }
  });

  test("rejects a non-ISO replay start time", () => {
    const r = validateGameRecord({
      gameId: "abc-123",
      date: "2026-05-04T12:00:00.000Z",
      startedAt: "ten minutes ago",
      result: "Victory",
      myRace: "Protoss",
      map: "Goldenaura",
    });
    expect(r.valid).toBe(false);
  });

  test("accepts and preserves replay game version/build provenance", () => {
    const r = validateGameRecord({
      gameId: "abc-123",
      date: "2026-07-01T12:00:00.000Z",
      result: "Victory",
      myRace: "Protoss",
      map: "Goldenaura",
      gameVersion: "5.0.16.97425",
      gameBuild: 97425,
    });
    expect(r.valid).toBe(true);
    if (r.valid) {
      const value = /** @type {any} */ (r.value);
      expect(value.gameVersion).toBe("5.0.16.97425");
      expect(value.gameBuild).toBe(97425);
    }
  });

  test.each([
    { gameVersion: "5.0.16" },
    { gameVersion: "5.0.16-beta.97425" },
    { gameBuild: "97425" },
    { gameBuild: 0 },
  ])("rejects malformed replay version/build provenance: %j", (fields) => {
    const r = validateGameRecord({
      gameId: "abc-123",
      date: "2026-07-01T12:00:00.000Z",
      result: "Victory",
      myRace: "Protoss",
      map: "Goldenaura",
      ...fields,
    });
    expect(r.valid).toBe(false);
  });

  test.each([
    ["replay", 5378],
    ["unavailable", undefined],
  ])("accepts myMmrSource=%s", (myMmrSource, myMmr) => {
    const raw = /** @type {any} */ ({
      gameId: "abc-123",
      date: "2026-05-04T12:00:00.000Z",
      result: "Victory",
      myRace: "Protoss",
      map: "Goldenaura",
      myMmrSource,
    });
    if (myMmr !== undefined) raw.myMmr = myMmr;
    const r = validateGameRecord(raw);
    expect(r.valid).toBe(true);
  });

  test("rejects an unknown myMmrSource", () => {
    const r = validateGameRecord({
      gameId: "abc-123",
      date: "2026-05-04T12:00:00.000Z",
      result: "Victory",
      myRace: "Protoss",
      map: "Goldenaura",
      myMmrSource: "pulse_current",
    });
    expect(r.valid).toBe(false);
  });

  test.each([
    { myMmrSource: "replay" },
    { myMmrSource: "unavailable", myMmr: 5378 },
  ])("rejects contradictory MMR provenance: %j", (mmrFields) => {
    const r = validateGameRecord({
      gameId: "abc-123",
      date: "2026-05-04T12:00:00.000Z",
      result: "Victory",
      myRace: "Protoss",
      map: "Goldenaura",
      ...mmrFields,
    });
    expect(r.valid).toBe(false);
  });

  test("accepts opponent block when present", () => {
    const r = validateGameRecord({
      gameId: "abc-123",
      date: "2026-05-04T12:00:00.000Z",
      result: "Defeat",
      myRace: "Zerg",
      map: "Site Delta",
      opponent: {
        pulseId: "1234",
        displayName: "Foo#1",
        race: "Protoss",
        mmr: 4500,
        opening: "Pool first",
      },
    });
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(/** @type {any} */ (r.value).opponent.mmr).toBe(4500);
    }
  });

  test("accepts toonHandle and pulseCharacterId on opponent", () => {
    const r = validateGameRecord({
      gameId: "abc-123",
      date: "2026-05-04T12:00:00.000Z",
      result: "Victory",
      myRace: "Protoss",
      map: "Goldenaura",
      opponent: {
        pulseId: "1-S2-1-716965",
        toonHandle: "1-S2-1-716965",
        pulseCharacterId: "994428",
        displayName: "BrenMcBash",
        race: "Terran",
      },
    });
    expect(r.valid).toBe(true);
    if (r.valid) {
      const opp = /** @type {any} */ (r.value).opponent;
      expect(opp.toonHandle).toBe("1-S2-1-716965");
      expect(opp.pulseCharacterId).toBe("994428");
    }
  });

  test.each([true, false])(
    "accepts opponent.mmrLookupAttempted=%s",
    (mmrLookupAttempted) => {
      const r = validateGameRecord({
        gameId: "abc-123",
        date: "2026-05-04T12:00:00.000Z",
        result: "Victory",
        myRace: "Protoss",
        map: "Goldenaura",
        opponent: {
          pulseCharacterId: "994428",
          race: "Terran",
          mmrLookupAttempted,
        },
      });
      expect(r.valid).toBe(true);
      if (r.valid) {
        expect(/** @type {any} */ (r.value).opponent.mmrLookupAttempted).toBe(
          mmrLookupAttempted,
        );
      }
    },
  );

  test("rejects a non-boolean opponent.mmrLookupAttempted", () => {
    const r = validateGameRecord({
      gameId: "abc-123",
      date: "2026-05-04T12:00:00.000Z",
      result: "Victory",
      myRace: "Protoss",
      map: "Goldenaura",
      opponent: {
        pulseCharacterId: "994428",
        race: "Terran",
        mmrLookupAttempted: "true",
      },
    });
    expect(r.valid).toBe(false);
  });

  test("rejects non-numeric pulseCharacterId", () => {
    const r = validateGameRecord({
      gameId: "abc-123",
      date: "2026-05-04T12:00:00.000Z",
      result: "Victory",
      myRace: "Protoss",
      map: "Goldenaura",
      opponent: {
        pulseId: "1-S2-1-716965",
        pulseCharacterId: "not-a-number",
        displayName: "x",
        race: "Terran",
      },
    });
    expect(r.valid).toBe(false);
  });

  // Locks down the shape the agent v0.4.0+ ships on every replay
  // upload. Without these passing through, the SPA's MacroBreakdown
  // drilldown and dual-build timeline render their empty states
  // ("Macro breakdown not available" / "No opponent build extracted
  // yet") even on freshly uploaded games, because the cloud doesn't
  // store the .SC2Replay binary and can't recompute later.
  test("preserves macroBreakdown + oppBuildLog from a v0.4 agent payload", () => {
    const r = validateGameRecord({
      gameId: "2026-05-06T17:48:32|Hunter|White Rabbit LE|522",
      date: "2026-05-06T17:48:32Z",
      result: "Victory",
      myRace: "Protoss",
      map: "White Rabbit LE",
      durationSec: 522,
      myBuild: "PvP - AlphaStar (4 Adept/Oracle)",
      macroScore: 78,
      apm: 200,
      spq: 80,
      opponent: {
        displayName: "Hunter",
        race: "P",
        toonHandle: "1-S2-2-690921",
        pulseId: "1-S2-2-690921",
        strategy: "Protoss - Standard Expand",
      },
      buildLog: ["[0:00] Nexus", "[0:26] Pylon", "[0:53] Gateway"],
      earlyBuildLog: ["[0:00] Nexus", "[0:26] Pylon"],
      oppBuildLog: [
        "[0:00] Nexus",
        "[0:30] Pylon",
        "[2:00] Gateway",
        "[3:30] RoboticsFacility",
      ],
      oppEarlyBuildLog: ["[0:00] Nexus", "[0:30] Pylon"],
      macroBreakdown: {
        raw: { sq: 80, base_score: 75 },
        all_leaks: [
          { name: "Chrono", detail: "5/8", penalty: 2, mineral_cost: 200 },
        ],
        top_3_leaks: [
          { name: "Chrono", detail: "5/8", penalty: 2, mineral_cost: 200 },
        ],
        stats_events: [
          { time: 0, food_used: 12, minerals_current: 50 },
          { time: 60, food_used: 22, minerals_current: 250 },
        ],
        opp_stats_events: [{ time: 0, food_used: 12 }],
      },
      apmCurve: {
        window_sec: 30,
        has_data: true,
        players: [
          { pid: 1, name: "Me", race: "Protoss", samples: [] },
          { pid: 2, name: "Opp", race: "Zerg", samples: [] },
        ],
      },
      // Exercises the additionalProperties: true escape hatch — newer
      // agents may add fields (e.g. spatial extracts for Map Intel)
      // that weren't in the schema when an older API was deployed.
      // These must pass through unchanged.
      spatial: {
        map_bounds: { minX: 0, minY: 0, maxX: 200, maxY: 200 },
        buildings: [{ x: 100, y: 100 }],
      },
    });
    expect(r.valid).toBe(true);
    if (r.valid) {
      const v = /** @type {any} */ (r.value);
      expect(Array.isArray(v.oppBuildLog)).toBe(true);
      expect(v.oppBuildLog.length).toBe(4);
      expect(v.macroBreakdown).toBeDefined();
      expect(v.macroBreakdown.top_3_leaks.length).toBe(1);
      expect(v.macroBreakdown.stats_events.length).toBe(2);
      expect(v.apmCurve.has_data).toBe(true);
      // Forward-compat: spatial isn't in the schema yet but must
      // round-trip via additionalProperties: true.
      expect(v.spatial.map_bounds.maxX).toBe(200);
    }
  });
});

/** @param {any} mapPlayback */
const withPlayback = (mapPlayback) => ({
  gameId: "casts-1",
  date: "2026-05-04T12:00:00.000Z",
  result: "Victory",
  myRace: "Protoss",
  map: "Goldenaura",
  mapPlayback,
});

const BASE_PLAYBACK = {
  v: 5,
  mapName: "Goldenaura",
  gameLength: 900,
  bounds: { minX: 0, minY: 0, maxX: 200, maxY: 200 },
  spawns: [],
  battles: [],
  buildings: [],
  units: [],
  resources: [],
  stats: { me: [], opp: [] },
};

describe("validateGameRecord — mapPlayback casts (v5)", () => {
  test("accepts a v5 payload carrying casts", () => {
    const r = validateGameRecord(
      withPlayback({
        ...BASE_PLAYBACK,
        casts: [
          { o: 0, a: "PsiStorm", t: 301.4, x: 100.1, y: 90.2 },
          { o: 1, a: "FungalGrowth", t: 305, x: 101, y: 91 },
          // Self-cast the engine could not place: x/y omitted entirely.
          { o: 0, a: "Stim", t: 310 },
        ],
      }),
    );
    expect(r.valid).toBe(true);
    if (r.valid) {
      const v = /** @type {any} */ (r.value);
      expect(v.mapPlayback.casts.length).toBe(3);
      expect(v.mapPlayback.casts[2].x).toBeUndefined();
    }
  });

  test("casts stay optional — v4 and older payloads are untouched", () => {
    // The API has no recompute path, so almost every stored game will
    // never gain a casts array. Absence must remain valid forever.
    const r = validateGameRecord(withPlayback({ ...BASE_PLAYBACK, v: 4 }));
    expect(r.valid).toBe(true);
  });

  test("rejects casts with the wrong field types", () => {
    const r = validateGameRecord(
      withPlayback({ ...BASE_PLAYBACK, casts: [{ o: "me", a: "PsiStorm", t: 5 }] }),
    );
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.errors.join(" ")).toMatch(/casts/);
  });

  test("bounds the casts array", () => {
    const tooMany = Array.from({ length: 801 }, () => ({
      o: 0,
      a: "ChronoBoost",
      t: 1,
    }));
    const r = validateGameRecord(withPlayback({ ...BASE_PLAYBACK, casts: tooMany }));
    expect(r.valid).toBe(false);

    const atCap = Array.from({ length: 800 }, () => ({
      o: 0,
      a: "ChronoBoost",
      t: 1,
    }));
    expect(validateGameRecord(withPlayback({ ...BASE_PLAYBACK, casts: atCap })).valid).toBe(
      true,
    );
  });
});
