/**
 * replayTheme — the handful of values the HUD panels share.
 *
 * Side colours are the SAME two the canvas paints with (``ME_ARMY`` /
 * ``OPP_ARMY`` in ``MapReplayer``): cyan is you, red is the opponent.
 * They are literals rather than Tailwind tokens because the canvas
 * needs them as CSS colour strings too, and one game must not read as
 * two different blues.
 */

import type { ReplaySide } from "@/lib/replayHud";

export const SIDE_COLOR: Readonly<Record<ReplaySide, string>> = {
  me: "#3ec0c7",
  opp: "#e05656",
};

/** Faint fill behind a side's rows, at the same hues. */
export const SIDE_TINT: Readonly<Record<ReplaySide, string>> = {
  me: "rgba(62,192,199,0.10)",
  opp: "rgba(224,86,86,0.10)",
};

/** The stage is darker than the app's own surfaces on purpose — a
 *  replay reads like a video player, not a card. */
export const STAGE_BG = "#070a0f";

/** Panel chrome shared by both rails, so they cannot drift.
 *  Deliberately carries NO display utility — the host
 *  sets ``flex`` / ``hidden`` per breakpoint and two competing display
 *  classes in one string resolve by stylesheet order, not by intent. */
export const RAIL_CLASS =
  "min-h-0 flex-col rounded-lg border border-border bg-bg-elevated/40";
export const RAIL_HEADER_CLASS =
  "flex items-center gap-1.5 border-b border-border px-2.5 py-2";
export const SECTION_LABEL_CLASS =
  "px-2.5 pb-1 pt-2 text-micro font-semibold uppercase tracking-wider text-text-dim";

export function sideLabel(
  side: ReplaySide,
  myName?: string | null,
  oppName?: string | null,
): string {
  if (side === "me") return (myName || "").trim() || "You";
  return (oppName || "").trim() || "Opponent";
}
