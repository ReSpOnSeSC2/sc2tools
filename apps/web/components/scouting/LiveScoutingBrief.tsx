"use client";
import { ScoutingBriefCard } from "./ScoutingBriefCard";
import { useLiveScouting } from "./useLiveScouting";

export function LiveScoutingBrief() {
  const { live, unavailable, retry } = useLiveScouting();
  return live ? <ScoutingBriefCard key={live.gameKey || live.opponent?.name} live={live} unavailable={unavailable} onRetry={retry} /> : null;
}
