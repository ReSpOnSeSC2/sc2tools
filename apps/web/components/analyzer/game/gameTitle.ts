import { isLossResult, isWinResult, type GameSummary } from "./types";

/**
 * "PvZ"-style matchup label from race names or codes; null when either
 * race is unknown.
 *
 * Example: `matchupLabel("Protoss", "Z")` → "PvZ".
 */
export function matchupLabel(
  myRace?: string | null,
  oppRace?: string | null,
): string | null {
  const mine = (myRace || "").trim().charAt(0).toUpperCase();
  const theirs = (oppRace || "").trim().charAt(0).toUpperCase();
  if (!/[TPZR]/.test(mine) || !/[TPZR]/.test(theirs)) return null;
  return `${mine}v${theirs}`;
}

/** "Victory" / "Defeat" / "Tie" from either result vocabulary; null otherwise. */
function resultWord(result?: string | null): string | null {
  if (isWinResult(result)) return "Victory";
  if (isLossResult(result)) return "Defeat";
  if (result === "Tie") return "Tie";
  return null;
}

/**
 * The browser-tab title for one game, from its slim summary row. Parts
 * that are unknown drop out; null when nothing is known.
 *
 * Example:
 *   gameTitle({ result: "Defeat", myRace: "Protoss", map: "Alcyone LE",
 *               opponent: { race: "Zerg" } }); // → "Defeat · PvZ on Alcyone LE"
 */
export function gameTitle(
  game: Pick<GameSummary, "result" | "myRace" | "map" | "opponent">,
): string | null {
  const matchup = matchupLabel(game.myRace, game.opponent?.race);
  const map = game.map?.trim() || null;
  const where = matchup && map ? `${matchup} on ${map}` : (matchup ?? map);
  const title = [resultWord(game.result), where].filter(Boolean).join(" · ");
  return title || null;
}
