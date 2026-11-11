import { describe, expect, it } from "vitest";
import { makeIntakeFile } from "@/lib/instant/fileIntake";
import type { ReplayHeader, ReplayHeaderPlayer } from "@/lib/instant/types";
import { computeSeasonRecap } from "@/lib/seasonRecap";
import {
  busiestReplayMonth, gamesFromHeaders, headerIdentity, RECAP_END, RECAP_START, yearLadderHeaders, yearReplayFiles,
} from "./headerRows";

const MY_TOON = "1-S2-1-12345";
const OPP_TOON = "1-S2-1-76543";
const ME: ReplayHeaderPlayer = {
  name: "Private player", toon: MY_TOON, race: "Protoss", selectedRace: "Random",
  mmr: 5100, leagueId: 6, result: "Win", pid: 1,
};
const OPPONENT: ReplayHeaderPlayer = {
  ...ME, name: "Private opponent", toon: OPP_TOON, race: "Terran", selectedRace: "Terran", mmr: 5200, result: "Loss", pid: 2,
};

function replay(name: string, lastModified = RECAP_START) {
  return makeIntakeFile(new File(["replay"], name, { lastModified }), "folder");
}

function header(overrides: Partial<ReplayHeader> = {}): ReplayHeader {
  return {
    ok: true, players: [ME, OPPONENT], date: "2026-04-01T02:00:00Z", startedAt: "2026-04-01T01:50:00Z",
    map: "Private map", matchFormat: "1v1", durationSec: 600, utcOffsetHours: -4, playerCount: 2,
    isAiGame: false, isLadderGame: true, toonFromPath: MY_TOON, gameVersion: "5.0.15", gameBuild: 1,
    expansion: "LotV", ...overrides,
  };
}

describe("2026 replay selection", () => {
  it("pre-filters mtime in UTC and de-duplicates file selection without reading bodies", () => {
    const start = replay("start.SC2Replay");
    const end = replay("end.SC2Replay", RECAP_END - 1);
    expect(yearReplayFiles([start, replay("before.SC2Replay", RECAP_START - 1), replay("after.SC2Replay", RECAP_END),
      replay("not-replay.txt"), start, end])).toEqual([end, start]);
  });

  it("requires a confirmed 1v1 human ladder game and a replay-authored date within the year", () => {
    const scans = [
      header({ date: "2025-12-31T23:59:59.999Z" }), header({ date: null }), header({ date: "2027-01-01T00:00:00Z" }),
      header({ matchFormat: "team" }), header({ isAiGame: true }), header({ isLadderGame: false }),
      header({ isLadderGame: null }), header({ playerCount: 3 }), header({ players: [ME] }),
      header({ date: "2026-12-31T23:59:59.999Z" }),
    ];
    const files = scans.map((_, index) => replay(`${index}.SC2Replay`));
    expect(yearLadderHeaders(files, scans)).toEqual([{ key: files.at(-1)?.key, header: scans.at(-1) }]);
  });
});

it("uses the toon folder, preserves the queue, and counts copied replays once", () => {
  const files = [replay("original.SC2Replay"), replay("copy.SC2Replay"), replay("loose.SC2Replay")];
  const rows = yearLadderHeaders(files, [header(), header(), header({ date: "2026-04-04T00:00:00Z", toonFromPath: null })]);
  expect(headerIdentity(rows).needsConfirmation).toBe(true);
  const games = gamesFromHeaders(rows, OPP_TOON);
  expect(games.map((game) => [game.result, game.myLadderRace])).toEqual([["Win", "Random"], ["Loss", "Terran"]]);
  expect(busiestReplayMonth(games)).toEqual({ month: "April", games: 2 });
});

it("does not compare rating across a player's ladder queues", () => {
  const files = Array.from({ length: 4 }, (_, index) => replay(`${index}.SC2Replay`));
  const scans = ["Random", "Terran", "Random", "Terran"].map((selectedRace, index) =>
    header({ date: `2026-04-0${index + 1}T00:00:00Z`, players: [{ ...ME, selectedRace, mmr: [5000, 4200, 5100, 4175][index] }, OPPONENT] }),
  );
  const games = gamesFromHeaders(yearLadderHeaders(files, scans));
  const recap = computeSeasonRecap(games, { since: new Date(RECAP_START), separateRaceQueues: true });
  expect(recap.mmrJourneys.map((queue) => [queue.race, queue.delta])).toEqual([["Random", 100], ["Terran", -25]]);
});
