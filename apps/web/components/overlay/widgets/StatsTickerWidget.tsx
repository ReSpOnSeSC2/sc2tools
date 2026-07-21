"use client";

/**
 * StatsTickerWidget — an always-on, continuously scrolling bottom
 * line (ESPN style). Unlike the lower third (a stationary 14 s
 * post-game card), this is a persistent thin bar whose segments
 * loop endlessly, composed from four families:
 *
 *   * Live core — session record + net MMR, latest result, rank,
 *     stream goals.
 *   * Opponent intel — who the streamer is playing RIGHT NOW (or
 *     just played): head-to-head, rival/rematch context, MMR gap,
 *     cheese watch, scouted favorite opening, best-answer build,
 *     revealed barcode identity.
 *   * Crystal Ball — the open call (only until voting locks ~a
 *     minute into the game), the last settled call, chat's
 *     collective record, top oracle, top supporter.
 *   * Fun facts — a server-computed pool of career stats, records
 *     and trivia (see the API's TickerFactsService), rotated a page
 *     at a time so every loop reads differently.
 *
 * Segments are built ONLY from real data that exists right now —
 * with nothing to show the source stays transparent.
 *
 * Marquee mechanics: the segment strip is rendered twice back to
 * back and translated -50% on a linear loop, so the wrap is
 * seamless; duration scales with segment count so density doesn't
 * change the reading speed. Reduced-motion renders it statically.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useStudioState } from "@/lib/multichat/useStudioState";
import { useEngagementState } from "@/lib/multichat/useEngagementState";
import { useTickerFacts } from "@/lib/multichat/useTickerFacts";
import { useTestFireFlag } from "@/lib/multichat/useTestFireFlag";
import type { LiveGameEnvelope, LiveGamePayload } from "../types";
import type { SessionSummary } from "./SessionWidget";

/**
 * Constant scroll speed in CSS px per second. The animation duration
 * derives from the strip's MEASURED width at this speed, so wordy
 * segments (career facts are long) read at exactly the same pace as
 * terse ones — pacing by segment count made a facts-heavy strip
 * visibly race. 40 px/s ≈ 5–6 characters/second at the bar's 12.5px
 * font — an unhurried broadcast-ticker pace a viewer can read while
 * watching the game, tuned down from 55 on streamer feedback.
 */
const PX_PER_SEC = 40;
/** Fallback pacing when the strip can't be measured (first paint,
 *  non-layout test environments). */
const SECONDS_PER_SEGMENT = 5;
/** Fun facts shown per marquee loop; the pool rotates page by page. */
const FACTS_PER_LOOP = 10;
/** Clock granularity for the voting-lock check. */
const LOCK_TICK_MS = 10_000;

/** In-game phases where the pre-game envelope describes the CURRENT
 *  opponent (vs. a stale post-game payload). */
const ACTIVE_PHASES = new Set([
  "match_loading",
  "match_started",
  "match_in_progress",
]);

