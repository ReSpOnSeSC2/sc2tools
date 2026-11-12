import { matchupLabel } from "./reportGames";
import type { InstantPayload } from "./reportPayload";

export interface CommanderRow {
  matchup: string;
  durationSec: number | null;
  result: string;
  myBuild: string | null;
}

export function rankedMatchup(own: string | null, opponent: string | null): string | null {
  const matchup = matchupLabel(own, opponent);
  return matchup && /^[PTZ]v[PTZ]$/.test(matchup) ? matchup : null;
}

/** Do not merge files analyzed from different player perspectives. */
export function dominantPlayer<T>(rows: readonly T[], playerOf: (row: T) => string | null): T[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const player = playerOf(row);
    if (!player) continue;
    const group = groups.get(player);
    if (group) group.push(row);
    else groups.set(player, [row]);
  }
  return [...groups.values()].reduce((largest, group) => group.length > largest.length ? group : largest, []);
}

/** Older saved reports can use their local deep parses even without a fresh scan. */
export function commanderSavedRows(payloads: readonly InstantPayload[]): CommanderRow[] {
  const seen = new Set<string>();
  const ranked = payloads.filter(game => {
    if (!game.isLadderGame || seen.has(game.gameId) || !Number.isFinite(Date.parse(game.date))) return false;
    seen.add(game.gameId);
    return true;
  });
  return dominantPlayer(ranked, row => row.myToonHandle).flatMap(game => {
    const matchup = rankedMatchup(game.myRace, game.opponent?.race ?? null);
    return matchup ? [{ matchup, durationSec: game.durationSec, result: game.result, myBuild: game.myBuild }] : [];
  });
}
