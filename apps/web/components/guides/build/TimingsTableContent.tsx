import type { ReactNode } from "react";
import { fmtClock, fmtCount } from "@/lib/guides/format";
import type { GuideMilestone, GuideTimings } from "@/lib/guides/types";
import { GUIDE_TABLE_CLASS, GUIDE_TABLE_WRAP_CLASS, GUIDE_TD_CLASS, GUIDE_TD_NUM_CLASS, GUIDE_TH_CLASS, GUIDE_TH_NUM_CLASS, GUIDE_THEAD_CLASS } from "../guideUi";
import { milestoneText, splitDelta } from "./buildTimingFormat";

function SplitCell({ milestone }: { milestone: GuideMilestone }) {
  const delta = splitDelta(milestone);
  if (!milestone.winners || !milestone.losers || !delta) return <span className="text-text-dim">—</span>;
  return <span className="block"><span className="text-success">{fmtClock(milestone.winners.median)}</span><span className="text-text-dim"> vs </span><span className="text-danger">{fmtClock(milestone.losers.median)}</span><span className="block text-micro text-text-dim">{delta}</span></span>;
}

/** Pure markup is shared by SSR and the optional private enhancement. */
export function TimingsTableContent({ timings, yours }: { timings: GuideTimings; yours?: { header: ReactNode; cells: ReadonlyMap<string, ReactNode> } }) {
  const rows = [...timings.milestones].sort((a, b) => a.median - b.median);
  const hasSplit = rows.some((row) => row.winners && row.losers);
  const pinName = yours ? "sticky left-0 z-10 w-36 max-w-36" : "";
  const pinYou = "sticky right-0 z-10 min-w-28 border-l border-border";
  return <div className="space-y-2">{yours ? <p className="text-micro text-text-dim sm:hidden">Scroll for community timings; your column stays in view.</p> : null}<div className={GUIDE_TABLE_WRAP_CLASS}><table className={GUIDE_TABLE_CLASS}><caption className="sr-only">Key timings from {fmtCount(timings.samples)} recorded build orders, in game time</caption>
    <thead className={GUIDE_THEAD_CLASS}><tr><th scope="col" className={`${GUIDE_TH_CLASS} ${pinName} bg-bg-elevated`}>Milestone</th><th scope="col" className={GUIDE_TH_NUM_CLASS}>Early (p25)</th><th scope="col" className={GUIDE_TH_NUM_CLASS}>Median</th><th scope="col" className={GUIDE_TH_NUM_CLASS}>Late (p75)</th>{hasSplit ? <th scope="col" className={GUIDE_TH_NUM_CLASS}>Wins vs losses</th> : null}{yours ? <th scope="col" className={`${GUIDE_TH_NUM_CLASS} ${pinYou} bg-bg-elevated`}>{yours.header}</th> : null}</tr></thead>
    <tbody className="divide-y divide-border">{rows.map((row) => <tr key={row.key}><th scope="row" className={`${GUIDE_TD_CLASS} ${pinName} bg-bg-surface text-left font-medium`}>{milestoneText(row)}<span className="block text-micro font-normal text-text-dim">in {fmtCount(row.games)} games</span></th><td className={GUIDE_TD_NUM_CLASS}>{fmtClock(row.p25)}</td><td className={`${GUIDE_TD_NUM_CLASS} font-semibold text-text`}>{fmtClock(row.median)}</td><td className={GUIDE_TD_NUM_CLASS}>{fmtClock(row.p75)}</td>{hasSplit ? <td className={GUIDE_TD_NUM_CLASS}><SplitCell milestone={row} /></td> : null}{yours ? <td className={`${GUIDE_TD_NUM_CLASS} ${pinYou} bg-bg-surface`}>{yours.cells.get(row.key)}</td> : null}</tr>)}</tbody>
  </table></div></div>;
}
