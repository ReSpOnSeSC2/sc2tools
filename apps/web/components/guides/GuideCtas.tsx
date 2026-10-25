"use client";

import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { ArrowRight, TrendingUp } from "lucide-react";
import { PracticeButton } from "@/components/practice/PracticeButton";
import { gaEvent } from "@/lib/analytics/gtag";
import type { GhostTarget } from "@/lib/ghostBuild";
import type { GuideMatchup } from "@/lib/guides/types";
import {
  GUIDE_PRIMARY_ACTION_CLASS,
  GUIDE_SECONDARY_ACTION_CLASS,
} from "@/components/guides/guideUi";

/**
 * GuideCtas — the three calls to action on a build guide:
 *   1. "Track your win rate with this build — free" → /sign-up (Clerk
 *      already routes new accounts through /welcome);
 *   2. Practice → account assignment through the shared lazy split button.
 *   3. "See what's winning" → the matchup page.
 * Every click fires gaEvent("guide_cta_click", { cta, matchup, build }).
 */

const CTA_EVENT = "guide_cta_click";
type CtaName = "track" | "practice" | "matchup" | "record" | "my-builds" | "upload";

export interface GuideCtasProps {
  matchup: GuideMatchup;
  /** Build slug, or null on pages that are not about one build. */
  buildSlug: string | null;
  matchupPath: string;
  /** Community-median practice target; null hides the practice CTA. */
  ghostTarget: GhostTarget | null;
}

export function GuideCtas({ matchup, buildSlug, matchupPath, ghostTarget }: GuideCtasProps) {
  const { isLoaded, isSignedIn } = useAuth();
  const signedIn = isLoaded && isSignedIn;
  const track = (cta: CtaName) => gaEvent(CTA_EVENT, { cta, matchup, build: buildSlug });

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Link href={signedIn ? "#your-record" : "/sign-up"} onClick={(event) => {
          track(signedIn ? "record" : "track");
          if (signedIn) {
            const target = document.getElementById("your-record");
            if (target) { event.preventDefault(); target.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }); }
          }
        }} className={GUIDE_PRIMARY_ACTION_CLASS}>
          <TrendingUp className="h-4 w-4" aria-hidden />
          {signedIn ? "See your record with this build" : "Track your win rate with this build — free"}
        </Link>
        {signedIn ? <Link href="/app/builds" className={GUIDE_SECONDARY_ACTION_CLASS} onClick={() => track("my-builds")}>Open my builds</Link> : null}
        {ghostTarget ? <PracticeButton build={{ name: ghostTarget.name, race: matchup[0], vsRace: matchup[2] }} target={ghostTarget} matchup={matchup} onPractice={() => track("practice")} /> : null}
        <Link href={matchupPath} onClick={() => track("matchup")} className={GUIDE_SECONDARY_ACTION_CLASS}>
          See what&apos;s winning
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>
    </div>
  );
}
