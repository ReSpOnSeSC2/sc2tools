/**
 * Shared class strings and tiny pure helpers for the /guides pages.
 *
 * Class strings live under components/ (Tailwind only scans app/ and
 * components/), so every utility spelled here is emitted. The recipes
 * mirror the existing kit: the hard-shadow card (`rounded-xl border-2
 * border-line bg-bg-surface shadow-hard`), the `hard-press` pill links
 * from LadderPulse / Header, and the elevated table head of the retired
 * /meta radar.
 */
import { eraPhrase } from "@/lib/guides/guideCopy";
import type { GuideCell, GuideEra, GuideMatchup } from "@/lib/guides/types";

/** The site's signature card surface. */
export const GUIDE_PANEL_CLASS =
  "rounded-xl border-2 border-line bg-bg-surface shadow-hard";

/** Inline text link (accent, underline on hover, visible focus ring). */
export const GUIDE_LINK_CLASS =
  "font-semibold text-accent-cyan underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded-sm";

/** Primary pill link (sign-up style). */
export const GUIDE_PRIMARY_ACTION_CLASS =
  "hard-press inline-flex min-h-[44px] items-center justify-center gap-2 rounded-full border-2 border-line bg-accent px-5 py-2 font-display text-caption font-bold text-white hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

/** Secondary pill link / button. */
export const GUIDE_SECONDARY_ACTION_CLASS =
  "hard-press inline-flex min-h-[44px] items-center justify-center gap-2 rounded-full border-2 border-line bg-bg-surface px-5 py-2 font-display text-caption font-bold text-text hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-60";

/**
 * Scroll container that keeps wide tables from overflowing the page.
 * `relative` makes it the containing block of the cells' absolutely
 * positioned `sr-only` spans; without it they escape the scroller and
 * widen the whole page on phones (caught by the 360 / 375 px e2e).
 */
export const GUIDE_TABLE_WRAP_CLASS = `${GUIDE_PANEL_CLASS} relative overflow-x-auto`;

export const GUIDE_TABLE_CLASS = "w-full min-w-[520px] text-caption";
export const GUIDE_THEAD_CLASS =
  "border-b-2 border-line bg-bg-elevated text-micro uppercase tracking-wider text-text-dim";
export const GUIDE_TH_CLASS = "px-3 py-2 text-left font-semibold";
export const GUIDE_TH_NUM_CLASS = "px-3 py-2 text-right font-semibold";
export const GUIDE_TD_CLASS = "px-3 py-2 align-middle text-text";
export const GUIDE_TD_NUM_CLASS = "px-3 py-2 text-right align-middle tabular-nums text-text-muted";

/** Channel owner credited under every embedded video (their own words). */
export const GUIDE_VIDEO_AUTHOR = "ReSpOnSe";

/** A 50% win rate: a CI wholly above / below it is a clear verdict. */
const COIN_FLIP = 0.5;
const MY_RACE_INDEX = 0;
const OPP_RACE_INDEX = 2;
const RACE_WORDS: Readonly<Record<string, string>> = {
  P: "Protoss",
  T: "Terran",
  Z: "Zerg",
};

export type GuideVerdict = "win" | "loss" | "even";

/**
 * Colour verdict for a cell: only a confidence interval entirely above
 * (or below) 50% reads as a win (or loss); everything else is even.
 *
 * Example: `cellVerdict({ ci: { low: 0.51, high: 0.6 } })` → "win".
 */
export function cellVerdict(cell: Pick<GuideCell, "ci">): GuideVerdict {
  if (cell.ci.low > COIN_FLIP) return "win";
  if (cell.ci.high < COIN_FLIP) return "loss";
  return "even";
}

/** Text colour utility for a verdict. */
export function verdictTextClass(verdict: GuideVerdict): string {
  if (verdict === "win") return "text-success";
  if (verdict === "loss") return "text-danger";
  return "text-text";
}

/**
 * Race word for the viewer ("my") side of a matchup.
 *
 * Example: `myRaceWord("PvZ")` → "Protoss".
 */
export function myRaceWord(matchup: GuideMatchup | string): string {
  return RACE_WORDS[matchup.charAt(MY_RACE_INDEX)] ?? "Player";
}

/**
 * Race word for the opponent side of a matchup.
 *
 * Example: `oppRaceWord("PvZ")` → "Zerg".
 */
export function oppRaceWord(matchup: GuideMatchup | string): string {
  return RACE_WORDS[matchup.charAt(OPP_RACE_INDEX)] ?? "Opponent";
}

/**
 * Which games a payload covers, worded by worker count (`eraPhrase`, the
 * one implementation the guide copy shares). A payload's `patch` names
 * the live patch for BOTH eras, so it is not part of the wording; the
 * optional second argument is ignored and only keeps older
 * `eraLabel(era, patch)` call sites compiling.
 *
 * Example: `eraLabel("after")` → "with 12 starting workers";
 * `eraLabel("before")` → "on the 8-worker patch 5.0.16".
 */
export function eraLabel(era: GuideEra, _patch?: string): string {
  return eraPhrase(era);
}

/**
 * Split a canonical unit name into words for display.
 *
 * Example: `unitDisplayName("VoidRay")` → "Void Ray".
 */
export function unitDisplayName(unit: string): string {
  return unit.replace(/([a-z])([A-Z])/g, "$1 $2");
}
