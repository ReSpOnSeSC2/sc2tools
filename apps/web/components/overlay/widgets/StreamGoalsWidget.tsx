"use client";

/**
 * StreamGoalsWidget — the streamer's goal bars (sub goal, follower
 * goal, donation goal…) as compact dark cards with a green gradient
 * fill, mirroring the classic goal-bar look.
 *
 * Fully studio-driven: goals are edited in the Stream Dock, arrive via
 * the studio state (fetch + ``overlay:multichat`` pushes), and the
 * source stays perfectly transparent while no goals are set.
 *
 * The shared ``overlay:live`` payload is read for one thing: the
 * Settings Test button. While a test fire targeting this widget is
 * inside its window, clearly-labelled sample goal bars render instead
 * of the studio state (see lib/multichat/testStudio).
 */

import type { CSSProperties } from "react";
import { useStudioState } from "@/lib/multichat/useStudioState";
import { useTestFireFlag } from "@/lib/multichat/useTestFireFlag";
import { TEST_GOALS } from "@/lib/multichat/testStudio";
import type { LiveGamePayload } from "../types";

/** Hard render cap — the dock enforces the same limit server-side. */
const GOALS_MAX = 4;

export function StreamGoalsWidget({
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
  const testActive = useTestFireFlag(live, "stream-goals");
  const goals = (testActive ? TEST_GOALS : state.goals).slice(0, GOALS_MAX);

  if (goals.length === 0) return <div style={{ background: "transparent" }} />;

  return (
    <div style={frameStyle}>
      {testActive ? <div style={testTagStyle}>TEST</div> : null}
      {goals.map((goal, i) => {
        const pct = Math.max(
          0,
          Math.min(100, Math.round((goal.current / goal.target) * 100)),
        );
        const done = goal.current >= goal.target;
        return (
          <div key={`${i}:${goal.label}`} style={cardStyle}>
            <div style={labelRowStyle}>
              <span style={labelStyle}>{goal.label}</span>
              <span style={numbersStyle}>
                <b style={{ color: done ? "#3ec07a" : "#fff" }}>{goal.current}</b>
                <span style={{ opacity: 0.55 }}> / {goal.target}</span>
              </span>
            </div>
            <div style={trackStyle}>
              <div
                style={{
                  ...fillStyle,
                  width: `${pct}%`,
                  background: done
                    ? "linear-gradient(90deg, #2f9d63, #4fd68c)"
                    : "linear-gradient(90deg, #2f9d63, #3ec07a)",
                  boxShadow: pct > 0 ? "0 0 8px rgba(62,192,122,0.5)" : "none",
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ──────────────── styles ──────────────── */

const frameStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "stretch",
  gap: 8,
  fontFamily: "var(--ov-font, Inter, ui-sans-serif, system-ui, sans-serif)",
};

// Matches the multichat status-row TEST chip.
const testTagStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.08em",
  color: "#f5b942",
};

const cardStyle: CSSProperties = {
  width: "100%",
  minWidth: 220,
  maxWidth: 340,
  background:
    "var(--ov-panel-bg, linear-gradient(135deg, rgba(11,13,18,0.94) 0%, rgba(22,26,35,0.94) 100%))",
  border: "var(--ov-shell-border, 1px solid rgba(255,255,255,0.10))",
  borderRadius: "var(--ov-radius, 12px)",
  boxShadow: "0 4px 14px rgba(0,0,0,0.45)",
  padding: "10px 14px",
  color: "#e6e8ee",
};

const labelRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 10,
};

const labelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "rgba(255,255,255,0.85)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const numbersStyle: CSSProperties = {
  fontSize: 13,
  fontVariantNumeric: "tabular-nums",
  flexShrink: 0,
};

const trackStyle: CSSProperties = {
  marginTop: 7,
  height: 10,
  borderRadius: 999,
  background: "rgba(255,255,255,0.08)",
  overflow: "hidden",
};

const fillStyle: CSSProperties = {
  height: "100%",
  borderRadius: 999,
  transition: "width 600ms ease",
};
