"use client";

/**
 * StreamSceneWidget — full-screen BRB / Starting Soon scene for OBS.
 * Add it as a full-canvas Browser Source in the BRB and Starting
 * Soon scenes; the Stream Dock's Scenes panel switches what it shows
 * (with an optional message and countdown), and "Live" makes it
 * fully transparent again.
 *
 * The scene's visual layer is a full-canvas highlight reel with a broadcast-
 * safe animated fallback. Scene wording, the streamer's message, and the
 * Dock-controlled countdown sit in a compact top HUD so the footage stays
 * visible. The scene inherits the overlay theme accent via ``--ov-accent``.
 *
 * The shared ``overlay:live`` payload is read for one thing: the
 * Settings Test button (demo Starting Soon with a live countdown).
 */

import { useEffect, useState, type CSSProperties } from "react";
import { useStudioState, type StudioScene } from "@/lib/multichat/useStudioState";
import { useTestFireFlag } from "@/lib/multichat/useTestFireFlag";
import { testScene } from "@/lib/multichat/testStudio";
import type { LiveGamePayload } from "../types";
import { BrollPlayer } from "./BrollPlayer";

const TICK_MS = 250;

export function StreamSceneWidget({
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
  const testActive = useTestFireFlag(live, "stream-scene");
  const [demoScene, setDemoScene] = useState<StudioScene | null>(null);
  useEffect(() => {
    setDemoScene(testActive ? testScene(Date.now()) : null);
  }, [testActive]);

  const scene = testActive ? demoScene : state.scene;
  // useStudioState defaults an older snapshot's missing b-roll field, so this
  // always remains a safe player config during rollout.
  const broll = state.broll;

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!scene?.countdownEndsAt) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [scene?.countdownEndsAt]);

  if (!scene) return <div style={{ background: "transparent" }} />;

  const isBrb = scene.mode === "brb";
  const headline = isBrb ? "BE RIGHT BACK" : "STARTING SOON";
  const remainMs = scene.countdownEndsAt
    ? Math.max(0, scene.countdownEndsAt - nowMs)
    : null;
  const done = remainMs !== null && remainMs <= 0;

  return (
    <div style={frameStyle}>
      <style>{sceneCss}</style>
      <BrollPlayer {...broll} />

      <div data-testid="stream-scene-hud" style={hudStyle}>
        <div className="scn-scan" aria-hidden="true" />
        <div style={hudRowStyle}>
          {testActive ? <div style={testTagStyle}>TEST</div> : null}
          <div className="scn-headline" style={headlineStyle}>
            {headline}
          </div>
          {remainMs !== null ? (
            <div
              className={done ? "scn-now" : undefined}
              style={countdownStyle}
            >
              {done
                ? isBrb
                  ? "BACK ANY MOMENT"
                  : "STARTING NOW"
                : formatCountdown(remainMs)}
            </div>
          ) : null}
        </div>
        {scene.message ? (
          <div style={messageStyle}>{scene.message}</div>
        ) : null}
      </div>
    </div>
  );
}

/** MM:SS (or H:MM:SS past the hour), tabular and zero-padded. */
export function formatCountdown(remainMs: number): string {
  const totalSec = Math.ceil(remainMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/* ──────────────── styles ──────────────── */

const sceneCss = `
  .scn-scan {
    position: absolute;
    inset: 0;
    overflow: hidden;
    border-radius: inherit;
    pointer-events: none;
  }
  .scn-scan::after {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    top: -2px;
    height: 2px;
    opacity: .52;
    background: linear-gradient(90deg, transparent, var(--ov-accent, #3ec0c7), transparent);
    animation: scnScan 5.5s ease-in-out infinite;
  }
  .scn-headline { animation: scnBreathe 5s ease-in-out infinite; }
  @keyframes scnBreathe {
    0%, 100% { text-shadow: 0 0 18px rgba(62,192,199,0.26); }
    50% { text-shadow: 0 0 28px rgba(62,192,199,0.48); }
  }
  @keyframes scnScan {
    0%, 12% { transform: translateY(0); }
    76%, 100% { transform: translateY(118px); }
  }
  .scn-now { animation: scnPulse 1s ease-in-out infinite; }
  @keyframes scnPulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.75; transform: scale(1.04); }
  }
  @media (prefers-reduced-motion: reduce) {
    .scn-scan::after, .scn-headline, .scn-now { animation: none; }
  }
`;

const frameStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  overflow: "hidden",
  background: "#03070d",
  fontFamily: "var(--ov-font, Inter, ui-sans-serif, system-ui, sans-serif)",
  color: "#e6e8ee",
};

const hudStyle: CSSProperties = {
  position: "absolute",
  zIndex: 10,
  top: "clamp(18px, 3.2vh, 48px)",
  left: "50%",
  width: "min(88vw, 820px)",
  minHeight: 62,
  overflow: "hidden",
  transform: "translateX(-50%)",
  padding: "clamp(10px, 1.2vw, 16px) clamp(16px, 2.2vw, 30px)",
  border: "1px solid rgba(145, 225, 232, 0.3)",
  borderLeft: "4px solid var(--ov-accent, #3ec0c7)",
  borderRadius: 10,
  background:
    "linear-gradient(112deg, rgba(3, 8, 15, 0.9), rgba(7, 16, 25, 0.76))",
  boxShadow:
    "0 16px 48px rgba(0,0,0,0.38), inset 0 1px 0 rgba(255,255,255,0.06)",
  backdropFilter: "blur(14px)",
};

const hudRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "clamp(12px, 2vw, 30px)",
};

const testTagStyle: CSSProperties = {
  flex: "0 0 auto",
  padding: "3px 6px",
  border: "1px solid rgba(245,185,66,0.46)",
  borderRadius: 4,
  fontSize: "clamp(8px, 0.65vw, 11px)",
  fontWeight: 800,
  letterSpacing: "0.12em",
  color: "#f5b942",
};

const headlineStyle: CSSProperties = {
  flex: "1 1 auto",
  fontSize: "clamp(17px, 2.25vw, 31px)",
  fontWeight: 850,
  letterSpacing: "0.16em",
  textTransform: "uppercase",
  color: "#fff",
  whiteSpace: "nowrap",
};

const messageStyle: CSSProperties = {
  marginTop: 6,
  paddingTop: 6,
  borderTop: "1px solid rgba(255,255,255,0.08)",
  fontSize: "clamp(10px, 1vw, 15px)",
  fontWeight: 500,
  letterSpacing: "0.025em",
  color: "rgba(255,255,255,0.74)",
  overflowWrap: "anywhere",
};

const countdownStyle: CSSProperties = {
  flex: "0 0 auto",
  fontSize: "clamp(18px, 2.5vw, 35px)",
  fontWeight: 850,
  fontVariantNumeric: "tabular-nums",
  letterSpacing: "0.08em",
  color: "var(--ov-accent, #3ec0c7)",
  whiteSpace: "nowrap",
};
