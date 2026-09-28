"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Radio, TrendingUp } from "lucide-react";
import { useToastOptional } from "@/components/ui/Toast";
import { gaEvent } from "@/lib/analytics/gtag";
import type { GhostTarget } from "@/lib/ghostBuild";
import type { GuideMatchup } from "@/lib/guides/types";
import {
  GUIDE_LINK_CLASS,
  GUIDE_PRIMARY_ACTION_CLASS,
  GUIDE_SECONDARY_ACTION_CLASS,
} from "@/components/guides/guideUi";

/**
 * GuideCtas — the three calls to action on a build guide:
 *   1. "Track your win rate with this build — free" → /sign-up (Clerk
 *      already routes new accounts through /welcome);
 *   2. "Practice it on stream" → arms the community-median Ghost Build
 *      target for this matchup (localStorage only; the ghost-build code
 *      is loaded on click, not with the page) and points to Settings →
 *      Overlay, where the widget URL is copied;
 *   3. "See what's winning" → the matchup page.
 * Every click fires gaEvent("guide_cta_click", { cta, matchup, build }).
 */

/** Same event GhostGradeCard dispatches so open overlay settings re-read the target. */
const GHOST_ARMED_EVENT = "sc2tools:ghost-build-armed";
const CTA_EVENT = "guide_cta_click";
const OVERLAY_SETTINGS_HREF = "/settings#overlay";

type CtaName = "track" | "practice" | "matchup";
type ArmStatus = "idle" | "armed" | "failed";

export interface GuideCtasProps {
  matchup: GuideMatchup;
  /** Build slug, or null on pages that are not about one build. */
  buildSlug: string | null;
  matchupPath: string;
  /** Community-median practice target; null hides the practice CTA. */
  ghostTarget: GhostTarget | null;
}

async function armTarget(matchup: GuideMatchup, target: GhostTarget): Promise<boolean> {
  try {
    const [{ armGhostTargetForMatchup }, { ghostRacesForMatchup }] = await Promise.all([
      import("@/lib/ghostBuild"),
      import("@/lib/guides/ghost"),
    ]);
    const { myRace, opponentRace } = ghostRacesForMatchup(matchup);
    const isArmed = armGhostTargetForMatchup(myRace, opponentRace, target);
    if (isArmed) window.dispatchEvent(new Event(GHOST_ARMED_EVENT));
    return isArmed;
  } catch {
    return false;
  }
}

export function GuideCtas({ matchup, buildSlug, matchupPath, ghostTarget }: GuideCtasProps) {
  const toastApi = useToastOptional();
  const [status, setStatus] = useState<ArmStatus>("idle");
  const track = (cta: CtaName) => gaEvent(CTA_EVENT, { cta, matchup, build: buildSlug });

  const onPractice = async () => {
    if (!ghostTarget) return;
    track("practice");
    const isArmed = await armTarget(matchup, ghostTarget);
    setStatus(isArmed ? "armed" : "failed");
    if (isArmed) {
      toastApi?.toast.success(`Saved “${ghostTarget.name}” for ${matchup}`, {
        description: "Copy the updated Ghost Build widget URL from Settings → Overlay.",
      });
    } else {
      toastApi?.toast.error("Couldn't save the Ghost Build in this browser.");
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Link href="/sign-up" onClick={() => track("track")} className={GUIDE_PRIMARY_ACTION_CLASS}>
          <TrendingUp className="h-4 w-4" aria-hidden />
          Track your win rate with this build — free
        </Link>
        {ghostTarget ? (
          <button type="button" onClick={onPractice} className={GUIDE_SECONDARY_ACTION_CLASS}>
            <Radio className="h-4 w-4" aria-hidden />
            Practice it on stream
          </button>
        ) : null}
        <Link href={matchupPath} onClick={() => track("matchup")} className={GUIDE_SECONDARY_ACTION_CLASS}>
          See what&apos;s winning
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>
      <PracticeStatus status={status} />
    </div>
  );
}

function PracticeStatus({ status }: { status: ArmStatus }) {
  if (status === "idle") return <p role="status" className="sr-only" />;
  if (status === "failed") {
    return (
      <p role="status" className="text-caption text-danger">
        Couldn&apos;t save the Ghost Build here (private browsing or storage blocked).
      </p>
    );
  }
  return (
    <p role="status" className="text-caption text-text-muted">
      Ghost Build armed.{" "}
      <Link href={OVERLAY_SETTINGS_HREF} className={GUIDE_LINK_CLASS}>
        Open Settings → Overlay
      </Link>{" "}
      to copy the widget URL into OBS.
    </p>
  );
}
