"use client";

/**
 * StreamSceneWidget — full-screen BRB / Starting Soon scene for OBS.
 * Add it as a full-canvas Browser Source in the BRB and Starting
 * Soon scenes; the Stream Dock's Scenes panel switches what it shows
 * (with an optional message and countdown), and "Live" makes it
 * fully transparent again.
 *
 * Design: dark radial backdrop with two slow-drifting accent glows
 * and a floating-ember field (pure CSS, GPU-cheap, reduced-motion
 * aware), a big letterspaced headline, the streamer's message, and a
 * huge tabular-nums countdown that flips to a pulsing "STARTING NOW"
 * at zero. The scene inherits the overlay theme accent via
 * ``--ov-accent``.
 *
 * The shared ``overlay:live`` payload is read for one thing: the
 * Settings Test button (demo Starting Soon with a live countdown).
 */

import { useEffect, useState, type CSSProperties } from "react";
import { useStudioState, type StudioScene } from "@/lib/multichat/useStudioState";
import { useTestFireFlag } from "@/lib/multichat/useTestFireFlag";
import { testScene } from "@/lib/multichat/testStudio";
import type { LiveGamePayload } from "../types";

const TICK_MS = 250;

/** Deterministic ember field — no randomness, stable across renders. */
const EMBERS = Array.from({ length: 14 }, (_, i) => ({
  left: (i * 37 + 11) % 100,
  size: 3 + ((i * 13) % 6),
  delay: ((i * 47) % 200) / 10,
  duration: 14 + ((i * 29) % 12),
  opacity: 0.12 + ((i * 17) % 20) / 100,
}));

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
      {/* backdrop glows + ember field */}
      <div className="scn-glow scn-glow-a" style={glowA} />
      <div className="scn-glow scn-glow-b" style={glowB} />
      {EMBERS.map((e, i) => (
        <div
          key={i}
          className="scn-ember"
          style={{
            left: `${e.left}%`,
            width: e.size,
            height: e.size,
            opacity: e.opacity,
            animationDelay: `${e.delay}s`,
            animationDuration: `${e.duration}s`,
          }}
        />
      ))}

      <div style={centerStyle}>
        {testActive ? <div style={testTagStyle}>TEST</div> : null}
        <div className="scn-headline" style={headlineStyle}>
          {headline}
        </div>
        <div style={ruleStyle} />
        {scene.message ? (
          <div style={messageStyle}>{scene.message}</div>
        ) : null}
        {remainMs !== null ? (
          done ? (
            <div className="scn-now" style={countdownStyle}>
              {isBrb ? "BACK ANY MOMENT" : "STARTING NOW"}
            </div>
          ) : (
            <div style={countdownStyle}>{formatCountdown(remainMs)}</div>
          )
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
  .scn-glow { animation: scnDrift 26s ease-in-out infinite alternate; }
  .scn-glow-b { animation-duration: 34s; animation-direction: alternate-reverse; }
  @keyframes scnDrift {
    from { transform: translate3d(-4%, -3%, 0) scale(1); }
    to { transform: translate3d(5%, 4%, 0) scale(1.15); }
  }
  .scn-ember {
    position: absolute;
    bottom: -12px;
    border-radius: 999px;
    background: var(--ov-accent, #3ec0c7);
    animation-name: scnRise;
    animation-timing-function: linear;
    animation-iteration-count: infinite;
  }
  @keyframes scnRise {
    from { transform: translateY(0); }
    to { transform: translateY(-110vh); }
  }
  .scn-headline { animation: scnBreathe 5s ease-in-out infinite; }
  @keyframes scnBreathe {
    0%, 100% { text-shadow: 0 0 26px rgba(62,192,199,0.35); }
    50% { text-shadow: 0 0 44px rgba(62,192,199,0.6); }
  }
  .scn-now { animation: scnPulse 1s ease-in-out infinite; }
  @keyframes scnPulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.75; transform: scale(1.04); }
  }
  @media (prefers-reduced-motion: reduce) {
    .scn-glow, .scn-ember, .scn-headline, .scn-now { animation: none; }
  }
`;

const frameStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  overflow: "hidden",
  background:
    "radial-gradient(120% 90% at 50% 10%, #101623 0%, #0a0d14 55%, #05070b 100%)",
  fontFamily: "var(--ov-font, Inter, ui-sans-serif, system-ui, sans-serif)",
  color: "#e6e8ee",
};

const glowA: CSSProperties = {
  position: "absolute",
  top: "-20%",
  left: "-10%",
  width: "55%",
  height: "55%",
  borderRadius: "50%",
  background:
    "radial-gradient(circle, color-mix(in srgb, var(--ov-accent, #3ec0c7) 22%, transparent) 0%, transparent 70%)",
  filter: "blur(30px)",
};

const glowB: CSSProperties = {
  position: "absolute",
  bottom: "-25%",
  right: "-10%",
  width: "60%",
  height: "60%",
  borderRadius: "50%",
  background:
    "radial-gradient(circle, rgba(120,90,220,0.16) 0%, transparent 70%)",
  filter: "blur(34px)",
};

const centerStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 18,
  textAlign: "center",
  padding: "0 6vw",
};

const testTagStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  letterSpacing: "0.12em",
  color: "#f5b942",
};

const headlineStyle: CSSProperties = {
  fontSize: "clamp(34px, 7vw, 96px)",
  fontWeight: 900,
  letterSpacing: "0.22em",
  textTransform: "uppercase",
  color: "#fff",
};

const ruleStyle: CSSProperties = {
  width: "min(340px, 40vw)",
  height: 3,
  borderRadius: 999,
  background:
    "linear-gradient(90deg, transparent, var(--ov-accent, #3ec0c7), transparent)",
};

const messageStyle: CSSProperties = {
  fontSize: "clamp(15px, 2vw, 26px)",
  fontWeight: 500,
  color: "rgba(255,255,255,0.82)",
  maxWidth: "70vw",
  overflowWrap: "anywhere",
};

const countdownStyle: CSSProperties = {
  marginTop: 6,
  fontSize: "clamp(40px, 8vw, 110px)",
  fontWeight: 800,
  fontVariantNumeric: "tabular-nums",
  letterSpacing: "0.06em",
  color: "var(--ov-accent, #3ec0c7)",
};
