"use client";

/**
 * CountdownTimerWidget — a standalone on-stream countdown you can
 * show at any time, set from the Stream Dock's Timer panel (optional
 * label + minutes). Independent of the BRB/Starting Soon scene: this
 * is a compact card, not a full-screen takeover. At zero it pulses
 * "TIME!" and stays until cleared from the dock, so a "5 min queue
 * break" can't silently vanish. Transparent while no timer is set.
 */

import { useEffect, useState, type CSSProperties } from "react";
import { useStudioState } from "@/lib/multichat/useStudioState";
import { useTestFireFlag } from "@/lib/multichat/useTestFireFlag";
import { formatCountdown } from "./StreamSceneWidget";
import type { LiveGamePayload } from "../types";

const TICK_MS = 250;

export function CountdownTimerWidget({
  token,
  studioEvent,
  live,
}: {
  token: string;
  /** Latest raw ``overlay:multichat`` socket payload from the host. */
  studioEvent?: unknown;
  /** Shared overlay payload — read ONLY for the Test-fire flag. */
  live?: LiveGamePayload | null;
}) {
  const state = useStudioState(token, studioEvent ?? null);
  const testActive = useTestFireFlag(live, "countdown-timer");
  const [demoEndsAt, setDemoEndsAt] = useState<number | null>(null);
  useEffect(() => {
    setDemoEndsAt(testActive ? Date.now() + 3 * 60_000 + 20_000 : null);
  }, [testActive]);

  const timer = testActive
    ? demoEndsAt !== null
      ? { label: "Test: back in a few", endsAt: demoEndsAt, setAtMs: 0 }
      : null
    : state.timer;

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!timer) return;
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, [timer?.endsAt, timer?.setAtMs]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!timer) return <div style={{ background: "transparent" }} />;

  const remainMs = Math.max(0, timer.endsAt - nowMs);
  const done = remainMs <= 0;
  const urgent = !done && remainMs <= 10_000;

  return (
    <div style={frameStyle}>
      <style>{`
        .cdt-card { animation: cdtIn 280ms cubic-bezier(.34,1.56,.64,1); }
        @keyframes cdtIn { from { opacity: 0; transform: translateY(-8px) scale(.97); } to { opacity: 1; transform: none; } }
        .cdt-pulse { animation: cdtPulse 1s ease-in-out infinite; }
        @keyframes cdtPulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .7; transform: scale(1.04); } }
        @media (prefers-reduced-motion: reduce) { .cdt-card, .cdt-pulse { animation: none; } }
      `}</style>
      {testActive ? <div style={testTagStyle}>TEST</div> : null}
      <div className="cdt-card" style={cardStyle}>
        <div style={kickerStyle}>⏱ COUNTDOWN</div>
        {timer.label ? <div style={labelStyle}>{timer.label}</div> : null}
        <div
          className={done || urgent ? "cdt-pulse" : undefined}
          style={{
            ...timeStyle,
            color: done
              ? "#3ec07a"
              : urgent
                ? "#e6b450"
                : "var(--ov-accent, #3ec0c7)",
          }}
        >
          {done ? "TIME!" : formatCountdown(remainMs)}
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
  flexDirection: "column",
  gap: 6,
  fontFamily: "var(--ov-font, Inter, ui-sans-serif, system-ui, sans-serif)",
};

const testTagStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.08em",
  color: "#f5b942",
};

const cardStyle: CSSProperties = {
  width: "fit-content",
  minWidth: 180,
  maxWidth: 340,
  background:
    "var(--ov-panel-bg, linear-gradient(135deg, rgba(11,13,18,0.94) 0%, rgba(22,26,35,0.94) 100%))",
  border: "var(--ov-shell-border, 1px solid rgba(255,255,255,0.10))",
  borderRadius: "var(--ov-radius, 12px)",
  boxShadow: "0 6px 20px rgba(0,0,0,0.45)",
  padding: "12px 18px",
  color: "#e6e8ee",
  textAlign: "center",
};

const kickerStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: "0.14em",
  color: "rgba(255,255,255,0.6)",
};

const labelStyle: CSSProperties = {
  marginTop: 4,
  fontSize: 13,
  fontWeight: 600,
  color: "rgba(255,255,255,0.85)",
  overflowWrap: "anywhere",
};

const timeStyle: CSSProperties = {
  marginTop: 4,
  fontSize: 40,
  fontWeight: 800,
  fontVariantNumeric: "tabular-nums",
  letterSpacing: "0.05em",
  lineHeight: 1.05,
};
