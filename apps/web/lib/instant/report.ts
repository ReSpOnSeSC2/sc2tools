/**
 * The /try "instant report": pure aggregation over locally parsed games.
 *
 * Every section is computed only from what the payloads actually carry
 * and is null when its data is missing, so the UI simply hides that
 * card (ALL DATA IS REAL — nothing is estimated or invented):
 *
 *   totals          — games / wins / losses
 *   recordByMatchup — W-L per opponent race (shared seasonRecap logic)
 *   openers         — W-L per detected build of yours
 *   opponentOpeners — your W-L against each strategy opponents opened with
 *   mostFaced       — the opponent you met most (≥ 2 games)
 *   macro           — average macro score + most frequent top-3 leaks
 *   mmr             — pre-game MMR per account + queue (ladder only)
 *   lastLoss        — "why you lost" causes for your most recent loss
 *   games           — every game, newest first, for the game-by-game view
 *
 * Example:
 *   const payloads = parsed.flatMap((g) => parseInstantPayload(g.json) ?? []);
 *   const report = buildInstantReport(payloads, new Date());
 */
import { isGameTooShort, outcome } from "@/components/analyzer/arcade/ArcadeEngine";
import type {
  LeakItem,
  MacroBreakdownData,
} from "@/components/analyzer/macro/MacroBreakdownPanel.types";
import { lossAutopsy, type AutopsyCause, type AutopsyGame } from "@/lib/lossAutopsy";
import { computeSeasonRecap, type RecapMatchupSplit } from "@/lib/seasonRecap";
import { toArcadeGame } from "./reportArcade";
import { buildReportGames, type ReportGame } from "./reportGames";
import { computeMmrByQueue, type MmrQueueRow } from "./reportMmr";
import type { InstantOpponent, InstantPayload } from "./reportPayload";

export { toArcadeGame } from "./reportArcade";
export { parseInstantPayload } from "./reportPayload";
export type { InstantMacroBreakdown, InstantOpponent, InstantPayload } from "./reportPayload";
export type { ReportGame } from "./reportGames";
export type { MmrQueueRow } from "./reportMmr";

/** "Most faced" only means something once you met someone twice. */
export const MOST_FACED_MIN_GAMES = 2;
/** Leak rows shown in the macro card. */
export const MACRO_TOP_LEAKS = 3;
/** All-time window for the shared recap helpers. */
const EPOCH = new Date(0);

export interface InstantTotals {
  games: number;
  wins: number;
  losses: number;
}

export type MatchupRow = RecapMatchupSplit;

export interface OpenerRow {
  name: string;
  games: number;
  wins: number;
  losses: number;
  /** Over decided games; null when none was decided. */
  winrate: number | null;
}

export interface MostFacedOpponent {
  name: string;
  race: string | null;
  games: number;
  wins: number;
  losses: number;
}

export interface LeakRow {
  name: string;
  /** Games where this leak was in the top 3. */
  occurrences: number;
  /** Sum of `mineral_cost` where reported; null when never reported. */
  totalMineralCost: number | null;
  /** Mean `penalty` where reported; null when never reported. */
  averagePenalty: number | null;
}

export interface MacroSummary {
  /** Mean macro score over games that have one; null when none do. */
  averageScore: number | null;
  /** Games that carried a macro score. */
  games: number;
  topLeaks: LeakRow[];
}

export interface LastLoss {
  game: AutopsyGame;
  causes: AutopsyCause[];
}

export interface InstantReport {
  /** When the report was computed (ISO). */
  asOf: string;
  totals: InstantTotals;
  recordByMatchup: MatchupRow[] | null;
  openers: OpenerRow[] | null;
  /** Rows are opponent strategies; W-L is yours against them. */
  opponentOpeners: OpenerRow[] | null;
  mostFaced: MostFacedOpponent | null;
  macro: MacroSummary | null;
  mmr: MmrQueueRow[] | null;
  lastLoss: LastLoss | null;
  /** Newest first; empty for an empty report. */
  games: ReportGame[];
}

