/**
 * Rolling win rate for a build's recent games: each point is the win rate
 * over the last `window` games with a result, up to and including that
 * game. Draws, unknown results and games without a result are skipped, so
 * every window holds exactly `window` wins and losses.
 *
 * Framework-agnostic (no React) so the dossier chart and its tests share it.
 */

/** Games per point (and the minimum before a trend is drawn). */
export const TREND_WINDOW = 10;

/** The fields of a recent game the trend reads (BuildRecentGame fits). */
export interface TrendGame {
  gameId: string;
  date: string;
  result: string | null | undefined;
}

export type GameOutcome = "win" | "loss";

/** "win" for Win/Victory, "loss" for Loss/Defeat (any case), else null. */
export function gameOutcome(result: string | null | undefined): GameOutcome | null {
  const r = String(result ?? "").trim().toLowerCase();
  if (r === "win" || r === "victory") return "win";
  if (r === "loss" || r === "defeat") return "loss";
  return null;
}

export interface RollingWinRatePoint {
  /** 1-based position of the window's last game among decided games, oldest first. */
  game: number;
  /** The game that closes this window. */
  gameId: string;
  date: string;
  /** Win rate over the window, 0–100. */
  rate: number;
  wins: number;
  losses: number;
}

export interface RollingWinRate {
  window: number;
  /** Games with a win or loss. */
  decided: number;
  /** One point per full window, oldest first; empty below `window` games. */
  points: RollingWinRatePoint[];
}

/**
 * Example: 12 decided games give 3 points (games 10, 11 and 12), each the
 * win rate of the 10 games ending there. Input order doesn't matter: games
 * are sorted by date (oldest first); for equal or unreadable dates the
 * API's newest-first order is kept.
 */
export function rollingWinRate(
  games: ReadonlyArray<TrendGame>,
  window: number = TREND_WINDOW,
): RollingWinRate {
  const size = Math.max(1, Math.floor(window));
  const ordered = games
    .map((game, index) => {
      const time = Date.parse(game.date);
      return { game, index, time: Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY };
    })
    .sort((a, b) => (a.time !== b.time ? a.time - b.time : b.index - a.index));
  const decided: Array<{ game: TrendGame; outcome: GameOutcome }> = [];
  for (const { game } of ordered) {
    const outcome = gameOutcome(game.result);
    if (outcome) decided.push({ game, outcome });
  }
  const points: RollingWinRatePoint[] = [];
  let wins = 0;
  for (let i = 0; i < decided.length; i++) {
    if (decided[i].outcome === "win") wins += 1;
    if (i >= size && decided[i - size].outcome === "win") wins -= 1;
    if (i < size - 1) continue;
    points.push({
      game: i + 1,
      gameId: decided[i].game.gameId,
      date: decided[i].game.date,
      rate: (wins / size) * 100,
      wins,
      losses: size - wins,
    });
  }
  return { window: size, decided: decided.length, points };
}
