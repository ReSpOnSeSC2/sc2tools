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
  me: "rgba(62,192,199,0.14)",
  opp: "rgba(224,86,86,0.14)",
};

/** The stage is darker than the app's own surfaces on purpose — a
 *  replay reads like a video player, not a card. */
export const STAGE_BG = "#070a0f";

/**
 * The colour scope every part of the replay must sit inside.
 *
 * ``STAGE_BG`` is painted regardless of the app theme, but the panels
 * are built from token utilities (``text-text-dim``, ``border-border``,
 * …) that resolve against the PAGE's ground. In the light theme that
 * meant near-black ink on a near-black stage. ``.replay-scope``
 * (app/globals.css) re-declares those tokens against ``STAGE_BG``, so
 * the stage renders identically in both themes.
 *
 * Any host that paints ``STAGE_BG`` — the stage, the compact drilldown,
 * a bare fullscreen replayer — MUST carry this class.
 */
export const REPLAY_SCOPE_CLASS = "replay-scope";

/** Panel chrome shared by both rails, so they cannot drift.
 *  Deliberately carries NO display utility — the host
 *  sets ``flex`` / ``hidden`` per breakpoint and two competing display
 *  classes in one string resolve by stylesheet order, not by intent. */
export const RAIL_CLASS =
  "min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-bg-surface/80";
export const RAIL_HEADER_CLASS =
  "flex shrink-0 items-center gap-2 border-b border-border bg-bg-elevated/60 px-3 py-2";
export const SECTION_LABEL_CLASS =
  "px-3 pb-1.5 pt-3 text-micro font-semibold uppercase tracking-[0.08em] text-text-dim";

/** Segmented-control pill, shared by the rails' tabs and filters so
 *  every toggle in the HUD reads as one control family. */
export function chipClass(active: boolean): string {
  return [
    "rounded-md border px-2 py-1 text-micro font-semibold transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan",
    active
      ? "border-accent-cyan/70 bg-accent-cyan/15 text-text"
      : "border-border bg-bg-elevated text-text-muted hover:border-border-strong hover:text-text",
  ].join(" ");
}

export function sideLabel(
  side: ReplaySide,
  myName?: string | null,
  oppName?: string | null,
): string {
  if (side === "me") return (myName || "").trim() || "You";
  return (oppName || "").trim() || "Opponent";
}