function uniqueDated(payloads: ReadonlyArray<InstantPayload>): InstantPayload[] {
  const seen = new Set<string>();
  return payloads.filter((payload) => {
    if (seen.has(payload.gameId) || !Number.isFinite(Date.parse(payload.date))) return false;
    seen.add(payload.gameId);
    return true;
  });
}

/**
 * Build the whole report. Duplicate gameIds count once; games without a
 * parseable date are ignored (they cannot be ordered or windowed).
 *
 * Example:
 *   buildInstantReport([], new Date()).totals; // -> { games: 0, wins: 0, losses: 0 }
 */
export function buildInstantReport(
  payloads: ReadonlyArray<InstantPayload>,
  now: Date,
): InstantReport {
  const games = uniqueDated(payloads);
  // computeSeasonRecap has no minimum-games threshold for totals or
  // matchup splits (MIN_RECAP_GAMES only gates the recap UI), so it is
  // reused as-is over an all-time window.
  const recap = computeSeasonRecap(games.map(toArcadeGame), { since: EPOCH });
  return {
    asOf: now.toISOString(),
    totals: {
      games: recap.totals.games,
      wins: recap.totals.wins,
      losses: recap.totals.losses,
    },
    recordByMatchup: recap.matchupSplits.length > 0 ? recap.matchupSplits : null,
    openers: computeOpeners(games),
    opponentOpeners: computeOpponentOpeners(games),
    mostFaced: computeMostFaced(games),
    macro: computeMacro(games),
    mmr: computeMmrByQueue(games),
    lastLoss: computeLastLoss(games),
    games: buildReportGames(games),
  };
}

function decidedWinrate(wins: number, losses: number): number | null {
  const decided = wins + losses;
  return decided > 0 ? wins / decided : null;
}

function tallyResult(target: { wins: number; losses: number }, result: string): void {
  const o = outcome({ result });
  if (o === "W") target.wins += 1;
  else if (o === "L") target.losses += 1;
}

/**
 * W-L per name `pick` returns (games without one are skipped), most
 * played first. "Game Too Short" labels are classifier artifacts, not
 * openers (same rule as the recap). Names match case-insensitively.
 *
 * Example:
 *   tallyOpeners(games, (game) => game.myBuild)?.[0].name; // -> "PvZ - Adept Glaives (Robo)"
 */
function tallyOpeners(
  games: ReadonlyArray<InstantPayload>,
  pick: (game: InstantPayload) => string | null,
): OpenerRow[] | null {
  const byName = new Map<string, OpenerRow>();
  for (const game of games) {
    const name = pick(game)?.trim() ?? "";
    if (!name || isGameTooShort(name)) continue;
    const key = name.toLowerCase();
    const row = byName.get(key) ?? { name, games: 0, wins: 0, losses: 0, winrate: null };
    byName.set(key, row);
    row.games += 1;
    tallyResult(row, game.result);
  }
  const rows = [...byName.values()].map((row) => ({
    ...row,
    winrate: decidedWinrate(row.wins, row.losses),
  }));
  rows.sort(compareOpeners);
  return rows.length > 0 ? rows : null;
}

/**
 * W-L per build of yours, most played first.
 *
 * Example:
 *   computeOpeners(games)?.[0]; // -> { name: "PvZ - Adept Glaives (Robo)", games: 3, ... }
 */
export function computeOpeners(games: ReadonlyArray<InstantPayload>): OpenerRow[] | null {
  return tallyOpeners(games, (game) => game.myBuild);
}

/**
 * Your W-L against each strategy the classifier detected for your
 * opponents (`opponent.strategy`), most faced first; null when no game
 * has one.
 *
 * Example:
 *   computeOpponentOpeners(games)?.[0]; // -> { name: "ZvP - Speedling Flood", games: 2, wins: 1, ... }
 */
