"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall } from "@/lib/clientApi";
import { pct1, wrColor } from "@/lib/format";
import { GameStage } from "../../shells/GameStage";
import { IconFor } from "../../icons";
import { registerMode, weekKey } from "../../ArcadeEngine";
import { buildUniverse, rolling14DayWr } from "../../sessions";
import { useArcadeState } from "../../hooks/useArcadeState";
import type {
  GenerateInput,
  GenerateResult,
  Mode,
  ScoreResult,
  StockMarketState,
} from "../../types";

const ID = "stock-market";
registerMode(ID, "generative");

type Quote = {
  id: string;
  name: string;
  race?: string;
  /** Price = WR × 100, 0..100; null if not enough plays. */
  price: number | null;
  source: "own" | "community" | "custom" | "catalog";
  /**
   * Total times the user has played this build. Feeds the volatility
   * multiplier — fewer plays = more sample noise = wider P&L swings.
   * Zero for community/custom/catalog rows the user hasn't run yet.
   */
  plays: number;
};

type Q = {
  weekKey: string;
  quotes: Quote[];
  /** Existing locked portfolio for this week (server-persisted). */
  locked: StockMarketState | null;
};

type A = { picks: Array<{ id: string; alloc: number }>; submitToLeaderboard: boolean };

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
function pctReturn(entryPrice: number, currentPrice: number): number {
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
function volatility(plays: number): number {
  const n = Math.max(1, plays);
  const raw = Math.sqrt(VOL_BASELINE_PLAYS / n);
  return Math.max(VOL_MIN, Math.min(VOL_MAX, raw));
}

async function generate(input: GenerateInput): Promise<GenerateResult<Q>> {
  const universe = buildUniverse(input.data);
  if (universe.length < 5) {
    return {
      ok: false,
      reason: "Need ≥5 builds in your universe to allocate. Play a few more.",
    };
  }
  const now = new Date();
  const wk = weekKey(now, input.tz);
  const quotes: Quote[] = universe.map((b) => ({
    id: b.id,
    name: b.name,
    race: b.race,
    price:
      b.source === "own"
        ? Math.max(0, Math.min(100, Math.round(b.winRate * 100)))
        : (() => {
            const wr = rolling14DayWr(b.name, input.data, now);
            return wr === null ? null : Math.round(wr * 100);
          })(),
    source: b.source,
    // Play count drives the volatility multiplier. UnifiedBuild keeps
    // totalPlays at 0 for community/custom/catalog rows the user
    // hasn't run — those land at the max (2.0×) volatility because
    // sample size is effectively zero.
    plays: b.totalPlays,
  }));
  const tradeable = quotes.filter((q) => q.price !== null);
  if (tradeable.length < 1) {
    return {
      ok: false,
      reason: "Need at least one build with a recent price (≥3 plays in 14 days).",
    };
  }
  return { ok: true, minDataMet: true, question: { weekKey: wk, quotes, locked: null } };
}

function score(q: Q, a: A): ScoreResult {
  // The "score" of a Stock Market submission is the locked weight; the
  // engine doesn't grade selection (P&L is computed when the week
  // closes). XP is awarded on lock-in to keep the daily streak alive.
  const totalAlloc = a.picks.reduce((s, p) => s + p.alloc, 0);
  const valid = a.picks.length > 0 && a.picks.length <= 5 && totalAlloc === 100;
  return {
    raw: valid ? 1 : 0,
    xp: valid ? 15 : 0,
    outcome: valid ? "correct" : "wrong",
    note: valid
      ? "Portfolio locked for the week. P&L tallies when the week closes."
      : "Allocations must total 100 across ≤5 picks.",
  };
}

export const stockMarket: Mode<Q, A> = {
  id: ID,
  kind: "game",
  category: "forecast",
  difficulty: "medium",
  ttp: "medium",
  depthTag: "generative",
  title: "Stock Market",
  blurb: "Allocate 100 Mineral Credits across ≤5 builds. P&L = Σ(weight × Δprice).",
  generate,
  score,
  render: (ctx) => <Render ctx={ctx} />,
};

function Render({
  ctx,
}: {
  ctx: Parameters<Mode<Q, A>["render"]>[0];
}) {
  const { state, update, hydrated } = useArcadeState();
  const { getToken } = useAuth();
  // Render every quote (tradeable + untradeable) so the user sees the
  // full universe across all matchups. Untradeable rows are visually
  // labelled and the allocation input is disabled — they're stalls
  // for "we know this build exists, you just haven't played it 3+
  // times in the last 14 days yet."
  const sortedQuotes = useMemo(
    () =>
      ctx.question.quotes
        .slice()
        .sort((a, b) => {
          // Tradeable first, then by descending price within each group.
          const aT = a.price !== null ? 1 : 0;
          const bT = b.price !== null ? 1 : 0;
          if (aT !== bT) return bT - aT;
          return (b.price ?? 0) - (a.price ?? 0);
        }),
    [ctx.question.quotes],
  );
  const locked = state.stockMarket && state.stockMarket.weekKey === ctx.question.weekKey
    ? state.stockMarket
    : null;
  const [picks, setPicks] = useState<Record<string, number>>(() => {
    if (!locked) return {};
    const out: Record<string, number> = {};
    for (const p of locked.picks) out[p.slug] = p.alloc;
    return out;
  });
  const [optIn, setOptIn] = useState(state.leaderboardOptIn);
  const [name, setName] = useState(state.leaderboardDisplayName);

  const [submitError, setSubmitError] = useState<string | null>(null);

  // useArcadeState hydrates asynchronously — the useState initializers
  // above capture pre-hydrate defaults (optIn=true, name=""). Once
  // the real saved state lands, mirror it into the draft form fields
  // so a returning user sees their previous opt-in choice and display
  // name without having to re-toggle. Guarded by `hydrated` so we
  // sync exactly once on transition; subsequent user edits are not
  // overwritten on re-render.
  const syncedFromHydrateRef = useRef(false);
  useEffect(() => {
    if (!hydrated || syncedFromHydrateRef.current) return;
    syncedFromHydrateRef.current = true;
    setOptIn(state.leaderboardOptIn);
    setName(state.leaderboardDisplayName);
  }, [hydrated, state.leaderboardOptIn, state.leaderboardDisplayName]);

  const totalAlloc = Object.values(picks).reduce((s, v) => s + v, 0);
  const slotsUsed = Object.keys(picks).filter((k) => picks[k] > 0).length;

  const setPick = (id: string, value: number) => {
    setPicks((prev) => {
      const next = { ...prev };
      const v = Math.max(0, Math.min(100, Math.floor(value)));
      if (v === 0) {
        delete next[id];
      } else {
        next[id] = v;
      }
      return next;
    });
  };

  const submit = async () => {
    const portfolioPicks = Object.entries(picks)
      .filter(([, v]) => v > 0)
      .map(([id, alloc]) => {
        const q = ctx.question.quotes.find((quote) => quote.id === id)!;
        return {
          slug: id,
          alloc,
          entryPrice: q.price ?? 0,
          // Snapshot play count at lock time so the volatility
          // multiplier is fixed for the week — playing the build
          // heavily during the open window doesn't retroactively
          // shrink your variance bonus.
          entryPlays: q.plays,
        };
      });
    const valid = portfolioPicks.length > 0 && portfolioPicks.length <= 5 && totalAlloc === 100;
    if (!valid) {
      ctx.onAnswer({ picks: portfolioPicks.map((p) => ({ id: p.slug, alloc: p.alloc })), submitToLeaderboard: optIn });
      return;
    }
    update((prev) => ({
      ...prev,
      stockMarket: {
        weekKey: ctx.question.weekKey,
        lockedAt: new Date().toISOString(),
        picks: portfolioPicks,
      },
      leaderboardOptIn: optIn,
      leaderboardDisplayName: name,
    }));
    ctx.onAnswer({ picks: portfolioPicks.map((p) => ({ id: p.slug, alloc: p.alloc })), submitToLeaderboard: optIn });
    if (optIn) {
      // Surface failures inline instead of swallowing them — silently
      // catching meant users whose POST 401'd or got rate-limited saw
      // their portfolio "lock" without ever entering the leaderboard,
      // with no way to tell. Lock is already persisted by the update()
      // above, so a leaderboard POST failure leaves the portfolio
      // safe locally; we just tell the user it didn't post publicly.
      try {
        await apiCall(getToken, "/v1/arcade/leaderboard", {
          method: "POST",
          body: JSON.stringify({
            weekKey: ctx.question.weekKey,
            pnlPct: 0,
            displayName: name,
          }),
        });
        setSubmitError(null);
      } catch (err) {
        setSubmitError(
          err instanceof Error
            ? `Couldn't post to leaderboard: ${err.message}. Your portfolio is still locked locally.`
            : "Couldn't post to leaderboard. Your portfolio is still locked locally.",
        );
      }
    }
  };

  const lockedView = locked ? (
    <div className="space-y-3">
      <p className="text-caption text-text-muted">
        Portfolio locked for{" "}
        <span className="font-mono text-text">{ctx.question.weekKey}</span>. P&amp;L tallies when the week closes.
      </p>
      {submitError ? (
        <p
          role="alert"
          className="rounded border border-danger/40 bg-danger/10 px-2 py-1 text-caption text-danger"
        >
          {submitError}
        </p>
      ) : null}
      <ul className="space-y-1">
        {locked.picks.map((p) => {
          const cur = ctx.question.quotes.find((q) => q.id === p.slug);
          // Per-pick P&L = % return × volatility(entryPlays). The
          // % return makes price matter (low-price builds have more
          // headroom per Δprice); the volatility multiplier makes
          // play count matter (fewer plays = wider variance).
          // entryPlays is optional for back-compat with portfolios
          // locked before the volatility model existed — those use
          // the neutral 1.0× multiplier.
          const ret =
            cur && cur.price !== null && p.entryPrice > 0
              ? pctReturn(p.entryPrice, cur.price)
              : null;
          const vol =
            typeof p.entryPlays === "number" ? volatility(p.entryPlays) : 1.0;
          const adjusted = ret !== null ? ret * vol : null;
          return (
            <li
              key={p.slug}
              className="flex items-center justify-between rounded border border-border bg-bg-surface px-2 py-1"
            >
              <span className="truncate text-text">{cur?.name || p.slug}</span>
              <span className="font-mono tabular-nums text-text-dim">
                {p.alloc}% @ {p.entryPrice}
                {typeof p.entryPlays === "number" ? (
                  <span className="ml-1 text-[10px] uppercase tracking-wider text-text-dim">
                    × {vol.toFixed(2)} vol
                  </span>
                ) : null}{" "}
                {adjusted !== null ? (
                  <span
                    className={
                      adjusted > 0
                        ? "text-success"
                        : adjusted < 0
                          ? "text-danger"
                          : "text-text-dim"
                    }
                  >
                    ({adjusted > 0 ? "+" : ""}
                    {(adjusted * 100).toFixed(1)}%)
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
      <Link
        href="/community/leaderboard"
        className="text-caption text-accent hover:underline"
      >
        See the weekly leaderboard →
      </Link>
    </div>
  ) : null;

  const editor = !locked ? (
    <div className="space-y-3">
      <details className="rounded-lg border border-border bg-bg-elevated">
        <summary className="cursor-pointer list-none px-3 py-2 text-caption">
          <span className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-text">
              How the Stock Market works
            </span>
            <Link
              href="/community/leaderboard"
              className="text-accent hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              View leaderboard →
            </Link>
          </span>
        </summary>
        <div className="space-y-2 border-t border-border px-3 py-2 text-caption text-text-muted">
          <p>
            <span className="font-semibold text-text">Price</span> = rolling
            14-day win rate × 100 for builds you&apos;ve played. Builds with
            fewer than 3 plays in the window have no price and aren&apos;t
            tradeable.
          </p>
          <p>
            <span className="font-semibold text-text">Portfolio</span> = up to
            5 builds with weights summing to 100. Locks on submit and cannot
            be edited until next Monday 00:00 local time.
          </p>
          <p>
            <span className="font-semibold text-text">P&amp;L</span> = Σ(weight
            × % return × volatility), where % return = Δprice ÷ entry price
            and volatility scales with how often you&apos;ve played the build.
            A 5-point gain on a price-30 build is worth +16.7% on that share;
            the same 5-point gain on a price-90 build is worth +5.6%.
            Low-price builds offer bigger swings; high-price builds are
            tighter.
          </p>
          <p>
            <span className="font-semibold text-text">Volatility</span>{" "}
            (× multiplier on each pick&apos;s return) tracks the law of large
            numbers — fewer plays mean wider sample variance, so few-play
            builds amplify both wins and losses. Anchored at ~30 plays =
            1.0×, capped between 0.75× (heavily-played veterans, ~50+ plays)
            and 2.0× (brand-new or rarely-played builds, ≤7 plays). Two
            independent levers: <em>price</em> drives % return per Δprice,
            <em> plays</em> drives the variance multiplier on top of it.
          </p>
          <p>
            <span className="font-semibold text-text">Leaderboard</span> —
            on by default; untick to keep the lock private. Submissions
            anonymize to your display name when set, otherwise a stable hash.
          </p>
        </div>
      </details>
      <p className="text-caption text-text-muted">
        Allocate up to 100 across ≤5 builds for{" "}
        <span className="font-mono text-text">{ctx.question.weekKey}</span>.
        P&amp;L is weighted by % return on each build&apos;s entry price.
      </p>
      <ul className="space-y-1">
        {sortedQuotes.map((q) => {
          const tradeable = q.price !== null;
          return (
            <li
              key={q.id}
              className={[
                "flex items-center gap-2 rounded border px-2 py-2",
                tradeable
                  ? "border-border bg-bg-surface"
                  : "border-border bg-bg-surface/40",
              ].join(" ")}
            >
              <span
                className={[
                  "min-w-0 flex-1 truncate",
                  tradeable ? "text-text" : "text-text-muted",
                ].join(" ")}
              >
                {q.name}
                {q.source !== "own" ? (
                  <span className="ml-1 rounded bg-accent/15 px-1 text-[10px] uppercase tracking-wider text-accent">
                    {q.source}
                  </span>
                ) : null}
              </span>
              {tradeable ? (
                <span
                  className="font-mono tabular-nums text-caption"
                  style={{ color: wrColor((q.price ?? 0) / 100, 5) }}
                >
                  {q.price}
                </span>
              ) : (
                <span className="text-[10px] uppercase tracking-wider text-text-dim">
                  no price yet
                </span>
              )}
              <span
                className="font-mono tabular-nums text-[10px] uppercase tracking-wider"
                title={`${q.plays} plays → ${volatility(q.plays).toFixed(2)}× P&L volatility`}
                style={{
                  color:
                    volatility(q.plays) > 1.25
                      ? "var(--warning, #f5a524)"
                      : volatility(q.plays) < 0.85
                        ? "var(--text-dim, #71717a)"
                        : "var(--text-muted, #a1a1aa)",
                }}
              >
                {volatility(q.plays).toFixed(2)}×
              </span>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={3}
                value={picks[q.id] ? String(picks[q.id]) : ""}
                placeholder="0"
                aria-label={`Allocation for ${q.name}`}
                onChange={(e) => {
                  // Strip non-digits and leading zeros so typing "4" into a
                  // field that previously displayed "0" yields "4", not "04"
                  // or "040". Empty input clears the pick.
                  const digits = e.target.value.replace(/\D/g, "");
                  const trimmed = digits.replace(/^0+/, "");
                  setPick(q.id, trimmed === "" ? 0 : Number(trimmed));
                }}
                onFocus={(e) => e.currentTarget.select()}
                disabled={!tradeable}
                className="h-9 w-20 rounded border border-border bg-bg-elevated px-2 text-right font-mono tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
              />
              <span className="text-caption text-text-dim">%</span>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-3 text-caption">
        <span className="text-text-muted">
          Picks: <span className="font-mono tabular-nums text-text">{slotsUsed}/5</span>
        </span>
        <span
          className={[
            "font-mono tabular-nums",
            totalAlloc === 100 ? "text-success" : "text-warning",
          ].join(" ")}
        >
          Total {totalAlloc} / 100
        </span>
      </div>
      <fieldset
        className={[
          "rounded-lg border p-3",
          optIn
            ? "border-accent/60 bg-accent/10"
            : "border-border bg-bg-elevated",
        ].join(" ")}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-body font-semibold text-text">
            <input
              type="checkbox"
              checked={optIn}
              onChange={(e) => setOptIn(e.target.checked)}
              className="h-5 w-5 rounded border-border bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
            {optIn
              ? "Posting to public weekly leaderboard"
              : "Locking privately — not on leaderboard"}
          </label>
          <Link
            href="/community/leaderboard"
            className="text-caption text-accent hover:underline"
          >
            View leaderboard →
          </Link>
        </div>
        <p className="mt-1 pl-7 text-caption text-text-muted">
          {optIn
            ? "On by default. Untick if you want this week's portfolio to stay private."
            : "Tick the box to enter the public weekly P&L ranking."}
        </p>
        {optIn ? (
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 60))}
            placeholder="Display name (leave blank to stay anonymous)"
            className="mt-2 h-9 w-full rounded border border-border bg-bg px-2 text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
        ) : null}
      </fieldset>
    </div>
  ) : null;

  return (
    <GameStage
      icon={IconFor(ID)}
      title={stockMarket.title}
      depthLabel="Generative: weekly portfolio scored on Δprice"
      hud={{
        score: locked ? "locked" : `${totalAlloc}/100`,
        hint: locked
          ? "Re-allocate next Monday"
          : `Pick up to 5 builds — total must equal 100`,
      }}
      isDaily={ctx.isDaily}
      body={locked ? lockedView : editor}
      primary={
        !locked ? (
          <button
            type="button"
            onClick={submit}
            disabled={totalAlloc !== 100 || slotsUsed === 0 || slotsUsed > 5}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md bg-accent px-4 text-caption font-semibold uppercase tracking-wider text-bg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            {optIn ? "Lock & post to leaderboard" : "Lock portfolio (private)"}
          </button>
        ) : null
      }
    />
  );
}
