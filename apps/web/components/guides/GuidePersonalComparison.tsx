"use client";

import { lazy, Suspense } from "react";
import { useAuth } from "@clerk/nextjs";
import type { GuideMilestoneEvent } from "@/lib/guides/types";
import { GuideSignInPrompt } from "./GuideSignInPrompt";
import Link from "next/link";
import { getInstantImportMode } from "@/lib/instant/flag";
import { tryFocusHref } from "@/lib/instant/reportGuideTypes";

const SignedInComparison = lazy(() => import("./GuideSignedInComparison").then((module) => ({ default: module.GuideSignedInComparison })));
export interface CommunityMilestone { key: string; label: string; event: GuideMilestoneEvent; median: number; p25?: number; p75?: number }
export interface GuidePersonalComparisonProps {
  matchupSlug: string; buildSlug: string; buildName: string; community: ReadonlyArray<CommunityMilestone>;
  communityWinRate?: number; showTimings?: boolean; showSignInPrompt?: boolean;
}

/** Private data and its client code are only requested after signed-in auth resolves. */
export function GuidePersonalComparison(props: GuidePersonalComparisonProps) {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <div className="min-h-[2.5rem]" aria-hidden />;
  if (!isSignedIn) {
    const href = getInstantImportMode() === "all" ? tryFocusHref(props.matchupSlug, props.buildSlug) : null;
    const showSignIn = props.showSignInPrompt !== false;
    return showSignIn || href ? <div className="space-y-2">{showSignIn ? <GuideSignInPrompt hasTimings={props.community.length > 0} /> : null}{href ? <p className="text-caption text-text-muted">or <Link href={href} className="inline-flex min-h-11 items-center font-semibold text-accent underline underline-offset-4">analyze your replays in your browser — no download</Link></p> : null}</div> : null;
  }
  return <Suspense fallback={<p role="status" className="text-caption text-text-muted">Loading your numbers…</p>}><SignedInComparison {...props} /></Suspense>;
}
