export type TimingTone = "on-pace" | "early" | "late";

/** Timing bands describe the middle half of players, never whether a build is correct. */
export function timingDelta(youSec: number, community: { median: number; p25?: number | null; p75?: number | null }): {
  deltaSec: number; label: string; tone: TimingTone | null; text: string;
} {
  if (!Number.isFinite(youSec) || !Number.isFinite(community.median)) return { deltaSec: 0, label: "—", tone: null, text: "Timing comparison unavailable" };
  const raw = youSec - community.median;
  const deltaSec = Math.abs(raw) < 1 ? 0 : Math.round(raw);
  const hasBand = typeof community.p25 === "number" && Number.isFinite(community.p25) && typeof community.p75 === "number" && Number.isFinite(community.p75) && community.p25 <= community.p75;
  const tone = hasBand ? youSec < community.p25! ? "early" : youSec > community.p75! ? "late" : "on-pace" : null;
  const label = deltaSec === 0 ? "same" : `${deltaSec > 0 ? "+" : "−"}${Math.abs(deltaSec)}s`;
  const comparison = deltaSec === 0 ? "the same as the community median" : `${Math.abs(deltaSec)} second${Math.abs(deltaSec) === 1 ? "" : "s"} ${deltaSec > 0 ? "later" : "earlier"} than the community median`;
  const band = tone === "late" ? ", later than most players" : tone === "early" ? ", earlier than most players" : tone === "on-pace" ? ", within the middle half of players" : "";
  return { deltaSec, label, tone, text: `Your median is ${comparison}${band}` };
}
