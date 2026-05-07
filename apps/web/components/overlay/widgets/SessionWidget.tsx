"use client";

import { useEffect, useState } from "react";
import type { LiveGamePayload } from "../types";
import { WidgetShell } from "../WidgetShell";

export type SessionSummary = {
  wins: number;
  losses: number;
  games: number;
  mmrStart?: number;
  mmrCurrent?: number;
  region?: string;
  sessionStartedAt?: string;
  streak?: { kind: "win" | "loss"; count: number };
  /**
   * Set when the aggregate was emitted by the Test route. The
   * overlay clients use this to put the normally-persistent session
   * card on a short visibility timer so a Test fire doesn't pin
   * sample data to the scene forever.
   */
  isTest?: boolean;
};

/**
 * Session card — visual rebuild matching the legacy SPA's
 * `session.html`. Three things, stacked vertically inside a single
 * gold-accented card:
 *
 *   1. Big "WW – LL" with the W and L on separate baseline-aligned
 *      lines (the SPA's signature look). A small streak chip pinned
 *      to the corner when on a 2+ run, and the session elapsed time
 *      ("27m") under the W-L for context.
 *   2. Big "REGION MMR" line (e.g. "NA 5343") below the W-L,
 *      anchored in the cloud aggregate's `region` + `mmrCurrent`.
 *
 * Two payload paths — `session` (cloud-pushed via the `overlay:session`
 * event) takes priority over `live.session` (legacy agent-pushed
 * fallback). Both are typed identically so the renderer doesn't care.
 */
export function SessionWidget({
  live,
  session,
}: {
  live: LiveGamePayload | null;
  session?: SessionSummary | null;
}) {
  const s = session ?? live?.session;
  // Tick once a minute so the elapsed-time stamp ("27m") advances
  // without the streamer having to refresh the Browser Source. We
  // recompute in render rather than store the formatted string in
  // state so the next tick can't miss a minute boundary.
  const elapsedText = useElapsedMinutes(s?.sessionStartedAt);
  if (!s) return null;

  // Streak chip — prefer the cloud-derived per-day streak; fall back
  // to the broader `live.streak` which spans days. Keeps the chip
  // visible across the streamer's whole streak even if today only
  // started with one game.
  const streak = s.streak ?? live?.streak ?? null;
  const streakChip =
    streak && streak.count >= 2
      ? {
          label: `${streak.kind === "win" ? "W" : "L"}${streak.count}`,
          isWin: streak.kind === "win",
        }
      : null;

  const region = (s.region || "").trim();
  const hasMmr = typeof s.mmrCurrent === "number";
  const regionLine = region && hasMmr
    ? `${region} ${s.mmrCurrent}`
    : hasMmr
      ? `${s.mmrCurrent} MMR`
      : region
        ? `${region} —`
        : null;

  return (
    <WidgetShell slot="top-right" accent="gold" visible width={260}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr auto",
          alignItems: "start",
          rowGap: 4,
          columnGap: 10,
        }}
      >
        {/* Big W stacked above big L. The values run left-aligned so
            "Xm" can sit underneath the L for a tidy column. */}
        <div
          style={{
            fontVariantNumeric: "tabular-nums",
            display: "flex",
            flexDirection: "column",
            lineHeight: 1,
          }}
        >
          <span
            style={{
              fontSize: 56,
              fontWeight: 800,
              letterSpacing: -2,
              color: "#e6b450",
            }}
          >
            {s.wins}W &mdash;
          </span>
          <span
            style={{
              fontSize: 56,
              fontWeight: 800,
              letterSpacing: -2,
              color: "#e6b450",
              marginTop: 2,
            }}
          >
            {s.losses}L
          </span>
          {elapsedText ? (
            <span
              style={{
                fontSize: 13,
                opacity: 0.6,
                fontWeight: 600,
                marginTop: 6,
                letterSpacing: 1,
              }}
            >
              {elapsedText}
            </span>
          ) : null}
        </div>

        {/* Right column: SESSION label + optional streak chip. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: 8,
            paddingTop: 4,
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 2,
              opacity: 0.6,
              writingMode: "vertical-rl",
              transform: "rotate(180deg)",
              color: "#e6b450",
            }}
          >
            SESSION
          </span>
          {streakChip ? (
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 1,
                padding: "2px 8px",
                borderRadius: 4,
                textTransform: "uppercase",
                background: streakChip.isWin
                  ? "rgba(62,192,122,0.18)"
                  : "rgba(255,107,107,0.18)",
                color: streakChip.isWin ? "#3ec07a" : "#ff6b6b",
              }}
            >
              {streakChip.label}
            </span>
          ) : null}
        </div>

        {/* Region + current MMR. Spans the full width below the W-L. */}
        {regionLine ? (
          <div
            style={{
              gridColumn: "1 / span 2",
              fontSize: 26,
              fontWeight: 800,
              letterSpacing: 1,
              fontVariantNumeric: "tabular-nums",
              marginTop: 8,
              color: "#e6e8ee",
            }}
          >
            {regionLine}
          </div>
        ) : null}
      </div>
    </WidgetShell>
  );
}

/**
 * Re-renders once a minute so the elapsed-time string stays current
 * without forcing the parent overlay to rebroadcast every minute. The
 * tick is cheap — one timeout per active widget, cleared on unmount.
 */
function useElapsedMinutes(startedAt?: string): string | null {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!startedAt) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, [startedAt]);
  // Reference `tick` so the linter sees the dependency; the value
  // itself isn't used because Date.now() is computed live.
  void tick;
  if (!startedAt) return null;
  const start = new Date(startedAt).getTime();
  if (!Number.isFinite(start)) return null;
  const minutes = Math.max(0, Math.floor((Date.now() - start) / 60_000));
  if (minutes < 1) return "0m";
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
