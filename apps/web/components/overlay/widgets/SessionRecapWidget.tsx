"use client";

/**
 * SessionRecapWidget — a "SESSION RECAP" card the streamer fires from
 * the Stream Dock (e.g. before ending the stream). The dock bumps the
 * studio state's ``recapSeq``; every increment beyond the value first
 * observed by this source shows the recap card for a fixed window,
 * built from the same cloud session aggregate the session HUD renders
 * (W-L, net MMR, streak). Transparent otherwise.
 *
 * The Settings Test button behaves exactly like a recap trigger: a
 * test fire targeting this widget shows the card for the standard
 * test window, built from the test payload's sample ``session`` block
 * (falling back to a client-side demo block, see
 * lib/multichat/testStudio).
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useStudioState } from "@/lib/multichat/useStudioState";
import { useTestFireFlag } from "@/lib/multichat/useTestFireFlag";
import { testSession } from "@/lib/multichat/testStudio";
import type { LiveGamePayload } from "../types";
import type { SessionSummary } from "./SessionWidget";

/** How long the recap card stays on screen per trigger. */
const RECAP_VISIBLE_MS = 25_000;

export function SessionRecapWidget({
  token,
  studioEvent,
  session,
  live,
}: {
  token: string;
  /** Latest raw ``overlay:multichat`` socket payload from the host. */
  studioEvent?: unknown;
  /** Cloud session aggregate (``overlay:session``). */
  session?: SessionSummary | null;
  /** Legacy agent payload — fallback source for the session block. */
  live?: LiveGamePayload | null;
}) {
  const state = useStudioState(token, studioEvent ?? null);

  // Baseline = the recapSeq this source booted with. Only INCREASES
  // beyond it trigger the card — a Browser Source refresh must not
  // replay the streamer's last recap. Wait for the loaded flag so the
  // pre-fetch default (0) never becomes the baseline.
  const baselineRef = useRef<number | null>(null);
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!state.loaded) return;
    if (baselineRef.current === null) {
      baselineRef.current = state.recapSeq;
      return;
    }
    if (state.recapSeq > baselineRef.current) {
      // Re-baseline so each further increment re-triggers a fresh
      // 25 s window.
      baselineRef.current = state.recapSeq;
      setVisible(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setVisible(false), RECAP_VISIBLE_MS);
    }
  }, [state.loaded, state.recapSeq]);
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  // Settings Test fire — behaves exactly like a recap trigger for the
  // standard test window. The test payload carries the sample session
  // block; the client-side demo block is a fallback for payloads
  // without one.
  const testActive = useTestFireFlag(live, "session-recap");

  const s = testActive
    ? live?.session ?? testSession()
    : session ?? live?.session ?? null;
  if ((!visible && !testActive) || !s) {
    return <div style={{ background: "transparent" }} />;
  }

  const hasMmrDelta =
    typeof s.mmrStart === "number" && typeof s.mmrCurrent === "number";
  const mmrDelta = hasMmrDelta ? (s.mmrCurrent as number) - (s.mmrStart as number) : 0;
  const streak = s.streak && s.streak.count >= 2 ? s.streak : null;

  return (
    <div style={frameStyle}>
      <style>{`
        .session-recap-card { animation: srSlide 360ms cubic-bezier(.34,1.56,.64,1); }
        @keyframes srSlide {
          from { opacity: 0; transform: translateY(14px) scale(0.97); }
          to { opacity: 1; transform: none; }
        }
        @media (prefers-reduced-motion: reduce) {
          .session-recap-card { animation: none; }
        }
      `}</style>
      <div className="session-recap-card" style={cardStyle}>
        <div style={titleStyle}>
          SESSION RECAP
          {testActive ? <span style={testTagStyle}>TEST</span> : null}
        </div>
        <div style={recordStyle}>
          {s.wins}W <span style={{ opacity: 0.4 }}>&mdash;</span> {s.losses}L
        </div>
        <div style={statRowStyle}>
          <span style={statLabelStyle}>GAMES</span>
          <span style={statValueStyle}>{s.games}</span>
          <span style={statLabelStyle}>NET MMR</span>
          <span
            style={{
              ...statValueStyle,
              color: hasMmrDelta
                ? mmrDelta >= 0
                  ? "#3ec07a"
                  : "#ff6b6b"
                : "rgba(255,255,255,0.45)",
            }}
          >
            {hasMmrDelta ? `${mmrDelta >= 0 ? "+" : ""}${mmrDelta}` : "—"}
          </span>
          {streak ? (
            <>
              <span style={statLabelStyle}>STREAK</span>
              <span
                style={{
                  ...statValueStyle,
                  color: streak.kind === "win" ? "#3ec07a" : "#ff6b6b",
                }}
              >
                {streak.kind === "win" ? "W" : "L"}
                {streak.count}
              </span>
            </>
          ) : null}
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
  alignItems: "flex-start",
};

const cardStyle: CSSProperties = {
  width: "100%",
  minWidth: 260,
  maxWidth: 380,
  background:
    "var(--ov-panel-bg, linear-gradient(135deg, rgba(11,13,18,0.94) 0%, rgba(22,26,35,0.94) 100%))",
  border: "var(--ov-shell-border, 1px solid rgba(255,255,255,0.10))",
  borderLeft: "5px solid #e6b450",
  borderRadius: "var(--ov-radius, 12px)",
  boxShadow: "0 6px 20px rgba(0,0,0,0.55)",
  padding: "16px 20px",
  color: "#e6e8ee",
  fontFamily: "var(--ov-font, Inter, ui-sans-serif, system-ui, sans-serif)",
};

const titleStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: "0.18em",
  color: "#e6b450",
};

// Matches the multichat status-row TEST chip.
const testTagStyle: CSSProperties = {
  marginLeft: 8,
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.08em",
  color: "#f5b942",
};

const recordStyle: CSSProperties = {
  marginTop: 8,
  fontSize: 44,
  fontWeight: 800,
  letterSpacing: -1,
  lineHeight: 1,
  color: "#e6b450",
  fontVariantNumeric: "tabular-nums",
};

const statRowStyle: CSSProperties = {
  marginTop: 14,
  display: "flex",
  alignItems: "baseline",
  gap: 10,
  flexWrap: "wrap",
  fontVariantNumeric: "tabular-nums",
};

const statLabelStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.12em",
  opacity: 0.55,
};

const statValueStyle: CSSProperties = {
  fontSize: 18,
  fontWeight: 800,
  marginRight: 6,
};
