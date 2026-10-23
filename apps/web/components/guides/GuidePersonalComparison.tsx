"use client";

import { lazy, Suspense } from "react";
import Link from "next/link";
import { useGuideMe } from "@/lib/guides/useGuideMe";
import { fmtClock, fmtCount, fmtPct, fmtDeltaPp } from "@/lib/guides/format";
import type { GuideMePayload, GuideMilestoneEvent } from "@/lib/guides/types";
import { GUIDE_LINK_CLASS } from "./guideUi";
import { GuideSignInPrompt } from "./GuideSignInPrompt";

const RequestError = lazy(() => import("@/components/ui/RequestError").then((module) => ({ default: module.RequestError })));
const BOX_CLASS = "rounded-lg border border-border bg-bg-elevated/60 px-3 py-2 text-caption text-text-muted";

export interface CommunityMilestone { key: string; label: string; event: GuideMilestoneEvent; median: number; p25?: number; p75?: number }
export interface GuidePersonalComparisonProps {
  matchupSlug: string; buildSlug: string; buildName: string; community: ReadonlyArray<CommunityMilestone>;
  communityWinRate?: number; showTimings?: boolean; showSignInPrompt?: boolean;
}

function recordText(me: GuideMePayload, communityWinRate?: number): string {
  const games = `${fmtCount(me.games)} game${me.games === 1 ? "" : "s"}`;
  if (me.winRate === null || me.wins + me.losses === 0) return `You: ${games}, no decided games yet`;
  const comparison = communityWinRate == null ? "" : ` · community ${fmtPct(communityWinRate)} (${fmtDeltaPp(me.winRate - communityWinRate)})`;
  return `You: ${fmtPct(me.winRate)} over ${games}${comparison}`;
}

function MyTimings({ me, community }: { me: GuideMePayload; community: ReadonlyArray<CommunityMilestone> }) {
  const byKey = new Map(community.map((milestone) => [milestone.key, milestone]));
  return me.timings.milestones.length ? <ul className="mt-1 space-y-0.5">{me.timings.milestones.map((milestone) => <li key={milestone.key} className="tabular-nums">
    Median {milestone.label} {milestone.event === "finish" ? "done" : "started"} <span className="font-semibold text-text">{fmtClock(milestone.median)}</span>{byKey.has(milestone.key) ? ` (community ${fmtClock(byKey.get(milestone.key)?.median)})` : ""}
  </li>)}</ul> : null;
}

export function GuidePersonalComparison({ matchupSlug, buildSlug, buildName, community, communityWinRate, showTimings = true, showSignInPrompt = true }: GuidePersonalComparisonProps) {
  const query = useGuideMe(matchupSlug, buildSlug);
  if (!query.isLoaded) return <div className="min-h-[2.5rem]" aria-hidden />;
  if (!query.isSignedIn) return showSignInPrompt ? <GuideSignInPrompt hasTimings={community.length > 0} /> : null;
  if (query.error) return <Suspense fallback={<p role="status" className={BOX_CLASS}>Couldn&apos;t load your numbers.</p>}><RequestError title="Couldn't load your numbers." error={query.error} onRetry={() => query.mutate()} /></Suspense>;
  if (query.isLoading || !query.data) return <p role="status" className={BOX_CLASS}>Loading your numbers…</p>;
  const me = query.data;
  if (me.games === 0) return <p className={BOX_CLASS}>You haven&apos;t played {buildName} with 12 starting workers yet — <Link href="/download" className={GUIDE_LINK_CLASS}>upload a few games</Link> to compare.</p>;
  return <div className={BOX_CLASS} data-testid="guide-me" aria-live="polite"><p className="font-semibold text-text">{recordText(me, communityWinRate)}</p>{showTimings ? <MyTimings me={me} community={community} /> : null}<Link href="/app/builds" className={`${GUIDE_LINK_CLASS} mt-2 inline-flex min-h-11 items-center`}>See all your builds</Link></div>;
}
