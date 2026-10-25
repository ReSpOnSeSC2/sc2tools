"use client";
import dynamic from "next/dynamic";
import { useLiveScouting } from "./useLiveScouting";

const ScoutingBriefCard = dynamic(() => import("./ScoutingBriefCard").then(module => module.ScoutingBriefCard));

export function LiveScoutingBrief() {
  const { live, unavailable, retry } = useLiveScouting();
  return live ? <ScoutingBriefCard key={live.gameKey || live.opponent?.name} live={live} unavailable={unavailable} onRetry={retry} /> : null;
}
