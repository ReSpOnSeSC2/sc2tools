export type RivalryRow = { pulseId: string; name?: string; wins: number; losses: number; games: number; lastPlayed: string | null; weekGames?: number };
export type RivalryKind = "nemesis" | "favourite" | "most-played" | "hot-rematch";

/** Same 95% Wilson primitive and four-decimal rounding as API util/wilson. */
export function rivalryWilson(wins: number, games: number): { low: number; high: number } | null {
  if (!Number.isSafeInteger(wins) || !Number.isSafeInteger(games) || games <= 0 || wins < 0 || wins > games) return null;
  const p = wins / games, z2 = 1.96 ** 2, denominator = 1 + z2 / games;
  const center = (p + z2 / (2 * games)) / denominator;
  const margin = 1.96 * Math.sqrt(p * (1 - p) / games + z2 / (4 * games ** 2)) / denominator;
  return { low: Math.round(Math.max(0, center - margin) * 10000) / 10000, high: Math.round(Math.min(1, center + margin) * 10000) / 10000 };
}

/** Call with the same filtered/grouped rows displayed by the list. A week's
 * count is explicit input; one lifetime last-seen timestamp never implies a
 * rematch. Missing recent coverage remains unavailable to the caller. */
export function chooseRivalries<Row extends RivalryRow>(rows: readonly Row[], now = Date.now()): Record<RivalryKind, Row | null> {
  const timed = (row: Row) => row.lastPlayed ? Date.parse(row.lastPlayed) : -Infinity;
  const tie = (a: Row, b: Row) => b.wins + b.losses - a.wins - a.losses || (a.name || a.pulseId).localeCompare(b.name || b.pulseId);
  const decided = rows.map(row => ({ row, games: row.wins + row.losses, ci: rivalryWilson(row.wins, row.wins + row.losses) })).filter(item => item.ci !== null);
  const nemesis = decided.filter(item => item.games >= 4).sort((a,b) => a.ci!.high - b.ci!.high || tie(a.row,b.row))[0]?.row ?? null;
  const favourite = decided.sort((a,b) => b.ci!.low - a.ci!.low || tie(a.row,b.row))[0]?.row ?? null;
  const mostPlayed = rows.filter(row => row.games > 0).slice().sort((a,b) => b.games - a.games || tie(a,b))[0] ?? null;
  const hot = rows.filter(row => (row.weekGames ?? 0) >= 2 && timed(row) <= now && timed(row) >= now - 7 * 86_400_000).slice().sort((a,b) => timed(b) - timed(a) || (b.weekGames || 0) - (a.weekGames || 0) || tie(a,b))[0] ?? null;
  return { nemesis, favourite, "most-played": mostPlayed, "hot-rematch": hot };
}

/** A single render budget includes expanded account rows. Both responsive
 * representations consume this same logical window. */
export function opponentRowWindow<Group extends { pulseId: string; identities: readonly { pulseId: string }[] }>(rows: readonly Group[], expanded: ReadonlySet<string>, limit: number) {
  const window: ({ kind: "parent"; row: Group; parent: null } | { kind: "identity"; row: Group["identities"][number]; parent: Group })[] = [];
  let total = 0;
  for (const row of rows) {
    total++;
    if (window.length < limit) window.push({ kind: "parent", row, parent: null });
    if (row.identities.length > 1 && expanded.has(row.pulseId)) for (const identity of row.identities) {
      total++; if (window.length < limit) window.push({ kind: "identity", row: identity, parent: row });
    }
  }
  return { window, total };
}
