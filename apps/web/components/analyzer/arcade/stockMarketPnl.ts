/**
 * Stock Market P&L math — shared by the locked-portfolio view and the
 * end-of-week settlement that records a week's result (Tycoon badge,
 * weekly leaderboard). Pure functions only.
 */

import type { StockMarketState } from "./types";

/**
 * Per-pick % return on entry price — the standard portfolio math.
 * Returns a number in basis-points-of-WR terms, e.g. +0.333 means the
 * pick gained 33.3% on its entry price (a price-30 build at 40).
 * Used both for locked-view display and for the end-of-week P&L
 * computation. Distinct from raw Δprice: a 5-point gain on a price-90
 * build (+5.6% return) ranks differently from a 5-point gain on a
 * price-30 build (+16.7% return) — that's what makes the price column
 * matter strategically rather than cosmetically.
 */
export function pctReturn(entryPrice: number, currentPrice: number): number {
  if (entryPrice <= 0) return 0;
  return (currentPrice - entryPrice) / entryPrice;
}

/**
 * Anchor point for the play-volume volatility curve. A build played
 * this many times sits at the neutral 1.0× multiplier; fewer plays
 * amplify P&L, more plays damp it. Picked so that "you've played
 * about a month's worth of ladder" feels like the baseline.
 */
const VOL_BASELINE_PLAYS = 30;
/** Floor and ceiling on the multiplier so a single-play build can't dominate the portfolio. */
const VOL_MIN = 0.75;
const VOL_MAX = 2.0;

/**
 * Play-volume volatility multiplier on per-pick P&L. Layers on top of
 * the % return calculation so the price column AND the play-count
 * column both shape risk/reward:
 *
 *   pnl_per_pick = alloc × pctReturn(entry, now) × volatility(plays)
 *
 * Modelled on the standard error of a proportion (~ 1/√n): few plays
 * = high sample noise = wider realised swings, both up and down.
 * Anchored at VOL_BASELINE_PLAYS = 30 → 1.0×, with a √(BASELINE/n)
 * curve bounded by VOL_MIN..VOL_MAX so a single-play build (raw 5.5×)
 * doesn't trivially dominate optimal strategy and a 1000-play veteran
 * still has a non-zero floor.
 *
 * Sample table (rounded):
 *   plays   1   2   5   8  10  20  30  50 100 1000
 *   vol  2.00 2.00 2.00 1.94 1.73 1.22 1.00 0.77 0.75 0.75
 *
 * Strategic effect: a brand-new build is 2× more volatile than your
 * baseline; a 100-play veteran is 0.75×. Cheap unplayed underdogs
 * stack TWO multipliers (low price → high % return per Δprice, low
 * plays → wide variance); expensive veterans get TWO dampeners. Real
 * risk/reward axis with two independent levers.
 */
export function volatility(plays: number): number {
  const n = Math.max(1, plays);
  const raw = Math.sqrt(VOL_BASELINE_PLAYS / n);
  return Math.max(VOL_MIN, Math.min(VOL_MAX, raw));
}

/** Current price for one build, or null when it has no tradeable price. */
export interface PnlQuote {
  id: string;
  price: number | null;
}

/**
 * One pick's volatility-adjusted return, or null when either price is
 * unusable (the build has no current price, or a zero entry price).
 */
export function pickReturn(
  pick: StockMarketState["picks"][number],
  currentPrice: number | null | undefined,
): number | null {
  if (typeof currentPrice !== "number" || pick.entryPrice <= 0) return null;
  const vol = typeof pick.entryPlays === "number" ? volatility(pick.entryPlays) : 1.0;
  return pctReturn(pick.entryPrice, currentPrice) * vol;
}

/**
 * Portfolio P&L in percent: Σ(weight × volatility-adjusted % return).
 * A pick whose build has lost its price (fewer than 3 recent plays)
 * contributes 0 — its value is carried flat, never guessed.
 *
 * Example: 100% in a price-40 build now at 50, entered with 30 plays
 * (1.0× volatility) → +25.0.
 */
export function portfolioPnlPct(
  picks: StockMarketState["picks"],
  quotes: readonly PnlQuote[],
): number {
  const priceById = new Map(quotes.map((q) => [q.id, q.price]));
  let total = 0;
  for (const pick of picks) {
    const ret = pickReturn(pick, priceById.get(pick.slug));
    if (ret !== null) total += (pick.alloc / 100) * ret;
  }
  return Math.round(total * 1000) / 10;
}
