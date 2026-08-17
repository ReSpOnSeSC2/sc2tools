"use client";

/**
 * StreamSceneWidget — full-screen BRB / Starting Soon scene for OBS.
 * Add it as a full-canvas Browser Source in the BRB and Starting
 * Soon scenes; the Stream Dock's Scenes panel switches what it shows
 * (with an optional message and countdown), and "Live" makes it
 * fully transparent again.
 *
 * Configured highlight libraries use a full-canvas reel with the wording and
 * Dock-controlled countdown in a compact top HUD. With no clips configured,
 * the original centered glow-and-ember scene remains the default instead of
 * presenting b-roll standby UI. Both inherit the overlay theme accent through
 * ``--ov-accent``.
 *
 * The shared ``overlay:live`` payload is read for one thing: the
 * Settings Test button (demo Starting Soon with a live countdown).
 */

import { useEffect, useState, type CSSProperties } from "react";
import {
  useStudioState,
  type StudioBrollConfig,
  type StudioScene,
} from "@/lib/multichat/useStudioState";
import { useTestFireFlag } from "@/lib/multichat/useTestFireFlag";
import { testScene } from "@/lib/multichat/testStudio";
import type { LiveGamePayload } from "../types";
import { useOverlayBuildRefresh } from "../useOverlayBuildRefresh";
import { BrollPlayer } from "./BrollPlayer";
import { useBrollAudioOwner } from "./brollAudio";

const TICK_MS = 250;

/** Deterministic ember field for the no-library default scene. */
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
  const brollAudioOwner = useBrollAudioOwner();
  const [demoScene, setDemoScene] = useState<StudioScene | null>(null);
  useEffect(() => {
    setDemoScene(testActive ? testScene(Date.now()) : null);
  }, [testActive]);

  const scene = testActive ? demoScene : state.scene;
  useOverlayBuildRefresh({
    enabled: !testActive,
    safeToReload: !scene,
  });
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

  const remainMs = scene.countdownEndsAt
    ? Math.max(0, scene.countdownEndsAt - nowMs)
    : null;

  return (
    <StreamSceneCanvas
      scene={scene}
      broll={broll}
      remainMs={remainMs}
      testActive={testActive}
      brollAudioOwner={brollAudioOwner}
    />
  );
}

/**
 * Shared full-canvas presentation for every Stream Dock cover.
 *
 * The standalone widget and the agent-built ``/scene/manual`` source must
 * paint the same reel. Keeping the rendering here prevents the horizontal
 * manual cover from hiding b-roll behind the legacy backdrop while a vertical
 * canvas using the widget URL continues playing it.
 */
