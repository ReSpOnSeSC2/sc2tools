import Link from "next/link";
import { TrendBadge } from "@/components/guides/TrendBadge";
import { WinRateCell } from "@/components/guides/WinRateCell";
import { guidePaths } from "@/components/guides/guideMetadata";
import {
  GUIDE_LINK_CLASS,
  GUIDE_TABLE_CLASS,
  GUIDE_TABLE_WRAP_CLASS,
  GUIDE_TD_CLASS,
  GUIDE_TD_NUM_CLASS,
  GUIDE_TH_CLASS,
  GUIDE_TH_NUM_CLASS,
  GUIDE_THEAD_CLASS,
} from "@/components/guides/guideUi";
import { fmtCount, fmtPct } from "@/lib/guides/format";
import type { GuideOpenerRow } from "@/lib/guides/types";

/**
 * The ranked openers of a matchup (the API sorts by the Wilson lower
 * bound, never the raw win rate): win rate with its interval whisker,
 * n, prevalence (hidden in band views, where the API sends none) and the
 * week-over-week movement. Only published openers link to a guide, and
 * only when `canLinkGuides`: guide pages always serve the current patch,
 * so a before-patch ranking (whose `published` flags describe that era)
 * lists names without links or "once more games are in" hints.
 */
export function OpenersTable({
  openers,
  matchupSlug,
  caption,
  canLinkGuides,
}: {
  openers: ReadonlyArray<GuideOpenerRow>;
  matchupSlug: string;
  caption: string;
  canLinkGuides: boolean;
}) {
  const hasPrevalence = openers.some((row) => row.prevalence !== null);
  return (
    <div className={GUIDE_TABLE_WRAP_CLASS}>
      <table className={GUIDE_TABLE_CLASS}>
        <caption className="sr-only">{caption}</caption>
        <thead className={GUIDE_THEAD_CLASS}>
          <tr>
            <th scope="col" className={GUIDE_TH_CLASS}>#</th>
            <th scope="col" className={GUIDE_TH_CLASS}>Opener</th>
            <th scope="col" className={GUIDE_TH_NUM_CLASS}>Win rate</th>
            <th scope="col" className={GUIDE_TH_NUM_CLASS}>Games</th>
            {hasPrevalence ? <th scope="col" className={GUIDE_TH_NUM_CLASS}>Played in</th> : null}
            <th scope="col" className={GUIDE_TH_NUM_CLASS}>Trend</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {openers.map((row, index) => (
            <tr key={row.buildKey}>
              <td className={`${GUIDE_TD_CLASS} w-8 tabular-nums text-text-dim`}>{index + 1}</td>
              <th scope="row" className={`${GUIDE_TD_CLASS} text-left font-medium`}>
                {canLinkGuides && row.published ? (
                  <Link href={guidePaths.build(matchupSlug, row.buildSlug)} className={GUIDE_LINK_CLASS}>
                    {row.name}
                  </Link>
                ) : (
                  <span className="text-text">{row.name}</span>
                )}
                {canLinkGuides && !row.published ? (
                  <span className="block text-micro font-normal text-text-dim">Full guide once more games are in</span>
                ) : null}
              </th>
              <td className={GUIDE_TD_NUM_CLASS}>
                <WinRateCell winRate={row.winRate} ci={row.ci} />
              </td>
              <td className={GUIDE_TD_NUM_CLASS}>
                {fmtCount(row.games)}
                <span className="block text-micro text-text-dim">{fmtCount(row.users)} players</span>
              </td>
              {hasPrevalence ? (
                <td className={GUIDE_TD_NUM_CLASS}>{row.prevalence === null ? "—" : fmtPct(row.prevalence)}</td>
              ) : null}
              <td className={GUIDE_TD_NUM_CLASS}>
                <TrendBadge trend={row.trend} isNew={row.isNew} showDelta />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
