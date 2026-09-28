import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lossAutopsy } from "@/lib/lossAutopsy";
import {
  buildInstantReport,
  computeLastLoss,
  computeMacro,
  computeMostFaced,
  computeOpeners,
  parseInstantPayload,
  toArcadeGame,
  toAutopsyGame,
  type InstantPayload,
} from "../report";

// Real payload: the desktop agent's parse_replay_for_cloud_ex + to_payload +
// compact_json_bytes on apps/replay-engine/tests/fixtures/replays/warpgate_adept_tracking.SC2Replay.
const RAW = readFileSync(path.join(__dirname, "fixtures", "warpgate_payload.json"), "utf8");
const NOW = new Date("2026-09-27T12:00:00Z");

function realWin(): InstantPayload {
  const payload = parseInstantPayload(RAW);
  if (!payload) throw new Error("fixture must parse");
  return payload;
}

/** Synthetic variant of the real game: same data, recorded as a later Defeat. */
function derivedDefeat(): InstantPayload {
  return { ...realWin(), gameId: "defeat-variant", result: "Defeat", date: "2026-05-09T19:08:12Z" };
}

describe("parseInstantPayload", () => {
  it("narrows the real payload", () => {
    const p = realWin();
    expect(p).toMatchObject({
      gameId: "2026-05-08T19:08:12|Squirtuoz|Tourmaline LE|470",
      date: "2026-05-08T19:08:12Z",
      result: "Victory",
      myRace: "Protoss",
      map: "Tourmaline LE",
      durationSec: 470,
      myBuild: "PvZ - Adept Glaives (Robo)",
      macroScore: 72,
      myMmr: 5326,
      myToonHandle: "1-S2-1-267727",
      opponent: {
        displayName: "Squirtuoz",
        race: "Zerg",
        toonHandle: "1-S2-1-5079063",
        pulseId: "1-S2-1-5079063",
        mmr: 5118,
        strategy: "ZvP - Speedling Flood",
      },
    });
    expect(p.buildLog.length).toBeGreaterThan(0);
    expect(p.macroBreakdown?.top_3_leaks?.map((l) => l.name)).toEqual([
      "Mineral Float",
      "Supply Blocked",
      "Chrono Efficiency",
    ]);
    expect(p.macroBreakdown?.raw?.supply_block_windows?.length).toBe(4);
    expect(p.macroBreakdown?.stats_events?.[0]).toMatchObject({ time: 0, food_used: 12 });
  });

  it("returns null for malformed JSON or missing required fields", () => {
    expect(parseInstantPayload("{not json")).toBeNull();
    expect(parseInstantPayload("[]")).toBeNull();
    expect(parseInstantPayload('{"gameId":"g","date":"2026-01-01T00:00:00Z"}')).toBeNull();
  });

  it("defaults optional fields to null", () => {
    const p = parseInstantPayload(
      '{"gameId":"g","date":"2026-01-01T00:00:00Z","result":"Victory","macroBreakdown":7}',
    );
    expect(p).toMatchObject({ opponent: null, macroBreakdown: null, myBuild: null, macroScore: null, buildLog: [] });
  });
});

describe("toArcadeGame", () => {
  it("applies the normaliseGame mapping", () => {
    expect(toArcadeGame(realWin())).toMatchObject({
      duration: 470,
      macro_score: 72,
      oppRace: "Zerg",
      opp_strategy: "ZvP - Speedling Flood",
      oppPulseId: "1-S2-1-5079063",
      opponent: { displayName: "Squirtuoz", mmr: 5118, race: "Zerg" },
    });
  });
});

describe("buildInstantReport on real data", () => {
  it("summarises a win and a loss against the same opponent", () => {
    const report = buildInstantReport([realWin(), derivedDefeat()], NOW);
    expect(report.asOf).toBe(NOW.toISOString());
    expect(report.totals).toEqual({ games: 2, wins: 1, losses: 1 });
    expect(report.recordByMatchup).toEqual([
      { matchup: "vs Z", oppRace: "Z", games: 2, wins: 1, losses: 1, winrate: 0.5 },
    ]);
    expect(report.openers).toEqual([
      { name: "PvZ - Adept Glaives (Robo)", games: 2, wins: 1, losses: 1, winrate: 0.5 },
    ]);
    expect(report.mostFaced).toEqual({ name: "Squirtuoz", race: "Zerg", games: 2, wins: 1, losses: 1 });
    expect(report.macro).toEqual({
      averageScore: 72,
      games: 2,
      topLeaks: [
        { name: "Mineral Float", occurrences: 2, totalMineralCost: 1200, averagePenalty: 7.030303030303031 },
        { name: "Supply Blocked", occurrences: 2, totalMineralCost: 720, averagePenalty: 15 },
        { name: "Chrono Efficiency", occurrences: 2, totalMineralCost: 100, averagePenalty: 6.4 },
      ],
    });
  });

  it("explains the most recent loss with lossAutopsy", () => {
    const lastLoss = computeLastLoss([realWin(), derivedDefeat()]);
    expect(lastLoss?.game.id).toBe("defeat-variant");
    expect(lastLoss?.causes.map((c) => c.id)).toEqual(["production_idle", "one_sided_fight", "supply_block"]);
    expect(lastLoss?.game.macroBreakdown).toMatchObject({
      ok: true,
      macro_score: 72,
      race: "Protoss",
      game_length_sec: 470,
    });
  });

  it("loses nothing lossAutopsy needs when narrowing the payload", () => {
    const raw: unknown = JSON.parse(RAW);
    if (typeof raw !== "object" || raw === null || !("macroBreakdown" in raw)) throw new Error("fixture");
    const blob = raw.macroBreakdown;
    if (typeof blob !== "object" || blob === null) throw new Error("fixture");
    const direct = lossAutopsy({
      game: {
        ...toAutopsyGame(derivedDefeat()),
        // The API composes the unnarrowed blob the same way (perGameCompute.macroBreakdown).
        macroBreakdown: { ok: true, macro_score: 72, race: "Protoss", game_length_sec: 470, ...blob },
      },
    });
    expect(computeLastLoss([derivedDefeat()])?.causes).toEqual(direct);
  });

  it("dedupes repeated games", () => {
    expect(buildInstantReport([realWin(), realWin()], NOW).totals.games).toBe(1);
  });
});

