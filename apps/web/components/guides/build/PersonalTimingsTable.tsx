"use client";

import { useGuideMe } from "@/lib/guides/useGuideMe";
import { timingDelta } from "@/lib/guides/timingDelta";
import { fmtClock } from "@/lib/guides/format";
import type { GuideMilestone, GuideMeMilestone, GuideTimings } from "@/lib/guides/types";
import { GuideSignInPrompt } from "../GuideSignInPrompt";
import { TimingsTableContent } from "./TimingsTableContent";

function YourTiming({ community, yours, loading }: { community: GuideMilestone; yours?: GuideMeMilestone; loading: boolean }) {
  if (loading) return <span className="inline-block h-8 w-20 animate-pulse rounded bg-bg-elevated" role="status" aria-label="Loading your timing" />;
  if (!yours) return <span className="text-text-dim">—</span>;
  const delta = timingDelta(yours.median, community);
  const tone = delta.tone === "late" ? "text-warning" : delta.tone === "early" ? "text-accent-cyan" : "text-text-muted";
  return <span className="block">{fmtClock(yours.median)}<span className={`block text-micro ${tone}`}><span aria-hidden>{delta.label}{delta.tone ? ` · ${delta.tone === "on-pace" ? "on pace" : delta.tone}` : ""}</span><span className="sr-only">{delta.text}</span></span></span>;
}

export function PersonalTimingsTable({ timings, matchupSlug, buildSlug }: { timings: GuideTimings; matchupSlug: string; buildSlug: string }) {
  const query = useGuideMe(matchupSlug, buildSlug);
  const loading = !query.error && (query.isLoading || !query.data);
  const samples = query.data?.timings.samples ?? 0;
  const showYou = query.isSignedIn && (loading || samples > 0);
  const byKey = new Map(query.data?.timings.milestones.map((milestone) => [milestone.key, milestone]) ?? []);
  const yours = showYou ? {
    header: <>You{samples > 0 && samples < 3 ? <span className="block font-normal normal-case tracking-normal">based on {samples} of your games</span> : null}</>,
    cells: new Map(timings.milestones.map((row) => [row.key, <YourTiming key={row.key} community={row} yours={byKey.get(row.key)} loading={loading} />])),
  } : undefined;
  return <div className="space-y-3">{!query.isSignedIn ? <GuideSignInPrompt hasTimings /> : null}<TimingsTableContent timings={timings} yours={yours} /></div>;
}
