"use client";

/**
 * LowerThirdWidget — an esports-broadcast lower third that slides in
 * after each game: result chip, map + matchup, MMR delta, opponent
 * with head-to-head record, and the session line. Payload-driven
 * like the classic widgets (standard visibility timer hides it), so
 * a Settings Test fire renders it exactly like a real post-game.
 *
 * Anchor the Browser Source along the bottom edge of the scene; the
 * bar is left-aligned and staged: accent spine → result chip → text
 * blocks, each with a small entrance delay.
 */

import type { CSSProperties } from "react";
import type { LiveGamePayload } from "../types";

export function LowerThirdWidget({ live }: { live: LiveGamePayload | null }) {
  if (!live || !live.result) return <div style={{ background: "transparent" }} />;
  const win = live.result === "win";
  const delta = Number(live.mmrDelta);
  const hasDelta = Number.isFinite(delta) && delta !== 0;
  const h2h = live.headToHead;
  const session = live.session;

  return (
    <div style={frameStyle}>
      <style>{`
        .lt-stage { opacity: 0; transform: translateX(-16px); animation: ltIn 420ms cubic-bezier(.2,.9,.3,1) forwards; }
        .lt-d1 { animation-delay: 80ms; } .lt-d2 { animation-delay: 200ms; } .lt-d3 { animation-delay: 320ms; }
        @keyframes ltIn { to { opacity: 1; transform: none; } }
        .lt-spine { transform: scaleY(0); transform-origin: bottom; animation: ltSpine 300ms ease-out forwards; }
        @keyframes ltSpine { to { transform: none; } }
        @media (prefers-reduced-motion: reduce) { .lt-stage, .lt-spine { animation: none; opacity: 1; transform: none; } }
      `}</style>
      <div style={barStyle}>
        <div className="lt-spine" style={{ ...spineStyle, background: win ? "#3ec07a" : "#e05656" }} />
        <div
          className="lt-stage"
          style={{
            ...resultChipStyle,
            background: win ? "rgba(62,192,122,0.16)" : "rgba(224,86,86,0.16)",
            color: win ? "#3ec07a" : "#e05656",
            borderColor: win ? "rgba(62,192,122,0.5)" : "rgba(224,86,86,0.5)",
          }}
        >
          {win ? "VICTORY" : "DEFEAT"}
          {hasDelta ? (
            <span style={{ marginLeft: 8, fontVariantNumeric: "tabular-nums" }}>
              {delta > 0 ? "▲" : "▼"} {Math.abs(delta)} MMR
            </span>
          ) : null}
        </div>
        <div className="lt-stage lt-d1" style={blockStyle}>
          <div style={labelStyle}>{live.matchup ?? "Match"}</div>
          <div style={valueStyle}>{live.map ?? "—"}</div>
        </div>
        {live.oppName ? (
          <div className="lt-stage lt-d2" style={blockStyle}>
            <div style={labelStyle}>vs {live.oppName}</div>
            <div style={valueStyle}>
              {h2h
                ? `H2H ${h2h.wins}–${h2h.losses}`
                : (live.oppMmr ? `${live.oppMmr} MMR` : "first meeting")}
            </div>
          </div>
        ) : null}
        {session ? (
          <div className="lt-stage lt-d3" style={blockStyle}>
            <div style={labelStyle}>Session</div>
            <div style={valueStyle}>
              {session.wins}–{session.losses}
              {Number.isFinite(Number(session.mmrCurrent)) &&
              Number.isFinite(Number(session.mmrStart)) ? (
                <span style={{ opacity: 0.7 }}>
                  {" "}
                  ({Number(session.mmrCurrent) - Number(session.mmrStart) >= 0 ? "+" : ""}
                  {Number(session.mmrCurrent) - Number(session.mmrStart)} MMR)
                </span>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

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
  gap: 14,
  maxWidth: "100%",
  minWidth: 320,
  background:
    "var(--ov-panel-bg, linear-gradient(100deg, rgba(9,11,16,0.96) 0%, rgba(20,24,33,0.94) 70%, rgba(20,24,33,0.72) 100%))",
  border: "var(--ov-shell-border, 1px solid rgba(255,255,255,0.10))",
  borderRadius: "var(--ov-radius, 10px)",
  boxShadow: "0 8px 26px rgba(0,0,0,0.5)",
  padding: "12px 20px 12px 14px",
  color: "#e6e8ee",
  overflow: "hidden",
};

const spineStyle: CSSProperties = {
  width: 4,
  borderRadius: 999,
  flexShrink: 0,
};

const resultChipStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  alignSelf: "center",
  border: "1px solid",
  borderRadius: 8,
  padding: "8px 12px",
  fontSize: 16,
  fontWeight: 900,
  letterSpacing: "0.1em",
  whiteSpace: "nowrap",
};

const blockStyle: CSSProperties = {
  alignSelf: "center",
  minWidth: 0,
  paddingLeft: 14,
  borderLeft: "1px solid rgba(255,255,255,0.12)",
};

const labelStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: "var(--ov-accent, #3ec0c7)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const valueStyle: CSSProperties = {
  marginTop: 2,
  fontSize: 15,
  fontWeight: 700,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
