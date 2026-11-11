import type { AdminResultClass } from "./adminTypes";

export type { AdminResultClass };

/**
 * Explicit result classification for admin game views; the API's
 * util/gameResultClass.js applies the same rule to the result filter and
 * the head-to-head summary. Victory/Win is a win, Defeat/Loss a loss and
 * Tie/Draw a tie (any case, surrounding spaces ignored). Anything else,
 * including "Undecided" and a missing result, is unknown: never a loss and
 * never a decided game.
 *
 * Example: `resultOf("Undecided")` → "unknown"; `resultOf(" victory ")` → "win".
 */
export function resultOf(result: string | null | undefined): AdminResultClass {
  switch (typeof result === "string" ? result.trim().toLowerCase() : "") {
    case "victory": case "win": return "win";
    case "defeat": case "loss": return "loss";
    case "tie": case "draw": return "tie";
    default: return "unknown";
  }
}

/** Badge text per class; unknown shows a dash with this as its spoken text. */
export const RESULT_BADGE_LABEL: Record<AdminResultClass, string> = { win: "Win", loss: "Loss", tie: "Tie", unknown: "Result not recorded" };

/** Sentence text, as in "Game 3 of 25: Victory on Alcyone". */
export const RESULT_SPOKEN: Record<AdminResultClass, string> = { win: "Victory", loss: "Defeat", tie: "Tie", unknown: "Result not recorded" };

/** Win rate over decided games only (wins ÷ (wins + losses)); null with none. */
export function decidedWinRate(wins: number, losses: number): number | null {
  const decided = wins + losses;
  return decided > 0 ? wins / decided : null;
}

/** The result filter values a game list accepts in its URL. */
export const RESULT_FILTERS = ["all", "win", "loss", "tie"] as const;
export type AdminResultFilter = (typeof RESULT_FILTERS)[number];
export const RESULT_FILTER_LABEL: Record<AdminResultFilter, string> = { all: "All", win: "Wins", loss: "Losses", tie: "Ties" };