export function StatsTickerWidget({
  token,
  studioEvent,
  engagementEvent,
  live,
  liveGame,
  session,
}: {
  token: string;
  studioEvent?: unknown;
  engagementEvent?: unknown;
  live?: LiveGamePayload | null;
  /** Pre-game/in-game agent envelope — powers the opponent intel. */
  liveGame?: LiveGameEnvelope | null;
  session?: SessionSummary | null;
}) {
  const studio = useStudioState(token, studioEvent ?? null);
  const { summary } = useEngagementState(token, engagementEvent ?? null);
  const facts = useTickerFacts(token);
  const testActive = useTestFireFlag(live, "stats-ticker");

  // Slow clock — drives the voting-lock cutoff without re-rendering
  // the marquee every frame.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), LOCK_TICK_MS);
    return () => clearInterval(t);
  }, []);

  // Everything except the fun-facts page: live core, opponent intel,
  // goals, crystal ball.
  const baseSegments = useMemo(() => {
    if (testActive) return TEST_SEGMENTS;
    const out: string[] = [];
    const s = session ?? live?.session ?? null;
    if (s && Number.isFinite(Number(s.wins))) {
      const net =
        Number.isFinite(Number(s.mmrCurrent)) &&
        Number.isFinite(Number(s.mmrStart))
          ? Number(s.mmrCurrent) - Number(s.mmrStart)
          : null;
      out.push(
        `SESSION ${s.wins}–${s.losses}` +
          (net !== null ? ` · ${net >= 0 ? "+" : ""}${net} MMR` : ""),
      );
    }
    if (live?.result) {
      out.push(
        `LAST GAME: ${live.result === "win" ? "WIN" : "LOSS"}` +
          (live.oppName ? ` vs ${live.oppName}` : "") +
          (live.matchup ? ` (${live.matchup})` : ""),
      );
    }
    if (live?.rank?.league) {
      out.push(
        `RANK: ${live.rank.league}${live.rank.tier ? ` ${live.rank.tier}` : ""}` +
          (live.rank.mmr ? ` · ${live.rank.mmr} MMR` : ""),
      );
    }
    out.push(...opponentSegments(live ?? null, liveGame ?? null));
    for (const g of studio.goals.slice(0, 3)) {
      out.push(`${g.label.toUpperCase()} ${g.current} / ${g.target}`);
    }
    // Open Crystal Ball call — only until the voting window locks
    // (~a minute into the game); after that the prompt would bait
    // viewers into votes the server ignores.
    if (summary.prediction) {
      const locked =
        typeof summary.prediction.locksAtMs === "number" &&
        nowMs > summary.prediction.locksAtMs;
      if (!locked) {
        const t = summary.prediction.tally;
        const pct =
          t.total > 0
            ? ` — chat is ${Math.round((t.win / t.total) * 100)}% WIN`
            : "";
        out.push(`🔮 CALL IT: !win / !loss${pct}`);
      }
    }
    const recap = summary.oracleRecap;
    if (recap.last) {
      out.push(
        `🔮 LAST CALL: chat said ${recap.last.pct}% ${recap.last.majority.toUpperCase()}${recap.last.opponent ? ` vs ${recap.last.opponent}` : ""} — chat was ${recap.last.wasRight ? "RIGHT" : "WRONG"}`,
      );
    }
    if (recap.calls >= 3) {
      out.push(
        `🔮 CHAT ORACLE RECORD: majority right in ${recap.majorityRight} of ${recap.calls} calls`,
      );
    }
    if (summary.wall[0]) {
      out.push(
        `TOP SUPPORTER: ${summary.wall[0].user} (${summary.wall[0].rank})`,
      );
    }
    if (summary.oracles[0]) {
      out.push(
        `TOP ORACLE: ${summary.oracles[0].user} · ${summary.oracles[0].score} pts`,
      );
    }
    return out;
  }, [testActive, session, live, liveGame, studio.goals, summary, nowMs]);

  // Fun-facts page rotation: FACTS_PER_LOOP per loop, next page each
  // loop, so a big pool cycles through everything over a few loops.
  const totalPages = Math.max(1, Math.ceil(facts.length / FACTS_PER_LOOP));
  const [factPage, setFactPage] = useState(0);
  const factChunk = useMemo(() => {
    if (testActive || facts.length === 0) return [];
    const page = factPage % totalPages;
    return facts
      .slice(page * FACTS_PER_LOOP, (page + 1) * FACTS_PER_LOOP)
      .map((f) => f.text);
  }, [testActive, facts, factPage, totalPages]);

  const segments = useMemo(
    () => [...baseSegments, ...factChunk],
    [baseSegments, factChunk],
  );

  // Constant-speed pacing: measure the (single-copy) strip width and
  // derive the loop duration at PX_PER_SEC. scrollWidth is 0 in
  // non-layout environments — fall back to per-segment pacing there.
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [stripHalfPx, setStripHalfPx] = useState(0);
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    setStripHalfPx(el.scrollWidth / 2);
  }, [segments]);
  const durationSec = Math.max(
    20,
    stripHalfPx > 0
      ? stripHalfPx / PX_PER_SEC
      : segments.length * SECONDS_PER_SEGMENT,
  );

  useEffect(() => {
    if (totalPages <= 1) return;
    const t = setInterval(() => {
      setFactPage((p) => (p + 1) % totalPages);
    }, durationSec * 1000);
    return () => clearInterval(t);
  }, [totalPages, durationSec]);

  if (segments.length === 0) {
    return <div style={{ background: "transparent" }} />;
  }

  const strip = segments.map((text, i) => (
    <span key={i} style={segmentStyle}>
      <span style={diamondStyle}>◆</span>
      {text}
    </span>
  ));

  return (
    <div style={frameStyle}>
      <style>{`
        .ticker-strip { display: inline-flex; animation: tickerScroll ${durationSec}s linear infinite; }
        @keyframes tickerScroll { to { transform: translateX(-50%); } }
        @media (prefers-reduced-motion: reduce) {
          .ticker-strip { animation: none; }
        }
      `}</style>
      <div style={barStyle}>
        <div style={badgeStyle}>LIVE</div>
        <div style={windowStyle}>
          <div className="ticker-strip" ref={stripRef}>
            {strip}
            {strip.map((el, i) => (
              <span key={`dup-${i}`} aria-hidden style={segmentStyle}>
                <span style={diamondStyle}>◆</span>
                {segments[i]}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Current-opponent intel segments. During a game the agent envelope's
 * ``streamerHistory`` describes the live opponent; between games the
 * post-game payload carries the same fields for the one just played.
 */
function opponentSegments(
  live: LiveGamePayload | null,
  liveGame: LiveGameEnvelope | null,
): string[] {
  const inGame =
    !!liveGame &&
    !liveGame.isReplay &&
    ACTIVE_PHASES.has(String(liveGame.phase)) &&
    !!liveGame.streamerHistory;
  const intel = inGame ? liveGame?.streamerHistory ?? null : live;
  if (!intel) return [];
  const out: string[] = [];
  const name = intel.oppName || "";

  if (inGame && name) {
    out.push(
      `NOW PLAYING: vs ${name}` +
        (intel.matchup ? ` (${intel.matchup})` : "") +
        (Number.isFinite(Number(intel.oppMmr))
          ? ` · ${Number(intel.oppMmr).toLocaleString("en-US")} MMR`
          : ""),
    );
  }
  if (intel.oppRevealedName) {
    out.push(`BARCODE REVEALED: this is ${intel.oppRevealedName}`);
  }
  const h2h = intel.headToHead;
  if (h2h && h2h.wins + h2h.losses > 0 && name) {
    out.push(`HEAD-TO-HEAD vs ${name}: ${h2h.wins}–${h2h.losses}`);
  }
  if (intel.rival?.name && intel.rival.headToHead) {
    const r = intel.rival.headToHead;
    out.push(`RIVAL ALERT: ${intel.rival.name} — ${r.wins}–${r.losses} lifetime`);
  }
  if (intel.rematch?.isRematch && intel.rematch.lastResult) {
    out.push(
      intel.rematch.lastResult === "win"
        ? `REMATCH: won the last meeting — keep the boot down`
        : `REMATCH: dropped the last one — revenge arc`,
    );
  }
  const oppMmr = Number(intel.oppMmr);
  const myMmr = Number(
    (live && Number.isFinite(Number(live.myMmr)) ? live.myMmr : undefined) ??
      intel.rank?.mmr,
  );
  if (Number.isFinite(oppMmr) && Number.isFinite(myMmr) && myMmr > 0) {
    const gap = Math.round(oppMmr - myMmr);
    if (Math.abs(gap) >= 25) {
      out.push(
        gap > 0
          ? `MMR GAP: opponent +${gap} — upset material`
          : `MMR GAP: opponent ${gap} — protect the rating`,
      );
    }
  }
  const cheese = Number(intel.cheeseProbability);
  if (Number.isFinite(cheese) && cheese >= 0.4) {
    out.push(
      `⚠️ CHEESE WATCH: ${Math.round(cheese * 100)}% of this opponent's games open cheesy`,
    );
  }
  if (intel.favOpening?.name && Number(intel.favOpening.samples) >= 3) {
    out.push(
      `SCOUT: they open ${intel.favOpening.name} ${Math.round(Number(intel.favOpening.share) * 100)}% of the time`,
    );
  }
  const answer = intel.bestAnswer;
  if (answer?.build && Number(answer.total) >= 3) {
    out.push(
      `BEST ANSWER: ${answer.build} — ${Math.round(Number(answer.winRate) * 100)}% vs their favorite opening`,
    );
  }
  const predicted = intel.predictedStrategies?.[0];
  if (!intel.favOpening && predicted?.name) {
    out.push(
      `PREDICTION: ${predicted.name} (${Math.round(Number(predicted.weight) * 100)}%)`,
    );
  }
  return out;
}

const TEST_SEGMENTS = [
  "TEST · this is your stats ticker",
  "SESSION 4–2 · +34 MMR",
  "NOW PLAYING: vs TestOpponent (PvZ) · 4,612 MMR",
  "HEAD-TO-HEAD vs TestOpponent: 5–3",
  "⚠️ CHEESE WATCH: 48% of this opponent's games open cheesy",
  "FOLLOWER GOAL 1168 / 1200",
  "🔮 CALL IT: !win / !loss — chat is 68% WIN",
  "🔮 CHAT ORACLE RECORD: majority right in 12 of 19 calls",
  "TOP SUPPORTER: TestGrinder (Immortal)",
  "CAREER: 1,482 W – 1,301 L (53%) over 2,891 tracked games",
  "PEAK MMR: 4,712 on NA (Aug 12, 2025) — 138 away right now",
  "TIME SUPPLY BLOCKED (career): 6.3 hrs — build more pylons",
];

/* ──────────────── styles ──────────────── */

const frameStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "flex-end",
  fontFamily: "var(--ov-font, Inter, ui-sans-serif, system-ui, sans-serif)",
};

const barStyle: CSSProperties = {
  display: "flex",
  alignItems: "stretch",
  width: "100%",
  height: 34,
  background:
    "var(--ov-panel-bg, linear-gradient(180deg, rgba(13,16,23,0.96) 0%, rgba(9,11,16,0.96) 100%))",
  border: "var(--ov-shell-border, 1px solid rgba(255,255,255,0.10))",
  borderRadius: "var(--ov-radius, 8px)",
  boxShadow: "0 4px 16px rgba(0,0,0,0.45)",
  overflow: "hidden",
  color: "#e6e8ee",
};

const badgeStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "0 12px",
  background: "var(--ov-accent, #3ec0c7)",
  color: "#06251f",
  fontSize: 11,
  fontWeight: 900,
  letterSpacing: "0.14em",
  flexShrink: 0,
};

const windowStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  alignItems: "center",
  overflow: "hidden",
  whiteSpace: "nowrap",
};

const segmentStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 10,
  padding: "0 18px",
  fontSize: 12.5,
  fontWeight: 700,
  letterSpacing: "0.05em",
  fontVariantNumeric: "tabular-nums",
};

const diamondStyle: CSSProperties = {
  color: "var(--ov-accent, #3ec0c7)",
  fontSize: 8,
};
