import type { SeasonRecapResult } from "@/lib/seasonRecap";
import { formatNumber } from "@/lib/i18n/format";
import { RECAP_YEAR } from "./headerRows";

export const YEAR_RECAP_URL = "https://sc2tools.com/wrapped";

/** The entire public card. No replay-derived strings cross this boundary. */
export interface WrappedCard {
  year: typeof RECAP_YEAR;
  games: number;
  wins: number;
  losses: number;
  minutes: number | null;
  longestWinStreak: number;
}

export function projectWrappedCard(recap: SeasonRecapResult): WrappedCard {
  return {
    year: RECAP_YEAR,
    games: recap.totals.games,
    wins: recap.totals.wins,
    losses: recap.totals.losses,
    minutes: recap.totals.hoursPlayed === null ? null : Math.round(recap.totals.hoursPlayed * 60),
    longestWinStreak: recap.longestWinStreak,
  };
}

export function wrappedShareText(card: WrappedCard): string {
  return [
    `My ${card.year} in StarCraft II`,
    [recapCount(card.games, "ladder game"), recapCount(card.wins, "win"), recapCount(card.losses, "loss", "losses")].join(", "),
    YEAR_RECAP_URL,
  ].join("\n");
}

export function recapCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${formatNumber(count)} ${count === 1 ? singular : plural}`;
}