/** A minimal game with every optional field missing. */
function bare(patch: Partial<InstantPayload> = {}): InstantPayload {
  return {
    gameId: "g",
    date: "2026-05-01T00:00:00Z",
    result: "Victory",
    myRace: null,
    map: null,
    durationSec: null,
    myBuild: null,
    macroScore: null,
    myMmr: null,
    myToonHandle: null,
    opponent: null,
    macroBreakdown: null,
    buildLog: [],
    ...patch,
  };
}

describe("buildInstantReport null-safety", () => {
  it("hides every section for an empty list", () => {
    expect(buildInstantReport([], NOW)).toEqual({
      asOf: NOW.toISOString(),
      totals: { games: 0, wins: 0, losses: 0 },
      recordByMatchup: null,
      openers: null,
      mostFaced: null,
      macro: null,
      lastLoss: null,
    });
  });

  it("hides sections whose data is missing (no opponent, builds, macro, losses)", () => {
    const report = buildInstantReport([bare(), bare({ gameId: "h" })], NOW);
    expect(report.totals).toEqual({ games: 2, wins: 2, losses: 0 });
    expect(report.recordByMatchup).toBeNull();
    expect(report.openers).toBeNull();
    expect(report.mostFaced).toBeNull();
    expect(report.macro).toBeNull();
    expect(report.lastLoss).toBeNull();
  });

  it("ignores games without a usable date", () => {
    expect(buildInstantReport([bare({ date: "garbage" })], NOW).totals.games).toBe(0);
  });

  it("drops the loss card when the loss has no macro data to explain it", () => {
    expect(computeLastLoss([bare({ result: "Defeat" })])).toBeNull();
  });
});

describe("report sections", () => {
  it("keeps the macro card with a score but no leaks", () => {
    expect(computeMacro([bare({ macroScore: 60 }), bare({ gameId: "h", macroScore: 80 })])).toEqual({
      averageScore: 70,
      games: 2,
      topLeaks: [],
    });
  });

  it("keeps the macro card with leaks but no score", () => {
    const macro = computeMacro([bare({ macroBreakdown: { top_3_leaks: [{ name: "Supply Blocked" }] } })]);
    expect(macro).toEqual({
      averageScore: null,
      games: 0,
      topLeaks: [{ name: "Supply Blocked", occurrences: 1, totalMineralCost: null, averagePenalty: null }],
    });
  });

  it("needs two games before naming a most-faced opponent", () => {
    const opp = { displayName: "Solo", race: "Terran", toonHandle: null, pulseId: null, mmr: null, strategy: null };
    expect(computeMostFaced([bare({ opponent: opp })])).toBeNull();
    const rematch = bare({ gameId: "h", opponent: { ...opp, displayName: "solo" }, result: "Defeat" });
    const twice = computeMostFaced([bare({ opponent: opp }), rematch]);
    expect(twice).toMatchObject({ games: 2, wins: 1, losses: 1, race: "Terran" });
  });

  it("keys opponents by toon and shows their newest name", () => {
    const opp = { displayName: "OldName", race: "Zerg", toonHandle: "2-S2-1-9", pulseId: null, mmr: null, strategy: null };
    const later = bare({ gameId: "h", date: "2026-05-03T00:00:00Z", opponent: { ...opp, displayName: "NewName" } });
    const nameless = bare({ gameId: "i", date: "2026-05-02T00:00:00Z", opponent: { ...opp, displayName: null } });
    expect(computeMostFaced([later, bare({ opponent: opp }), nameless])).toEqual({
      name: "NewName",
      race: "Zerg",
      games: 3,
      wins: 3,
      losses: 0,
    });
  });

  it("skips Game Too Short openers and sorts by games", () => {
    const rows = computeOpeners([
      bare({ myBuild: "PvZ - Game Too Short" }),
      bare({ gameId: "a", myBuild: "B" }),
      bare({ gameId: "b", myBuild: "A", result: "Defeat" }),
      bare({ gameId: "c", myBuild: "A" }),
    ]);
    expect(rows?.map((r) => [r.name, r.games])).toEqual([["A", 2], ["B", 1]]);
  });
});
