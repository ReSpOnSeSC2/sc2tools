"use client";

import Link from "next/link";
import { Crosshair, X } from "lucide-react";
import { GHOST_MATCHUPS } from "@/lib/ghostBuild";
import { useGhostPractice } from "@/lib/useGhostPractice";

export function PracticeChip() {
  const practice = useGhostPractice();
  const assigned = GHOST_MATCHUPS.filter(slot => practice.config.slots[slot]);
  const slot = assigned[0], target = slot ? practice.config.slots[slot] : null;
  if (!practice.owner || !slot || !target) return null;
  return <div className="mx-auto flex w-full max-w-[1680px] flex-wrap items-center gap-2 px-4 pt-2 text-caption sm:px-6 lg:px-8">
    <span className="inline-flex min-w-0 max-w-full items-center rounded-full border border-accent/30 bg-accent/10 px-3 text-accent" title={`${assigned.length} matchup${assigned.length === 1 ? "" : "s"} assigned. Ghost selects the exact active-game matchup.`}>
      <Link href="/settings?tab=overlay&section=look" className="inline-flex min-h-11 min-w-0 items-center gap-2"><Crosshair className="h-4 w-4 shrink-0" aria-hidden /><span className="truncate">Practicing: {target.name} ({slot}){assigned.length > 1 ? ` · +${assigned.length - 1}` : ""}{practice.offline ? " · cached" : ""}</span></Link>
      <button type="button" disabled={practice.saving || practice.loading || !!practice.readError} aria-label={`Disarm ${slot} practice`} onClick={() => void practice.assign(slot, null, target)} className="ml-1 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><X className="h-4 w-4" aria-hidden /></button>
    </span>
    {practice.error ? <span role="alert" className="text-danger">{practice.error}</span> : null}
  </div>;
}
