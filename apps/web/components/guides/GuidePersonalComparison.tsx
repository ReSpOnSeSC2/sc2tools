"use client";

import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { useApi } from "@/lib/clientApi";
import { fmtClock, fmtCount, fmtPct } from "@/lib/guides/format";
import type { GuideMePayload, GuideMilestoneEvent } from "@/lib/guides/types";
import { GUIDE_LINK_CLASS } from "@/components/guides/guideUi";

/**
 * GuidePersonalComparison — the signed-in viewer's own record with this
 * build next to the community medians: "You: 48.6% over 37 games ·
 * Twilight Council started 4:52 (community 4:50)". Reads the private,
 * never-cached `/v1/guides/me/<matchup>/<build>`; signed-out visitors
 * get a sign-in link instead (no request is made for them).
 */

export interface CommunityMilestone {
  key: string;
  label: string;
  event: GuideMilestoneEvent;
  median: number;
}

export interface GuidePersonalComparisonProps {
  matchupSlug: string;
  buildSlug: string;
  buildName: string;
  community: ReadonlyArray<CommunityMilestone>;
}

const BOX_CLASS = "rounded-lg border border-border bg-bg-elevated/60 px-3 py-2 text-caption text-text-muted";

function eventWord(event: GuideMilestoneEvent): string {
  return event === "finish" ? "done" : "started";
}

function recordText(me: GuideMePayload): string {
  const games = `${fmtCount(me.games)} game${me.games === 1 ? "" : "s"}`;
  if (me.winRate === null) return `You: ${games}, no decided games yet`;
  return `You: ${fmtPct(me.winRate)} over ${games}`;
}

function MyTimings({
  me,
  community,
}: {
  me: GuideMePayload;
  community: ReadonlyArray<CommunityMilestone>;
}) {
  const byKey = new Map(community.map((milestone) => [milestone.key, milestone]));
  const rows = me.timings.milestones.filter((milestone) => byKey.has(milestone.key));
  if (rows.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5">
      {rows.map((milestone) => (
        <li key={milestone.key} className="tabular-nums">
          Median {milestone.label} {eventWord(milestone.event)}{" "}
          <span className="font-semibold text-text">{fmtClock(milestone.median)}</span>{" "}
          (community {fmtClock(byKey.get(milestone.key)?.median)})
        </li>
      ))}
    </ul>
  );
}

function SignedInComparison({
  matchupSlug,
  buildSlug,
  buildName,
  community,
}: GuidePersonalComparisonProps) {
  const { data, error, isLoading } = useApi<GuideMePayload>(
    `/v1/guides/me/${matchupSlug}/${buildSlug}`,
  );
  if (error) return <p className={BOX_CLASS}>Couldn&apos;t load your numbers right now.</p>;
  if (isLoading || !data) return <p className={BOX_CLASS}>Loading your numbers…</p>;
  if (data.games === 0) {
    return (
      <p className={BOX_CLASS}>
        You haven&apos;t played {buildName} with 12 starting workers yet — upload a few games to compare.
      </p>
    );
  }
  return (
    <div className={BOX_CLASS} data-testid="guide-me">
      <p className="font-semibold text-text">{recordText(data)}</p>
      <MyTimings me={data} community={community} />
    </div>
  );
}

/** Sign-in prompt; without community timings there is only the win rate to compare. */
function SignInPrompt({ hasTimings }: { hasTimings: boolean }) {
  return (
    <p className={BOX_CLASS}>
      <Link href="/sign-in" className={GUIDE_LINK_CLASS}>
        {hasTimings ? "Sign in to compare your timings" : "Sign in to compare your win rate"}
      </Link>{" "}
      {hasTimings ? "with the community medians." : "with this build to the community's."}
    </p>
  );
}

function ComparisonBody(props: GuidePersonalComparisonProps) {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <div className="min-h-[2.5rem]" aria-hidden />;
  if (!isSignedIn) return <SignInPrompt hasTimings={props.community.length > 0} />;
  return <SignedInComparison {...props} />;
}

/** Polite live region: the loaded numbers replace "Loading…" asynchronously. */
export function GuidePersonalComparison(props: GuidePersonalComparisonProps) {
  return (
    <div aria-live="polite">
      <ComparisonBody {...props} />
    </div>
  );
}