export function computeOpponentOpeners(games: ReadonlyArray<InstantPayload>): OpenerRow[] | null {
  return tallyOpeners(games, (game) => game.opponent?.strategy ?? null);
}

function compareOpeners(a: OpenerRow, b: OpenerRow): number {
  return b.games - a.games || (b.winrate ?? 0) - (a.winrate ?? 0) || a.name.localeCompare(b.name);
}

interface OpponentTally extends MostFacedOpponent {
  races: Map<string, number>;
  /** Epoch ms of the newest game against this opponent (tie-break). */
  lastTime: number;
  /** Epoch ms of the game the current `name` came from. */
  nameTime: number;
}

/** Shown when an opponent is only known by toon/pulse id. */
const UNKNOWN_OPPONENT_NAME = "Unknown";

function opponentKey(game: InstantPayload): string | null {
  const opp = game.opponent;
  if (!opp) return null;
  if (opp.toonHandle) return `toon:${opp.toonHandle}`;
  if (opp.pulseId) return `pulse:${opp.pulseId}`;
  return opp.displayName ? `name:${opp.displayName.trim().toLowerCase()}` : null;
}

function bumpCount(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function newOpponentTally(name: string): OpponentTally {
  const never = Number.NEGATIVE_INFINITY;
  return {
    name,
    race: null,
    games: 0,
    wins: 0,
    losses: 0,
    races: new Map(),
    lastTime: never,
    nameTime: never,
  };
}

/** Count one game against an opponent; the newest non-empty name wins. */
function recordOpponentGame(
  tally: OpponentTally,
  opponent: InstantOpponent,
  game: InstantPayload,
): void {
  tally.games += 1;
  tallyResult(tally, game.result);
  if (opponent.race) bumpCount(tally.races, opponent.race);
  // Players rename; the toon is stable, so show the most recent name.
  const parsed = Date.parse(game.date);
  const time = Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
  tally.lastTime = Math.max(tally.lastTime, time);
  const displayName = opponent.displayName?.trim() ?? "";
  if (displayName && time >= tally.nameTime) {
    tally.nameTime = time;
    tally.name = displayName;
  }
}

function compareOpponents(a: OpponentTally, b: OpponentTally): number {
  return b.games - a.games || b.lastTime - a.lastTime || a.name.localeCompare(b.name);
}

function topRace(races: ReadonlyMap<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [race, count] of races) {
    if (count > bestCount) {
      best = race;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The opponent met most often (keyed by toon handle, then pulseId,
 * then name); null unless someone was met at least twice.
 *
 * Example:
 *   computeMostFaced(games); // -> { name: "Squirtuoz", race: "Zerg", games: 2, wins: 1, losses: 1 }
 */
export function computeMostFaced(games: ReadonlyArray<InstantPayload>): MostFacedOpponent | null {
  const byKey = new Map<string, OpponentTally>();
  for (const game of games) {
    const key = opponentKey(game);
    if (!key || !game.opponent) continue;
    const tally = byKey.get(key) ?? newOpponentTally(UNKNOWN_OPPONENT_NAME);
    byKey.set(key, tally);
    recordOpponentGame(tally, game.opponent, game);
  }
  const best = [...byKey.values()].sort(compareOpponents)[0];
  if (!best || best.games < MOST_FACED_MIN_GAMES) return null;
  const { name, games: played, wins, losses } = best;
  return { name, race: topRace(best.races), games: played, wins, losses };
}

interface LeakTally {
  name: string;
  occurrences: number;
  mineralCost: number;
  hasCost: boolean;
  penaltySum: number;
  penaltyCount: number;
}

function newLeakTally(name: string): LeakTally {
  return { name, occurrences: 0, mineralCost: 0, hasCost: false, penaltySum: 0, penaltyCount: 0 };
}

function compareLeaks(a: LeakTally, b: LeakTally): number {
  return b.occurrences - a.occurrences || b.mineralCost - a.mineralCost || a.name.localeCompare(b.name);
}

function tallyLeaks(games: ReadonlyArray<InstantPayload>): LeakTally[] {
  const byName = new Map<string, LeakTally>();
  for (const game of games) {
    const seenInGame = new Set<string>();
    for (const leak of game.macroBreakdown?.top_3_leaks ?? []) {
      const name = leak.name?.trim();
      if (!name || seenInGame.has(name)) continue;
      seenInGame.add(name);
      const tally = byName.get(name) ?? newLeakTally(name);
      byName.set(name, tally);
      addLeak(tally, leak);
    }
  }
  return [...byName.values()];
}

/** Count one game's occurrence of a leak, with its cost/penalty when reported. */
function addLeak(tally: LeakTally, leak: LeakItem): void {
  tally.occurrences += 1;
  if (typeof leak.mineral_cost === "number") {
    tally.mineralCost += leak.mineral_cost;
    tally.hasCost = true;
  }
  if (typeof leak.penalty === "number") {
    tally.penaltySum += leak.penalty;
    tally.penaltyCount += 1;
  }
}

/**
 * Average macro score and the leaks that most often made your top 3;
 * null when no game carries a score or a leak.
 *
 * Example:
 *   computeMacro(games)?.topLeaks[0].name; // -> "Mineral Float"
 */
export function computeMacro(games: ReadonlyArray<InstantPayload>): MacroSummary | null {
  const scores = games.flatMap((game) => (game.macroScore === null ? [] : [game.macroScore]));
  const leaks = tallyLeaks(games)
    .sort(compareLeaks)
    .slice(0, MACRO_TOP_LEAKS)
    .map((tally) => ({
      name: tally.name,
      occurrences: tally.occurrences,
      totalMineralCost: tally.hasCost ? tally.mineralCost : null,
      averagePenalty: tally.penaltyCount > 0 ? tally.penaltySum / tally.penaltyCount : null,
    }));
  if (scores.length === 0 && leaks.length === 0) return null;
  const averageScore = scores.length > 0 ? scores.reduce((sum, s) => sum + s, 0) / scores.length : null;
  return { averageScore, games: scores.length, topLeaks: leaks };
}

/**
 * Compose the macro breakdown exactly like the API's
 * `perGameCompute.macroBreakdown` (including its `||` fallbacks).
 */
function composeBreakdown(payload: InstantPayload): MacroBreakdownData | null {
  if (!payload.macroBreakdown) return null;
  return {
    ok: true,
    macro_score: payload.macroScore || null,
    race: payload.myRace || null,
    game_length_sec: payload.durationSec || 0,
    ...payload.macroBreakdown,
  };
}

/**
 * The `AutopsyGame` for one payload (what LossAutopsyCard renders).
 *
 * Example:
 *   lossAutopsy({ game: toAutopsyGame(payload) });
 */
export function toAutopsyGame(payload: InstantPayload): AutopsyGame {
  const opp = payload.opponent;
  return {
    id: payload.gameId,
    date: payload.date,
    result: payload.result,
    map: payload.map,
    opp_strategy: opp?.strategy ?? null,
    opp_race: opp?.race ?? null,
    opponent: opp?.displayName ?? null,
    my_build: payload.myBuild,
    game_length: payload.durationSec,
    macro_score: payload.macroScore,
    my_mmr: payload.myMmr,
    opp_mmr: opp?.mmr ?? null,
    macroBreakdown: composeBreakdown(payload),
    buildLog: payload.buildLog,
  };
}

/**
 * Causes for the most recent loss; null when there is no loss or the
 * rules find nothing the data supports.
 *
 * Example:
 *   computeLastLoss(games)?.causes[0].id; // -> "supply_block"
 */
export function computeLastLoss(games: ReadonlyArray<InstantPayload>): LastLoss | null {
  const losses = games
    .filter((game) => outcome({ result: game.result }) === "L")
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  const latest = losses[0];
  if (!latest) return null;
  const game = toAutopsyGame(latest);
  const causes = lossAutopsy({ game });
  return causes.length > 0 ? { game, causes } : null;
}
