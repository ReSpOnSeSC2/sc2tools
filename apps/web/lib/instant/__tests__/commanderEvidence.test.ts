import { webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { commanderSavedRows } from "../commanderEvidence";
import { commanderHeaderRows } from "../commanderHeaderEvidence";
import { detectMe } from "../meDetection";
import { parseInstantPayload } from "../reportPayload";
import { buildRequests, triageScans } from "../sessionPipeline";
import type { IntakeFile, ReplayHeader, ReplayHeaderPlayer } from "../types";

const PLAYER = "1-S2-1-100";
const OTHER_PLAYER = "1-S2-1-200";
const rules = { dateWindow: { kind: "all" } as const, now: Date.parse("2026-11-10"), onlyOneVsOne: true, maxParsedFiles: 2 };

function file(key: string, content = "fixture"): IntakeFile {
  const blob = new Blob([content]);
  Object.defineProperty(blob, "arrayBuffer", { value: async () => new TextEncoder().encode(content).buffer, configurable: true });
  return { key, name: key + ".SC2Replay", relativePath: key + ".SC2Replay", size: blob.size, lastModified: 0,
    source: "picker", blob };
}

function player(toon: string | null, race: string, pid: number, result: ReplayHeaderPlayer["result"]): ReplayHeaderPlayer {
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

function evidence(files: IntakeFile[], scans: ReplayHeader[], chosenToon: string | null = null, signal = new AbortController().signal) {
  const { eligible } = triageScans(files, scans, rules);
  const detection = detectMe(eligible.map(entry => entry.scan));
  return { eligible, detection, chosenToon, signal };
}

function parsed(file: IntakeFile, gameId: string, date: string) {
  return { file, game: { ok: true as const, json: JSON.stringify(game(gameId)), fileName: file.name,
    relativePath: file.relativePath, gameId, date, myToonHandle: PLAYER, matchFormat: "1v1" as const,
    isResumedFromReplay: false, ms: 100 } };
}

afterEach(() => vi.unstubAllGlobals());

it("uses resolved ladder headers beyond the deep cap, dedupes, and excludes attempted rejected and other-player rows", async () => {
  const files = ["deep", "duplicate", "rejected", "rejected-duplicate", "beyond-cap", "other-player", "unranked"].map(key => file(key));
  const scans = [header(6, "Terran"), header(6, "Terran"), header(5, "Zerg"), header(5, "Zerg"), header(4, "Zerg"),
    header(3, "Protoss", OTHER_PLAYER), { ...header(2, "Protoss"), isLadderGame: false }];
  const selection = evidence(files, scans);
  const { eligible, detection } = selection;
  const { requests } = buildRequests(eligible, detection, null, false);
  const rows = await commanderHeaderRows(selection, requests.filter(request => ["deep", "rejected"].includes(request.file.key)),
    [parsed(files[0], "private-game", scans[0].date!)]);
  expect(rows).toEqual([
    { matchup: "PvT", durationSec: 360, result: "Win", myBuild: "Fixture build" },
    { matchup: "PvZ", durationSec: 360, result: "Win", myBuild: null },
  ]);
  expect(JSON.stringify(rows)).not.toMatch(/private|1-S2-1|Fixture map/i);
});

it("counts renamed copies once when the opponent toon is missing and keeps distinct replay bytes", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const files = [...Array.from({ length: 10 }, (_, i) => file(`copy-${i}`)), file("distinct", "another")];
  const scan = header(1, "Terran");
  scan.players[1] = player(null, "Terran", 2, "Loss");
  const rows = await commanderHeaderRows(evidence(files, files.map(() => scan)), [], []);
  expect(rows.map(row => row.matchup)).toEqual(["PvT", "PvT"]);
});

it("requires a deep ID when missing opponent identity cannot be verified, and dedupes deep IDs", async () => {
  vi.stubGlobal("crypto", {});
  const files = [file("first"), file("second"), file("header-only")];
  const incomplete = header(1, "Terran");
  incomplete.players[1] = player(null, "Terran", 2, "Loss");
  const scans = [incomplete, header(2, "Terran"), incomplete];
  const rows = await commanderHeaderRows(evidence(files, scans), [], [
    parsed(files[0], "private-duplicate", scans[0].date!), parsed(files[1], "private-duplicate", scans[1].date!),
  ]);
  expect(rows).toEqual([{ matchup: "PvT", durationSec: 360, result: "Win", myBuild: "Fixture build" }]);
});

it("uses only the chosen toon even when a different path-resolved toon has more games", async () => {
  const files = [file("path-1"), file("path-2"), file("chosen")];
  const scans = [header(1, "Terran"), header(2, "Terran"), { ...header(3, "Zerg", OTHER_PLAYER), toonFromPath: null }];
  const rows = await commanderHeaderRows(evidence(files, scans, OTHER_PLAYER), [], []);
  expect(rows.map(row => row.matchup)).toEqual(["PvZ"]);
});

it("does not finish a superseded selection while reading an ambiguous replay", async () => {
  let finishRead!: (bytes: ArrayBuffer) => void;
  const replay = file("reading");
  Object.defineProperty(replay.blob, "arrayBuffer", { value: () => new Promise<ArrayBuffer>(resolve => { finishRead = resolve; }) });
  const scan = header(1, "Terran");
  scan.players[1] = player(null, "Terran", 2, "Loss");
  const controller = new AbortController();
  const pending = commanderHeaderRows(evidence([replay], [scan], null, controller.signal), [], []);
  controller.abort();
  finishRead(new ArrayBuffer(1));
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

it("falls back to the most represented known player in saved ranked parses", () => {
  const payloads = [game("one"), game("two"), game("two"), game("three", OTHER_PLAYER),
    { ...game("custom"), isLadderGame: false }, { ...game("unknown"), myToonHandle: null }];
  expect(commanderSavedRows(payloads.flatMap(value => parseInstantPayload(JSON.stringify(value)) ?? []))).toEqual([
    { matchup: "PvT", durationSec: 360, result: "Win", myBuild: "Fixture build" },
    { matchup: "PvT", durationSec: 360, result: "Win", myBuild: "Fixture build" },
  ]);
});
