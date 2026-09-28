/**
 * MMR for the /try report — only what the replays themselves record.
 *
 * A replay stores each player's MMR at the START of the game (the
 * payload marks it `mmrSource: "replay"`); it never stores the rating
 * after the game. So everything here is built from pre-game values:
 *
 *   preGameMmr         — your and your opponent's pre-game MMR and the gap
 *   nextGameMmrChanges — per game, the change up to your NEXT ladder game
 *                        in this set on the same account and queue
 *   computeMmrByQueue  — per account + queue: first → latest pre-game MMR,
 *                        net change and peak (the season recap's
 *                        `computeMmrJourneys`, run once per queue)
 *
 * Nothing is estimated: a game without both numbers gets no gap, the
 * last game of a queue gets no change, and non-ladder games (whose MMR
 * is not the ladder rating) never feed the per-queue numbers.
 *
 * Example:
 *   preGameMmr(payload);          // -> { my: 5326, opp: 5118, gap: 208 }
 *   nextGameMmrChanges(payloads); // -> Map { "g1" => { delta: 18, nextGameId: "g2" } }
 */
import { computeSeasonRecap, type RecapMmrJourney } from "@/lib/seasonRecap";
import { toArcadeGame } from "./reportArcade";
import type { InstantPayload } from "./reportPayload";

/** The payload's marker for an MMR read from the replay (pre-game). */
export const REPLAY_MMR_SOURCE = "replay";
/** All-time window for the shared recap helper. */
const EPOCH = new Date(0);

export interface GameMmr {
  /** Your pre-game MMR. */
  my: number;
  /** Your opponent's pre-game MMR. */
  opp: number;
  /** my − opp: positive when you were the higher-rated player. */
  gap: number;
}

export interface NextGameMmrChange {
  /** Next game's pre-game MMR − this game's pre-game MMR. */
  delta: number;
  nextGameId: string;
}

export interface MmrQueueRow extends RecapMmrJourney {
  /** The race you queued as (the ladder queue). */
  race: string;
  /** Ladder games with a replay MMR on this account and queue. */
  games: number;
}

function replayMmr(value: number | null, source: string | null): number | null {
  return value !== null && source === REPLAY_MMR_SOURCE ? value : null;
}

/**
 * Both players' pre-game MMR and the gap; null unless the replay
 * recorded both.
 *
 * Example:
 *   preGameMmr(payload); // -> { my: 5326, opp: 5118, gap: 208 }
 */
export function preGameMmr(game: InstantPayload): GameMmr | null {
  const my = replayMmr(game.myMmr, game.myMmrSource);
  const opp = game.opponent ? replayMmr(game.opponent.mmr, game.opponent.mmrSource) : null;
  if (my === null || opp === null) return null;
  return { my, opp, gap: my - opp };
}

/** "<toon>|<queue race>" for a ladder game with a replay MMR; else null. */
function queueKey(game: InstantPayload): string | null {
  if (game.isLadderGame !== true) return null;
  if (replayMmr(game.myMmr, game.myMmrSource) === null) return null;
  const toon = game.myToonHandle?.trim();
  const race = game.myLadderRace?.trim();
  return toon && race ? `${toon}|${race}` : null;
}

function byDateThenId(a: InstantPayload, b: InstantPayload): number {
  return Date.parse(a.date) - Date.parse(b.date) || a.gameId.localeCompare(b.gameId);
}

/**
 * Ladder games with a replay MMR, grouped by account + queue, each
 * group oldest first. Games with an unparseable date are left out.
 *
 * Example:
 *   ladderQueues(games).get("1-S2-1-267727|Protoss")?.length; // -> 3
 */
export function ladderQueues(games: ReadonlyArray<InstantPayload>): Map<string, InstantPayload[]> {
  const queues = new Map<string, InstantPayload[]>();
  for (const game of games) {
    const key = queueKey(game);
    if (!key || !Number.isFinite(Date.parse(game.date))) continue;
    const list = queues.get(key) ?? [];
    list.push(game);
    queues.set(key, list);
  }
  for (const list of queues.values()) list.sort(byDateThenId);
  return queues;
}

/**
 * For each ladder game, the change in pre-game MMR up to your next
 * ladder game in this set on the same account and queue. The last game
 * of each queue has no entry: its post-game MMR is not in any replay.
 *
 * Example:
 *   nextGameMmrChanges([g1, g2]).get(g1.gameId); // -> { delta: 18, nextGameId: g2.gameId }
 */
export function nextGameMmrChanges(games: ReadonlyArray<InstantPayload>): Map<string, NextGameMmrChange> {
  const changes = new Map<string, NextGameMmrChange>();
  for (const queue of ladderQueues(games).values()) {
    for (let i = 0; i + 1 < queue.length; i += 1) {
      const current = queue[i];
      const next = queue[i + 1];
      // Both are non-null: queueKey only admits games with a replay MMR.
      if (current.myMmr === null || next.myMmr === null) continue;
      changes.set(current.gameId, { delta: next.myMmr - current.myMmr, nextGameId: next.gameId });
    }
  }
  return changes;
}

/**
 * First → latest pre-game MMR, net change and peak per account and
 * queue, from ladder games only. Reuses the season recap's MMR journey
 * (grouped by toon handle, two games minimum) by running it once per
 * queue race, so the queues never blend. Null when no queue has two
 * games with a replay MMR.
 *
 * Example:
 *   computeMmrByQueue(games)?.[0]; // -> { accountLabel: "NA 267727", race: "Protoss", start: 5326, end: 5390, ... }
 */
export function computeMmrByQueue(games: ReadonlyArray<InstantPayload>): MmrQueueRow[] | null {
  const rows: MmrQueueRow[] = [];
  for (const queue of ladderQueues(games).values()) {
    const race = queue[0]?.myLadderRace?.trim();
    if (!race) continue;
    const recap = computeSeasonRecap(queue.map(toArcadeGame), { since: EPOCH });
    for (const journey of recap.mmrJourneys) rows.push({ ...journey, race, games: queue.length });
  }
  rows.sort((a, b) => b.games - a.games || a.accountLabel.localeCompare(b.accountLabel) || a.race.localeCompare(b.race));
  return rows.length > 0 ? rows : null;
}

const MMR_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
/** U+2212, so a negative change reads as a real minus sign. */
const MINUS = "−";

/**
 * An MMR value with thousands separators.
 *
 * Example:
 *   formatMmr(5326); // -> "5,326"
 */
export function formatMmr(value: number): string {
  return MMR_FORMAT.format(Math.round(value));
}

/**
 * A signed MMR change: "+18", "−12" or "±0".
 *
 * Example:
 *   signedMmr(-12); // -> "−12"
 */
export function signedMmr(delta: number): string {
  const rounded = Math.round(delta);
  if (rounded === 0) return "±0";
  return rounded > 0 ? `+${formatMmr(rounded)}` : `${MINUS}${formatMmr(-rounded)}`;
}

/**
 * The pre-game gap in words, from your side.
 *
 * Example:
 *   mmrGapLabel(208); // -> "favored by 208"
 *   mmrGapLabel(-90); // -> "underdog by 90"
 */
export function mmrGapLabel(gap: number): string {
  const rounded = Math.round(gap);
  if (rounded === 0) return "even match";
  return rounded > 0 ? `favored by ${formatMmr(rounded)}` : `underdog by ${formatMmr(-rounded)}`;
}
