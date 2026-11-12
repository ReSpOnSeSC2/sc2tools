import { expect, it } from "vitest";
import { commanderHeaderRows, commanderSavedRows } from "../commanderEvidence";
import { detectMe } from "../meDetection";
import { parseInstantPayload } from "../reportPayload";
import { buildRequests, triageScans } from "../sessionPipeline";
import type { IntakeFile, ReplayHeader, ReplayHeaderPlayer } from "../types";

const PLAYER = "1-S2-1-100";
const OTHER_PLAYER = "1-S2-1-200";
const rules = { dateWindow: { kind: "all" } as const, now: Date.parse("2026-11-10"), onlyOneVsOne: true, maxParsedFiles: 2 };

function file(key: string): IntakeFile {
  return { key, name: key + ".SC2Replay", relativePath: key + ".SC2Replay", size: 1, lastModified: 0,
    source: "picker", blob: new Blob(["fixture"]) };
}

function player(toon: string, race: string, pid: number, result: ReplayHeaderPlayer["result"]): ReplayHeaderPlayer {
  return { name: "Private player " + pid, toon, race, pid, result, selectedRace: race, mmr: null, leagueId: null };
}

function header(day: number, race: string, toon = PLAYER): ReplayHeader {
  return { ok: true, players: [player(toon, "Protoss", 1, "Win"), player("1-S2-1-300", race, 2, "Loss")],
    date: "2026-11-0" + day + "T12:00:00Z", map: "Fixture map", durationSec: 360,
    matchFormat: "1v1", playerCount: 2, isAiGame: false, isLadderGame: true, toonFromPath: toon,
    startedAt: null, utcOffsetHours: null, gameVersion: null, gameBuild: null, expansion: null };
}

function game(gameId: string, myToonHandle = PLAYER) {
  return { gameId, date: "2026-11-01T12:00:00Z", myToonHandle, myRace: "Protoss", opponent: { race: "Terran", displayName: "Private rival" },
    result: "Win", myBuild: "Fixture build", durationSec: 360, isLadderGame: true };
}

it("uses resolved ladder headers beyond the deep cap, dedupes, and excludes attempted rejected and other-player rows", () => {
  const files = ["deep", "duplicate", "rejected", "rejected-duplicate", "beyond-cap", "other-player", "unranked"].map(file);
  const scans = [header(6, "Terran"), header(6, "Terran"), header(5, "Zerg"), header(5, "Zerg"), header(4, "Zerg"),
    header(3, "Protoss", OTHER_PLAYER), { ...header(2, "Protoss"), isLadderGame: false }];
  const { eligible } = triageScans(files, scans, rules);
  const detection = detectMe(eligible.map(entry => entry.scan));
  const { requests } = buildRequests(eligible, detection, null, false);
  const parsed = [{ file: files[0], game: { ok: true as const, json: JSON.stringify(game("private-game")),
    fileName: files[0].name, relativePath: files[0].relativePath, gameId: "private-game", date: scans[0].date!,
    myToonHandle: PLAYER, matchFormat: "1v1" as const, isResumedFromReplay: false, ms: 100 } }];
  const rows = commanderHeaderRows(eligible, detection, null, requests.filter(request => ["deep", "rejected"].includes(request.file.key)), parsed);
  expect(rows).toEqual([
    { matchup: "PvT", durationSec: 360, result: "Win", myBuild: "Fixture build" },
    { matchup: "PvZ", durationSec: 360, result: "Win", myBuild: null },
  ]);
  expect(JSON.stringify(rows)).not.toMatch(/private|1-S2-1|Fixture map/i);
});

it("falls back to the most represented known player in saved ranked parses", () => {
  const payloads = [game("one"), game("two"), game("two"), game("three", OTHER_PLAYER),
    { ...game("custom"), isLadderGame: false }, { ...game("unknown"), myToonHandle: null }];
  expect(commanderSavedRows(payloads.flatMap(value => parseInstantPayload(JSON.stringify(value)) ?? []))).toEqual([
    { matchup: "PvT", durationSec: 360, result: "Win", myBuild: "Fixture build" },
    { matchup: "PvT", durationSec: 360, result: "Win", myBuild: "Fixture build" },
  ]);
});
