"use client";

import { useGuideMe } from "@/lib/guides/useGuideMe";
import { timingDelta } from "@/lib/guides/timingDelta";
import { fmtClock, fmtCount } from "@/lib/guides/format";
import type { GuideMilestone, GuideMeMilestone, GuideTimings } from "@/lib/guides/types";
import { GuideSignInPrompt } from "../GuideSignInPrompt";
import { GUIDE_TABLE_CLASS, GUIDE_TABLE_WRAP_CLASS, GUIDE_TD_CLASS, GUIDE_TD_NUM_CLASS, GUIDE_TH_CLASS, GUIDE_TH_NUM_CLASS, GUIDE_THEAD_CLASS } from "../guideUi";
import { milestoneText, splitDelta } from "./buildTimingFormat";

function SplitCell({ milestone }: { milestone: GuideMilestone }) {
  const delta = splitDelta(milestone);
  if (!milestone.winners || !milestone.losers || !delta) return <span className="text-text-dim">—</span>;
  return <span className="block"><span className="text-success">{fmtClock(milestone.winners.median)}</span><span className="text-text-dim"> vs </span><span className="text-danger">{fmtClock(milestone.losers.median)}</span><span className="block text-micro text-text-dim">{delta}</span></span>;
}

function YourTiming({ community, yours, loading }: { community: GuideMilestone; yours?: GuideMeMilestone; loading: boolean }) {
  if (loading) return <span className="inline-block h-8 w-20 animate-pulse rounded bg-bg-elevated" role="status" aria-label="Loading your timing" />;
  if (!yours) return <span className="text-text-dim">—</span>;
  const delta = timingDelta(yours.median, community);
  const tone = delta.tone === "late" ? "text-warning" : delta.tone === "early" ? "text-accent-cyan" : "text-text-muted";
  return <span className="block">{fmtClock(yours.median)}<span className={`block text-micro ${tone}`}><span aria-hidden>{delta.label}{delta.tone ? ` · ${delta.tone === "on-pace" ? "on pace" : delta.tone}` : ""}</span><span className="sr-only">{delta.text}</span></span></span>;
}

export function TimingsTable({ timings, matchupSlug, buildSlug }: { timings: GuideTimings; matchupSlug: string; buildSlug: string }) {
  const query = useGuideMe(matchupSlug, buildSlug);
  const rows = [...timings.milestones].sort((a, b) => a.median - b.median);
  const hasSplit = rows.some((row) => row.winners && row.losers);
  const loading = !query.error && (query.isLoading || !query.data);
  const samples = query.data?.timings.samples ?? 0;
  const showYou = query.isSignedIn && (loading || samples > 0);
  const yours = new Map(query.data?.timings.milestones.map((milestone) => [milestone.key, milestone]) ?? []);
  return <div className="space-y-3">
    {query.isLoaded && !query.isSignedIn ? <GuideSignInPrompt hasTimings /> : null}
    <div className={GUIDE_TABLE_WRAP_CLASS}><table className={GUIDE_TABLE_CLASS}><caption className="sr-only">Key timings from {fmtCount(timings.samples)} recorded build orders, in game time</caption>
      <thead className={GUIDE_THEAD_CLASS}><tr><th scope="col" className={GUIDE_TH_CLASS}>Milestone</th><th scope="col" className={GUIDE_TH_NUM_CLASS}>Early (p25)</th><th scope="col" className={GUIDE_TH_NUM_CLASS}>Median</th><th scope="col" className={GUIDE_TH_NUM_CLASS}>Late (p75)</th>{hasSplit ? <th scope="col" className={GUIDE_TH_NUM_CLASS}>Wins vs losses</th> : null}{showYou ? <th scope="col" className={GUIDE_TH_NUM_CLASS}>You{samples > 0 && samples < 3 ? <span className="block font-normal normal-case">based on {samples} of your games</span> : null}</th> : null}</tr></thead>
      <tbody className="divide-y divide-border">{rows.map((row) => <tr key={row.key}><th scope="row" className={`${GUIDE_TD_CLASS} text-left font-medium`}>{milestoneText(row)}<span className="block text-micro font-normal text-text-dim">in {fmtCount(row.games)} games</span></th><td className={GUIDE_TD_NUM_CLASS}>{fmtClock(row.p25)}</td><td className={`${GUIDE_TD_NUM_CLASS} font-semibold text-text`}>{fmtClock(row.median)}</td><td className={GUIDE_TD_NUM_CLASS}>{fmtClock(row.p75)}</td>{hasSplit ? <td className={GUIDE_TD_NUM_CLASS}><SplitCell milestone={row} /></td> : null}{showYou ? <td className={GUIDE_TD_NUM_CLASS}><YourTiming community={row} yours={yours.get(row.key)} loading={loading} /></td> : null}</tr>)}</tbody>
    </table></div>
  </div>;
}
