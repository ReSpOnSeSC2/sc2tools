/**
 * Real payloads for the /try report tests, plus a bare game builder.
 *
 * - `warpgate_payload.json`: the desktop agent's payload for
 *   apps/replay-engine/tests/fixtures/replays/warpgate_adept_tracking.SC2Replay
 *   (a PvZ ladder win, pre-game MMR 5326 vs 5118).
 * - `ladder_pair_payloads.json`: the browser engine's payloads
 *   (`instant_analysis.parse_replay_bytes`, player_toon 5-S2-1-526043)
 *   for ladder_zvt_winter_madness then ladder_tvt_tourmaline — the same
 *   Terran account on the Terran queue, pre-game MMR 3703 on 2026-02-21
 *   and 3671 on 2026-04-12. `mapPlayback` and `spatial` were dropped to
 *   keep the file small; the report reads neither.
 *
 * Variants derived from these (re-dated, other results) are labelled
 * where the tests build them.
 *
 * Example:
 *   const [older, newer] = ladderPair();
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { parseInstantPayload, type InstantPayload } from "../../reportPayload";

const WARPGATE_RAW = readFileSync(path.join(__dirname, "warpgate_payload.json"), "utf8");
const PAIR_RAW = readFileSync(path.join(__dirname, "ladder_pair_payloads.json"), "utf8");

/**
 * The real warpgate game (a Victory).
 *
 * Example:
 *   realWin().myMmr; // -> 5326
 */
export function realWin(): InstantPayload {
  const payload = parseInstantPayload(WARPGATE_RAW);
  if (!payload) throw new Error("warpgate fixture must parse");
  return payload;
}

/**
 * The two real ladder games of one account + queue, oldest first.
 *
 * Example:
 *   ladderPair()[1].myMmr; // -> 3671
 */
export function ladderPair(): [InstantPayload, InstantPayload] {
  const raw: unknown = JSON.parse(PAIR_RAW);
  if (!Array.isArray(raw) || raw.length !== 2) throw new Error("pair fixture must hold two games");
  const [older, newer] = raw.map((game) => parseInstantPayload(JSON.stringify(game)));
  if (!older || !newer) throw new Error("pair fixture games must parse");
  return [older, newer];
}

/**
 * A minimal game with every optional field missing.
 *
 * Example:
 *   bare({ result: "Defeat" }).opponent; // -> null
 */
export function bare(patch: Partial<InstantPayload> = {}): InstantPayload {
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
    myMmrSource: null,
    myToonHandle: null,
    myLadderRace: null,
    isLadderGame: null,
    gameVersion: null,
    gameBuild: null,
    opponent: null,
    macroBreakdown: null,
    buildLog: [],
    oppBuildLog: [],
    apmCurve: null,
    ...patch,
  };
}
