/**
 * HighlightsStrip — stat tiles under the report totals: longest win
 * streak, biggest upset, favorite map and the nemesis (or best victim).
 * These are the visitor's own local games, so opponent names show here;
 * the share card and the text summary never carry them. Each tile hides
 * when its value is missing, and the strip hides when every tile does.
 *
 * Example:
 *   <HighlightsStrip highlights={report.highlights} />
 */
import type { ReportHighlights } from "@/lib/instant/report";
import { hasHighlights } from "@/lib/instant/reportHighlights";
import { formatReportDate, gamesLabel, winratePercent } from "./ReportBits";

function Tile({ label, value, detail }: { label: string; value: string; detail?: string | null }) {
  return (
    <li className="min-w-0 rounded-xl border-2 border-line bg-bg-surface p-3 shadow-hard">
      <p className="text-micro font-semibold uppercase tracking-wider text-text-dim">{label}</p>
      <p className="mt-1 break-words font-display text-h4 text-text">{value}</p>
      {detail ? <p className="mt-0.5 break-words text-caption text-text-muted">{detail}</p> : null}
    </li>
  );
}

function upsetDetail(upset: NonNullable<ReportHighlights["biggestUpset"]>): string {
  const parts = [`+${upset.mmrGap} MMR`];
  if (upset.map) parts.push(`on ${upset.map}`);
  const date = formatReportDate(upset.date);
  if (date) parts.push(date);
  return parts.join(" · ");
}

export function HighlightsStrip({ highlights }: { highlights: ReportHighlights | null | undefined }) {
  if (!highlights || !hasHighlights(highlights)) return null;
  const { longestWinStreak, biggestUpset, favoriteMap, nemesis, bestVictim } = highlights;
  const rival = nemesis ? { label: "Nemesis", who: nemesis } : bestVictim ? { label: "Best victim", who: bestVictim } : null;
  const mapRate = favoriteMap ? winratePercent(favoriteMap.wins, favoriteMap.games - favoriteMap.wins) : null;
  return (
    <ul aria-label="Highlights" data-testid="report-highlights" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {longestWinStreak !== null ? <Tile label="Longest win streak" value={String(longestWinStreak)} detail="wins in a row" /> : null}
      {biggestUpset ? <Tile label="Biggest upset" value={`Beat ${biggestUpset.opponentName ?? "a higher-rated opponent"}`} detail={upsetDetail(biggestUpset)} /> : null}
      {favoriteMap ? <Tile label="Favorite map" value={favoriteMap.name} detail={`${gamesLabel(favoriteMap.games)}${mapRate === null ? "" : ` · ${Math.round(favoriteMap.winrate * 100)}%`}`} /> : null}
      {rival ? <Tile label={rival.label} value={rival.who.name} detail={rival.who.record} /> : null}
    </ul>
  );
}
