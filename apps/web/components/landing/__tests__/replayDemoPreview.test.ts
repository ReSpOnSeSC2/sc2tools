import { describe, expect, it } from "vitest";
import { instantPreview } from "../replayDemoPreview";
import type { ParsedGame } from "@/lib/instant/types";
const payload = { gameId: "local", date: "2020-01-01", result: "Victory", myRace: "Protoss", myToonHandle: "1-S2-1-1", myMmr: 4200,
  opponent: { displayName: "Other", race: "Zerg", toonHandle: "1-S2-1-2", mmr: 4100 }, map: "Fixture map", durationSec: 600,
  buildLog: ["[0:18] Pylon", "[8:00] Stargate"], oppBuildLog: ["[0:20] Overlord", "[9:00] Hive"] };
const game = (overrides = {}): ParsedGame => ({ ok: true, fileName: "game.SC2Replay", relativePath: "game.SC2Replay", gameId: "local", date: payload.date,
  myToonHandle: payload.myToonHandle, matchFormat: "1v1", isResumedFromReplay: false, ms: 5, json: JSON.stringify({ ...payload, ...overrides }) });
describe("landing worker payload projection", () => {
  it("retains both complete perspectives and replay identity, with no profile lookup", () => {
    const result = instantPreview(game(), [{ toon: payload.myToonHandle, name: "Chosen player", race: "Protoss", games: 1 }]);
    expect(result?.players).toEqual([{ name: "Chosen player", race: "Protoss", result: "Win", handle: payload.myToonHandle, mmr: 4200, build_log: payload.buildLog },
      { name: "Other", race: "Zerg", result: "Loss", handle: "1-S2-1-2", mmr: 4100, build_log: payload.oppBuildLog }]);
    expect(result).toMatchObject({ game_id: "local", duration_sec: 600, map: "Fixture map", date: "2020-01-01" });
  });
  it("uses honest labels when the automatic path has no player-name hint", () => { expect(instantPreview(game(), [])?.players[0].name).toBe("You"); });
  it.each([{ buildLog: [5] }, { durationSec: NaN }, { opponent: null }, { gameId: "different" }, { result: "Unknown" }])("rejects malformed worker data %j", fields => { expect(instantPreview(game(fields), [])).toBeNull(); });
  it("rejects team/resume outcomes and malformed JSON", () => {
    expect(instantPreview({ ...game(), matchFormat: "team" }, [])).toBeNull();
    expect(instantPreview({ ...game(), isResumedFromReplay: true }, [])).toBeNull();
    expect(instantPreview({ ...game(), json: "{" }, [])).toBeNull();
  });
});
