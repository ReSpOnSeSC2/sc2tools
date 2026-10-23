"use client";

import { lazy, Suspense } from "react";
import { useAuth } from "@clerk/nextjs";
import type { GuideMilestoneEvent } from "@/lib/guides/types";
import { GuideSignInPrompt } from "./GuideSignInPrompt";

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
  if (!isSignedIn) return props.showSignInPrompt !== false ? <GuideSignInPrompt hasTimings={props.community.length > 0} /> : null;
  return <Suspense fallback={<p role="status" className="text-caption text-text-muted">Loading your numbers…</p>}><SignedInComparison {...props} /></Suspense>;
}
