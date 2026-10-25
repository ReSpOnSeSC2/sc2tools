"use client";

import type { MapPlayback } from "@/lib/mapReplay";
import Link from "next/link";

export function PlaybackAccuracyBadge({ playback, estimatedCreep }: { playback: MapPlayback; estimatedCreep: boolean }) {
  return <Link href="/help/game-page-accurate-playback" aria-label="Replay accuracy"
    onClick={event => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const disclosure = event.currentTarget.closest("[data-playback-section]")?.querySelector<HTMLDetailsElement>("[data-playback-explainer]");
      if (!disclosure) return;
      event.preventDefault(); disclosure.open = true; disclosure.querySelector<HTMLElement>("summary")?.focus();
    }}
    className="absolute bottom-2 left-2 inline-flex min-h-11 max-w-[calc(100%-1rem)] items-center rounded-md border border-white/10 bg-black/80 px-2 py-1 text-xs leading-snug text-white hover:underline focus-visible:ring-2 focus-visible:ring-accent">
    {playback.fidelity?.positions === "engine" ? "Recorded game playback" : playback.v >= 6 ? "Limited position data · gaps hold last position" : "Older replay data · re-sync for accurate positions"}
    {playback.fidelity?.complete === false ? " · partial recording" : ""}
    {playback.fidelity?.positions === "engine" && playback.fidelity.attacks !== "observed" ? " · regenerate for attacks" : ""}
    {estimatedCreep ? " · estimated creep" : ""}
  </Link>;
}
