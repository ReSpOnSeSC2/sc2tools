import type { GuideMilestone } from "@/lib/guides/types";

export function milestoneText(milestone: Pick<GuideMilestone, "label" | "event">): string {
  return `${milestone.label} ${milestone.event === "finish" ? "done" : "started"}`;
}

/** Use the same rounded medians printed in the cells. */
export function splitDelta(milestone: Pick<GuideMilestone, "winners" | "losers">): string | null {
  if (!milestone.winners || !milestone.losers) return null;
  const gap = Math.round(milestone.winners.median) - Math.round(milestone.losers.median);
  if (gap === 0) return "same in wins and losses";
  return `${Math.abs(gap)}s ${gap < 0 ? "earlier" : "later"} in wins`;
}
