"use client";

/**
 * StatsTickerWidget — an always-on, continuously scrolling bottom
 * line (ESPN style). Unlike the lower third (a stationary 14 s
 * post-game card), this is a persistent thin bar whose segments
 * loop endlessly: session record + net MMR, latest result, rank,
 * stream goals, an open Crystal Ball call, top supporter and top
 * oracle. Segments are built ONLY from real data that exists right
 * now — with nothing to show the source stays transparent.
 *
 * Marquee mechanics: the segment strip is rendered twice back to
 * back and translated -50% on a linear loop, so the wrap is
 * seamless; duration scales with segment count so density doesn't
 * change the reading speed. Reduced-motion renders it statically.
 */

import { useMemo, type CSSProperties } from "react";
import { useStudioState } from "@/lib/multichat/useStudioState";
import { useEngagementState } from "@/lib/multichat/useEngagementState";
import { useTestFireFlag } from "@/lib/multichat/useTestFireFlag";
import type { LiveGamePayload } from "../types";
import type { SessionSummary } from "./SessionWidget";

const SECONDS_PER_SEGMENT = 4;

export function StatsTickerWidget({
  token,
  studioEvent,
  engagementEvent,
  live,
  session,
}: {
  token: string;
  studioEvent?: unknown;
  engagementEvent?: unknown;
  live?: LiveGamePayload | null;
  session?: SessionSummary | null;
}) {
  const studio = useStudioState(token, studioEvent ?? null);
  const { summary } = useEngagementState(token, engagementEvent ?? null);
  const testActive = useTestFireFlag(live, "stats-ticker");

  const segments = useMemo(() => {
    if (testActive) {
      return [
        "TEST · this is your stats ticker",
        "SESSION 4–2 · +34 MMR",
        "LAST GAME: WIN vs TestOpponent (PvZ)",
        "FOLLOWER GOAL 1168 / 1200",
        "🔮 CALL IT: !win / !loss — chat is 68% WIN",
        "TOP SUPPORTER: TestGrinder (Immortal)",
      ];
    }
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
    for (const g of studio.goals.slice(0, 3)) {
      out.push(`${g.label.toUpperCase()} ${g.current} / ${g.target}`);
    }
    if (summary.prediction) {
      const t = summary.prediction.tally;
      const pct =
        t.total > 0
          ? ` — chat is ${Math.round((t.win / t.total) * 100)}% WIN`
          : "";
      out.push(`🔮 CALL IT: !win / !loss${pct}`);
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
  }, [testActive, session, live, studio.goals, summary]);

  if (segments.length === 0) {
    return <div style={{ background: "transparent" }} />;
  }

  const durationSec = Math.max(20, segments.length * SECONDS_PER_SEGMENT);
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
          <div className="ticker-strip">
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
