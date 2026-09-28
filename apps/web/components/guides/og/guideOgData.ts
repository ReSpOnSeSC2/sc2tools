/**
 * Social-card content for the guide Open Graph images (build, counter
 * and matchup pages). Pure: every number is copied from the published
 * payload, formatted the same way as the page; an unpublished payload
 * (below the floor, so no numbers at all) yields null, which the image
 * renders as the neutral branded card.
 */
import { fmtCount, fmtPct } from "@/lib/guides/format";
import type {
  GuideBuildPayload,
  GuideBuildPublished,
  GuideCi,
  GuideCounterPayload,
  GuideMatchupPayload,
} from "@/lib/guides/types";
import { myRaceWord } from "@/components/guides/guideUi";

/** The win rate the card's bar draws. */
export interface GuideOgRate {
  label: string;
  /** Fraction 0..1 over decided games. */
  winRate: number;
  ci: GuideCi | null;
  /** n behind the win rate. */
  games: number;
}

export interface GuideOgStat {
  label: string;
  value: string;
}

export interface GuideOgCardData {
  /** "Build guide" | "Counter guide" | "Matchup guide". */
  kind: string;
  matchup: string;
  title: string;
  subtitle: string;
  rate: GuideOgRate | null;
  stats: GuideOgStat[];
}

function patchText(patch: string): string {
  return `Patch ${patch}`;
}

interface CellLike {
  winRate: number;
  games: number;
  users: number | null;
  ci: GuideCi | null;
}

/**
 * The cell behind the page's headline: the densest league band when the
 * headline is league-scoped (its own games, players and interval), else
 * the build's overall cell — the same number the page title shows.
 */
function headlineCell(data: GuideBuildPublished): { label: string; cell: CellLike } {
  const { headline, overall } = data;
  if (headline && headline.scope === "league" && headline.label) {
    const band = data.bands.league.find((row) => row.value === headline.value);
    const cell = band ?? { winRate: headline.winRate, games: headline.games, users: null, ci: null };
    return { label: `Win rate at ${headline.label}`, cell };
  }
  return { label: "Ladder win rate", cell: overall };
}

/**
 * Card for a build guide; null below the publishing floor.
 *
 * Example: published "Stargate into Glaives" → title "Stargate into
 * Glaives", rate { label: "Win rate at Diamond", winRate: 0.5655, games: 145 }.
 */
export function buildOgCard(data: GuideBuildPayload): GuideOgCardData | null {
  if (!data.published) return null;
  const { label, cell } = headlineCell(data);
  const stats: GuideOgStat[] = [];
  if (cell.users !== null) stats.push({ label: "Players", value: fmtCount(cell.users) });
  stats.push({ label: "Patch", value: data.patch });
  return {
    kind: "Build guide",
    matchup: data.matchup,
    title: data.name,
    subtitle: `${data.matchup} build order · ${patchText(data.patch)}`,
    rate: { label, winRate: cell.winRate, ci: cell.ci, games: cell.games },
    stats,
  };
}

/**
 * Card for a "How to beat …" page; null below the publishing floor.
 *
 * Example: → title "How to beat 8 Pool", rate label "Protoss win rate vs 8 Pool".
 */
export function counterOgCard(data: GuideCounterPayload): GuideOgCardData | null {
  if (!data.published) return null;
  const mine = myRaceWord(data.matchup);
  return {
    kind: "Counter guide",
    matchup: data.matchup,
    title: `How to beat ${data.name}`,
    subtitle: `As ${mine} · ${patchText(data.patch)}`,
    rate: {
      label: `${mine} win rate vs ${data.name}`,
      winRate: data.overall.winRate,
      ci: data.overall.ci,
      games: data.overall.games,
    },
    stats: [{ label: "Openers ranked", value: fmtCount(data.openers.length) }],
  };
}

/**
 * Card for a matchup page (its top-ranked published opener on the bar);
 * null when the matchup is unpublished.
 *
 * Example: → title "PvZ build orders", rate label "Top opener: Stargate into Glaives".
 */
export function matchupOgCard(data: GuideMatchupPayload): GuideOgCardData | null {
  if (!data.published || data.games === null || data.users === null) return null;
  const top = data.openers.find((row) => row.published) ?? null;
  const published = data.openers.filter((row) => row.published).length;
  return {
    kind: "Matchup guide",
    matchup: data.matchup,
    title: `${data.matchup} build orders`,
    subtitle: `${fmtCount(published)} openers ranked by win rate · ${patchText(data.patch)}`,
    rate: top
      ? { label: `Top opener: ${top.name}`, winRate: top.winRate, ci: top.ci, games: top.games }
      : null,
    stats: [
      { label: "Matchup games", value: fmtCount(data.games) },
      { label: "Players", value: fmtCount(data.users) },
    ],
  };
}

/** "56.5%" — the page's one-decimal percentage. */
export function ogPercent(fraction: number): string {
  return fmtPct(fraction);
}