export function StreamSceneCanvas({
  scene,
  broll,
  remainMs,
  testActive = false,
  brollAudioOwner,
}: {
  scene: StudioScene;
  broll: StudioBrollConfig;
  remainMs: number | null;
  testActive?: boolean;
  /** Exactly one separately-rendered OBS copy may own B-roll audio. */
  brollAudioOwner: boolean;
}) {
  const hasBroll = broll.clips.length > 0;
  const isBrb = scene.mode === "brb";
  const headline = isBrb ? "BE RIGHT BACK" : "STARTING SOON";
  const done = remainMs !== null && remainMs <= 0;

  return (
    <div
      data-scene-layout={hasBroll ? "broll" : "default"}
      style={hasBroll ? brollFrameStyle : defaultFrameStyle}
    >
      <style>{sceneCss}</style>
      {hasBroll ? (
        <>
          <BrollPlayer {...broll} audioOwner={brollAudioOwner} />

          <div data-testid="stream-scene-hud" style={hudStyle}>
            <div className="scn-scan" aria-hidden="true" />
            <div style={hudRowStyle}>
              {testActive ? <div style={brollTestTagStyle}>TEST</div> : null}
              <div
                className="scn-headline scn-broll-headline"
                style={brollHeadlineStyle}
              >
                {headline}
              </div>
              {remainMs !== null ? (
                <div
                  className={done ? "scn-now" : undefined}
                  style={brollCountdownStyle}
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
              <div style={brollMessageStyle}>{scene.message}</div>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <div className="scn-glow scn-glow-a" style={glowA} />
          <div className="scn-glow scn-glow-b" style={glowB} />
          {EMBERS.map((ember, index) => (
            <div
              key={index}
              className="scn-ember"
              style={{
                left: `${ember.left}%`,
                width: ember.size,
                height: ember.size,
                opacity: ember.opacity,
                animationDelay: `${ember.delay}s`,
                animationDuration: `${ember.duration}s`,
              }}
            />
          ))}

          <div data-testid="stream-scene-default" style={centerStyle}>
            {testActive ? <div style={defaultTestTagStyle}>TEST</div> : null}
            <div
              className="scn-headline scn-default-headline"
              style={defaultHeadlineStyle}
            >
              {headline}
            </div>
            <div style={ruleStyle} />
            {scene.message ? (
              <div style={defaultMessageStyle}>{scene.message}</div>
            ) : null}
            {remainMs !== null ? (
              done ? (
                <div className="scn-now" style={defaultCountdownStyle}>
                  {isBrb ? "BACK ANY MOMENT" : "STARTING NOW"}
                </div>
              ) : (
                <div style={defaultCountdownStyle}>
                  {formatCountdown(remainMs)}
                </div>
              )
            ) : null}
          </div>
        </>
      )}
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
  .scn-default-headline { animation: scnDefaultBreathe 5s ease-in-out infinite; }
  @keyframes scnDefaultBreathe {
    0%, 100% { text-shadow: 0 0 26px rgba(62,192,199,0.35); }
    50% { text-shadow: 0 0 44px rgba(62,192,199,0.6); }
  }
  .scn-broll-headline { animation: scnBrollBreathe 5s ease-in-out infinite; }
  @keyframes scnBrollBreathe {
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
    .scn-glow, .scn-ember, .scn-scan::after,
    .scn-default-headline, .scn-broll-headline, .scn-now { animation: none; }
  }
`;

const brollFrameStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  overflow: "hidden",
  background: "#03070d",
  fontFamily: "var(--ov-font, Inter, ui-sans-serif, system-ui, sans-serif)",
  color: "#e6e8ee",
};

const defaultFrameStyle: CSSProperties = {
  ...brollFrameStyle,
  background:
    "radial-gradient(120% 90% at 50% 10%, #101623 0%, #0a0d14 55%, #05070b 100%)",
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

const brollTestTagStyle: CSSProperties = {
  flex: "0 0 auto",
  padding: "3px 6px",
  border: "1px solid rgba(245,185,66,0.46)",
  borderRadius: 4,
  fontSize: "clamp(8px, 0.65vw, 11px)",
  fontWeight: 800,
  letterSpacing: "0.12em",
  color: "#f5b942",
};

const brollHeadlineStyle: CSSProperties = {
  flex: "1 1 auto",
  fontSize: "clamp(17px, 2.25vw, 31px)",
  fontWeight: 850,
  letterSpacing: "0.16em",
  textTransform: "uppercase",
  color: "#fff",
  whiteSpace: "nowrap",
};

const brollMessageStyle: CSSProperties = {
  marginTop: 6,
  paddingTop: 6,
  borderTop: "1px solid rgba(255,255,255,0.08)",
  fontSize: "clamp(10px, 1vw, 15px)",
  fontWeight: 500,
  letterSpacing: "0.025em",
  color: "rgba(255,255,255,0.74)",
  overflowWrap: "anywhere",
};

const brollCountdownStyle: CSSProperties = {
  flex: "0 0 auto",
  fontSize: "clamp(18px, 2.5vw, 35px)",
  fontWeight: 850,
  fontVariantNumeric: "tabular-nums",
  letterSpacing: "0.08em",
  color: "var(--ov-accent, #3ec0c7)",
  whiteSpace: "nowrap",
};

const defaultTestTagStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  letterSpacing: "0.12em",
  color: "#f5b942",
};

const defaultHeadlineStyle: CSSProperties = {
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

const defaultMessageStyle: CSSProperties = {
  fontSize: "clamp(15px, 2vw, 26px)",
  fontWeight: 500,
  color: "rgba(255,255,255,0.82)",
  maxWidth: "70vw",
  overflowWrap: "anywhere",
};

const defaultCountdownStyle: CSSProperties = {
  marginTop: 6,
  fontSize: "clamp(40px, 8vw, 110px)",
  fontWeight: 800,
  fontVariantNumeric: "tabular-nums",
  letterSpacing: "0.06em",
  color: "var(--ov-accent, #3ec0c7)",
};
