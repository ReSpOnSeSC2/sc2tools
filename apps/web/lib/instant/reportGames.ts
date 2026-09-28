/**
 * The /try report's game list: one row per game, newest first, with
 * date, map, matchup, W/L, both pre-game MMRs and the MMR change up to
 * your next ladder game (see reportMmr.ts). What the selected game's
 * detail needs is derived lazily in reportGameDetail.ts, so this module
 * (loaded with the report) stays small.
 *
 * Example:
 *   const games = buildReportGames(payloads);
 *   games[0].matchup; // -> "PvZ"
 */
import { outcome } from "@/components/analyzer/arcade/ArcadeEngine";
import { nextGameMmrChanges, preGameMmr, type GameMmr, type NextGameMmrChange } from "./reportMmr";
import type { InstantPayload } from "./reportPayload";

/** Matchup letters for the races a replay can name. */
const RACE_LETTERS: Readonly<Record<string, string>> = { P: "P", T: "T", Z: "Z", R: "R" };

export interface ReportGame {
  gameId: string;
  date: string;
  map: string | null;
  /** "PvZ"; null unless both races are known. */
  matchup: string | null;
  outcome: "W" | "L" | null;
  opponentName: string | null;
  durationSec: number | null;
  /** Both pre-game MMRs; null unless the replay recorded both. */
  mmr: GameMmr | null;
  /** Change up to your next ladder game here; null when there is none. */
  nextMmr: NextGameMmrChange | null;
  payload: InstantPayload;
}

function raceLetter(race: string | null | undefined): string | null {
  const first = race?.trim().charAt(0).toUpperCase() ?? "";
  return RACE_LETTERS[first] ?? null;
}

/**
 * "PvZ" from your race and the opponent's; null when either is unknown.
 *
 * Example:
 *   matchupLabel("Protoss", "Zerg"); // -> "PvZ"
 *   matchupLabel("Protoss", "U");    // -> null
 */
export function matchupLabel(myRace: string | null, oppRace: string | null): string | null {
  const mine = raceLetter(myRace);
  const theirs = raceLetter(oppRace);
  return mine && theirs ? `${mine}v${theirs}` : null;
}

function decided(result: string): "W" | "L" | null {
  const o = outcome({ result });
  return o === "U" ? null : o;
}

/**
 * List rows for the game picker, newest first (ties by gameId), each
 * with its pre-game MMRs and the MMR change up to your next ladder game
 * on the same account and queue.
 *
 * Example:
 *   buildReportGames(payloads)[0].matchup; // -> "PvZ"
 */
export function buildReportGames(games: ReadonlyArray<InstantPayload>): ReportGame[] {
  const changes = nextGameMmrChanges(games);
  const rows = games.map((payload) => ({
    gameId: payload.gameId,
    date: payload.date,
    map: payload.map,
    matchup: matchupLabel(payload.myRace, payload.opponent?.race ?? null),
    outcome: decided(payload.result),
    opponentName: payload.opponent?.displayName ?? null,
    durationSec: payload.durationSec,
    mmr: preGameMmr(payload),
    nextMmr: changes.get(payload.gameId) ?? null,
    payload,
  }));
  return rows.sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || a.gameId.localeCompare(b.gameId));
}
