"use client";

/**
 * SC2BackdropScene — the full-canvas broadcast backdrop.
 *
 * This is the bottom layer of the "Between Games" OBS scene the agent
 * builds (``apps/agent/sc2tools_agent/live/obs_layout.py``): the
 * streamer's webcam, a chat column, a small game-capture inset and a
 * session-stats card all sit on top of it. It is also usable on its
 * own as a Starting Soon / BRB / intermission card, where the whole
 * canvas is visible.
 *
 * Two layout modes, because those are genuinely different jobs:
 *
 *   - ``frame``  — something is composited on top. Interest lives at
 *     the edges (vignette, corner brackets, rim glow) and the middle
 *     stays deliberately calm so it never fights a face. This is the
 *     between-games default.
 *   - ``full``   — the backdrop *is* the shot. The centre carries a
 *     headline, an optional message and a countdown.
 *
 * Licensing: every mark here is procedural. No Blizzard art, logos,
 * unit silhouettes, fonts or map textures — the StarCraft read comes
 * from colour, the hex/console lattice, the drifting starfield and the
 * RTS reticle brackets, all of which are ours.
 *
 * Performance contract (this runs for hours underneath a game capture)
 * --------------------------------------------------------------------
 * OBS Browser Sources are the easiest place in a stream to burn a core
 * on nothing, so:
 *
 *   - Only ``transform`` and ``opacity`` are ever animated. Nothing
 *     animates ``filter``, ``box-shadow`` or ``text-shadow`` — those
 *     force a full repaint every frame and are the single biggest
 *     browser-source CPU sink. (``StreamSceneWidget`` animates
 *     ``text-shadow`` on one element; that is fine for a card that
 *     shows for 30 seconds, not for an all-night backdrop.)
 *   - Softness comes from radial-gradient falloff, never from an
 *     animated ``filter: blur()``.
 *   - The two starfields are a single ``background-image`` each — one
 *     rasterised layer apiece rather than 100 DOM nodes.
 *   - Particles are CSS-animated divs (deterministic, index-seeded,
 *     stable across renders), capped at ``MOTE_COUNT``. No
 *     ``requestAnimationFrame`` loop anywhere in this file.
 *   - Every animation duration divides ``LOOP_SEC`` exactly, so the
 *     whole scene returns to its starting state on a fixed cycle and
 *     ``scripts/render-scene.mjs`` can capture a seamless MP4 loop.
 *   - ``prefers-reduced-motion`` and ``?static=1`` both freeze
 *     everything to a still gradient.
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";

/**
 * Master animation cycle. Every duration below must divide this
 * exactly, or the exported loop will visibly jump at the seam.
 */
export const LOOP_SEC = 20;

/** Deterministic particle budget. See the perf note above. */
const MOTE_COUNT = 18;
const FAR_STAR_COUNT = 70;
const NEAR_STAR_COUNT = 26;

/** How long an accent change takes to crossfade. */
const ACCENT_FADE_MS = 800;

/**
 * Race accents, matching ``--color-race-*`` in docs/design-system.md.
 * These are identity colours, not semantic ones — a Zerg loss is still
 * red elsewhere in the product.
 */
const RACE_ACCENTS: Record<string, string> = {
  terran: "#3B82F6",
  zerg: "#A855F7",
  protoss: "#F59E0B",
  random: "#94A3B8",
};

/** Stock accent when no game is in flight. Matches the overlay default. */
export const DEFAULT_BACKDROP_ACCENT = "#3EC0C7";

export type BackdropVariant =
  | "between-games"
  | "starting-soon"
  | "brb"
  | "intermission";

export type BackdropLayout = "frame" | "full";

/** Which variants own the whole canvas vs. sit under other sources. */
export const VARIANT_LAYOUT: Record<BackdropVariant, BackdropLayout> = {
  "between-games": "frame",
  "starting-soon": "full",
  brb: "full",
  intermission: "full",
};

const VARIANT_HEADLINE: Record<BackdropVariant, string | null> = {
  "between-games": null,
  "starting-soon": "STARTING SOON",
  brb: "BE RIGHT BACK",
  intermission: "INTERMISSION",
};

/**
 * Resolve a race string from either payload shape onto an accent.
 * Unknown / absent races keep the stock accent rather than guessing —
 * a wrong tint mid-match is worse than a neutral one.
 */
export function accentForRace(race?: string | null): string {
  if (!race) return DEFAULT_BACKDROP_ACCENT;
  return RACE_ACCENTS[race.trim().toLowerCase()] ?? DEFAULT_BACKDROP_ACCENT;
}

/* ──────────────── deterministic field generation ──────────────── */

/**
 * mulberry32 — small, fast, and crucially *seeded*, so the starfield
 * is identical on every render, every reload and every machine. An
 * unseeded ``Math.random`` would reshuffle the sky on each OBS source
 * refresh, which reads as a glitch on stream.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One rasterised layer of stars, as a single multi-stop background. */
function starLayer(count: number, seed: number, size: number, alpha: number) {
  const rand = mulberry32(seed);
  const images: string[] = [];
  const positions: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const x = (rand() * 100).toFixed(3);
    const y = (rand() * 100).toFixed(3);
    // Vary brightness so the field has depth instead of reading as a
    // regular dot screen.
    const a = (alpha * (0.45 + rand() * 0.55)).toFixed(3);
    images.push(
      `radial-gradient(${size}px ${size}px at center, rgba(226,238,255,${a}) 0%, rgba(226,238,255,0) 60%)`,
    );
    positions.push(`${x}% ${y}%`);
  }
  return {
    backgroundImage: images.join(","),
    backgroundPosition: positions.join(","),
    backgroundSize: `${size * 4}px ${size * 4}px`,
    backgroundRepeat: "no-repeat",
  } satisfies CSSProperties;
}

const FAR_STARS = starLayer(FAR_STAR_COUNT, 0x5c2f00, 1.4, 0.55);
const NEAR_STARS = starLayer(NEAR_STAR_COUNT, 0x5c2f01, 2.4, 0.9);

/**
 * Rising vespene motes. Durations are drawn from divisors of
 * ``LOOP_SEC`` so the field is seamless across the loop boundary;
 * delays can be anything, since a constant offset still lands on the
 * same phase every cycle.
 */
const MOTE_DURATIONS = [20, 10] as const;
const MOTES = Array.from({ length: MOTE_COUNT }, (_, i) => {
  const rand = mulberry32(0xbee5 + i);
  return {
    left: rand() * 100,
    size: 2 + Math.floor(rand() * 4),
    delay: -(rand() * LOOP_SEC),
    duration: MOTE_DURATIONS[i % MOTE_DURATIONS.length],
    opacity: 0.1 + rand() * 0.28,
    drift: (rand() * 2 - 1) * 3,
  };
});

/* ──────────────── accent crossfade ──────────────── */

type AccentLayer = { id: number; color: string };

/**
 * Keep the outgoing accent mounted underneath the incoming one and
 * fade the new one in over it.
 *
 * Why not a CSS transition: the accent drives gradients and border
 * colours, and neither ``background-image`` nor a CSS custom property
 * is interpolatable. Stacking two layers and animating ``opacity`` is
 * the only approach that actually crossfades — and opacity is the
 * cheap thing to animate anyway.
 */
function useAccentLayers(accent: string): AccentLayer[] {
  const [layers, setLayers] = useState<AccentLayer[]>([
    { id: 0, color: accent },
  ]);
  const nextId = useRef(1);

  useEffect(() => {
    setLayers((prev) => {
      if (prev.length && prev[prev.length - 1].color === accent) return prev;
      return [...prev, { id: nextId.current++, color: accent }];
    });
  }, [accent]);

  useEffect(() => {
    if (layers.length <= 1) return;
    // Drop everything but the top layer once the fade has finished.
    const t = setTimeout(
      () => setLayers((prev) => prev.slice(-1)),
      ACCENT_FADE_MS + 50,
    );
    return () => clearTimeout(t);
  }, [layers]);

  return layers;
}

/* ──────────────── component ──────────────── */

export function SC2BackdropScene({
  variant = "between-games",
  accent = DEFAULT_BACKDROP_ACCENT,
  layout,
  message,
  countdownMs,
  staticMode = false,
}: {
  variant?: BackdropVariant;
  /** Accent hex. Use ``accentForRace`` to derive it from live data. */
  accent?: string;
  /** Override the variant's natural layout mode. */
  layout?: BackdropLayout;
  /** Optional line under the headline. ``full`` layouts only. */
  message?: string | null;
  /** Remaining countdown in ms, or null for none. ``full`` only. */
  countdownMs?: number | null;
  /** Freeze all motion (``?static=1``, or the render script). */
  staticMode?: boolean;
}) {
  const mode = layout ?? VARIANT_LAYOUT[variant] ?? "frame";
  const accentLayers = useAccentLayers(accent);
  const headline = VARIANT_HEADLINE[variant];
  const className = ["sc2bd", staticMode ? "sc2bd-static" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={className} style={frameStyle} data-variant={variant}>
      <style>{backdropCss}</style>

      {/* Deep-space base. Static — no reason to move the floor. */}
      <div style={baseStyle} />

      {/* Accent-tinted nebulae. Each accent change stacks a new pair
          on top and fades it in; the old pair is dropped after. */}
      {accentLayers.map((layer, i) => (
        <div
          key={layer.id}
          className={i > 0 ? "sc2bd-accent sc2bd-accent-in" : "sc2bd-accent"}
          style={{ position: "absolute", inset: 0 }}
        >
          <div className="sc2bd-glow sc2bd-glow-a" style={glowA(layer.color)} />
          <div className="sc2bd-glow sc2bd-glow-b" style={glowB(layer.color)} />
          <div className="sc2bd-rim" style={rimStyle(layer.color)} />
        </div>
      ))}

      {/* Parallax starfields — two rasterised layers, not 96 nodes. */}
      <div className="sc2bd-stars sc2bd-stars-far" style={farStarStyle} />
      <div className="sc2bd-stars sc2bd-stars-near" style={nearStarStyle} />

      {/* Command-console lattice across the upper field, fading out
          before it reaches the horizon. */}
      <div style={latticeStyle} />

      {/* Ground plane. A real CSS perspective transform rather than a
          faked gradient — it gives the composition a horizon, which is
          what stops the whole thing reading as flat haze. Static: the
          transform is applied once and never animated. */}
      <div style={floorWrapStyle}>
        <div style={floorGridStyle(accent)} />
      </div>
      <div style={horizonStyle(accent)} />

      {/* Slow vertical sweep. Deliberately low-contrast and tall — a
          hard band reads as a rendering seam, not a scanline. */}
      <div className="sc2bd-scan" style={scanStyle(accent)} />

      {/* Vespene drift. */}
      {MOTES.map((m, i) => (
        <div
          key={i}
          className="sc2bd-mote"
          style={{
            left: `${m.left}%`,
            width: m.size,
            height: m.size,
            opacity: m.opacity,
            background: accent,
            animationDelay: `${m.delay}s`,
            animationDuration: `${m.duration}s`,
            ["--sc2bd-drift" as string]: `${m.drift}vw`,
          }}
        />
      ))}

      {/* Vignette keeps the middle readable under a webcam. */}
      <div style={vignetteStyle} />

      {/* RTS reticle brackets. */}
      {(["tl", "tr", "bl", "br"] as const).map((corner) => (
        <div
          key={corner}
          className={`sc2bd-bracket sc2bd-bracket-${corner}`}
          style={bracketStyle(accent, corner)}
        />
      ))}

      {mode === "full" && headline ? (
        <div style={centerStyle}>
          <div style={headlineStyle}>{headline}</div>
          <div style={ruleStyle(accent)} />
          {message ? <div style={messageStyle}>{message}</div> : null}
          {typeof countdownMs === "number" && countdownMs > 0 ? (
            <div style={countdownStyle(accent)}>
              {formatBackdropCountdown(countdownMs)}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** MM:SS, or H:MM:SS past the hour. Tabular and zero-padded. */
export function formatBackdropCountdown(remainMs: number): string {
  const totalSec = Math.max(0, Math.ceil(remainMs / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/* ──────────────── styles ──────────────── */

const backdropCss = `
  .sc2bd * { box-sizing: border-box; }

  .sc2bd-accent-in {
    animation: sc2bdAccentIn ${ACCENT_FADE_MS}ms ease forwards;
  }
  @keyframes sc2bdAccentIn { from { opacity: 0; } to { opacity: 1; } }

  .sc2bd-glow {
    will-change: transform;
    animation: sc2bdDrift ${LOOP_SEC}s ease-in-out infinite alternate;
  }
  .sc2bd-glow-b {
    animation-duration: ${LOOP_SEC / 2}s;
    animation-direction: alternate-reverse;
  }
  @keyframes sc2bdDrift {
    from { transform: translate3d(-2%, -1.5%, 0) scale(1); }
    to   { transform: translate3d(2.5%, 2%, 0) scale(1.08); }
  }

  .sc2bd-stars { will-change: transform; }
  .sc2bd-stars-far {
    animation: sc2bdStarFar ${LOOP_SEC}s linear infinite alternate;
  }
  .sc2bd-stars-near {
    animation: sc2bdStarNear ${LOOP_SEC}s linear infinite alternate;
  }
  @keyframes sc2bdStarFar {
    from { transform: translate3d(0, 0, 0); }
    to   { transform: translate3d(-0.6%, -0.4%, 0); }
  }
  @keyframes sc2bdStarNear {
    from { transform: translate3d(0, 0, 0); }
    to   { transform: translate3d(-1.4%, -1%, 0); }
  }

  .sc2bd-scan {
    will-change: transform;
    animation: sc2bdScan ${LOOP_SEC}s linear infinite;
  }
  @keyframes sc2bdScan {
    from { transform: translate3d(0, -25%, 0); }
    to   { transform: translate3d(0, 125%, 0); }
  }

  .sc2bd-mote {
    position: absolute;
    bottom: -16px;
    border-radius: 999px;
    will-change: transform;
    animation-name: sc2bdRise;
    animation-timing-function: linear;
    animation-iteration-count: infinite;
  }
  @keyframes sc2bdRise {
    from { transform: translate3d(0, 0, 0); }
    to   { transform: translate3d(var(--sc2bd-drift, 0), -110vh, 0); }
  }

  .sc2bd-bracket {
    will-change: opacity;
    animation: sc2bdBracket ${LOOP_SEC / 4}s ease-in-out infinite;
  }
  @keyframes sc2bdBracket {
    0%, 100% { opacity: 0.5; }
    50%      { opacity: 0.9; }
  }

  /* Both off-switches collapse to the same still frame. */
  .sc2bd-static .sc2bd-glow,
  .sc2bd-static .sc2bd-stars,
  .sc2bd-static .sc2bd-scan,
  .sc2bd-static .sc2bd-mote,
  .sc2bd-static .sc2bd-bracket,
  .sc2bd-static .sc2bd-accent-in {
    animation: none !important;
  }
  @media (prefers-reduced-motion: reduce) {
    .sc2bd-glow, .sc2bd-stars, .sc2bd-scan,
    .sc2bd-mote, .sc2bd-bracket, .sc2bd-accent-in {
      animation: none !important;
    }
  }
`;

const frameStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  overflow: "hidden",
  background: "#0A0E1A",
  fontFamily: "var(--ov-font, Inter, ui-sans-serif, system-ui, sans-serif)",
  color: "#F1F5F9",
};

// bg-primary from the design system, lifted slightly toward the top so
// the composition has a horizon rather than reading as flat black.
const baseStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  background:
    "radial-gradient(125% 95% at 50% 4%, #131A2B 0%, #0C1120 48%, #070A12 100%)",
};

const glowA = (accent: string): CSSProperties => ({
  position: "absolute",
  top: "-28%",
  left: "-14%",
  width: "68%",
  height: "78%",
  borderRadius: "50%",
  // Falloff comes from the gradient itself; an animated blur() here
  // would cost a full repaint every frame for the same look.
  background: `radial-gradient(circle, ${accent}2E 0%, ${accent}12 38%, transparent 70%)`,
});

const glowB = (accent: string): CSSProperties => ({
  position: "absolute",
  bottom: "-34%",
  right: "-16%",
  width: "72%",
  height: "82%",
  borderRadius: "50%",
  background:
    `radial-gradient(circle, #7A5AD824 0%, ${accent}0F 42%, transparent 72%)`,
});

/** Thin accent wash along the canvas edges — reads as rim light. */
const rimStyle = (accent: string): CSSProperties => ({
  position: "absolute",
  inset: 0,
  background: `linear-gradient(180deg, ${accent}14 0%, transparent 18%, transparent 82%, ${accent}10 100%)`,
});

const starBase: CSSProperties = {
  position: "absolute",
  top: "-3%",
  left: "-3%",
  width: "106%",
  height: "106%",
};

const farStarStyle: CSSProperties = { ...starBase, ...FAR_STARS };
const nearStarStyle: CSSProperties = { ...starBase, ...NEAR_STARS };

/**
 * Isometric console lattice. Three overlaid line sets read as a hex
 * weave without an SVG pattern or an image asset.
 *
 * Masked to fade out before the horizon so the sky and the ground
 * plane don't overlap into mush.
 */
const latticeStyle: CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  height: "62%",
  opacity: 0.85,
  backgroundImage: [
    "repeating-linear-gradient(60deg, rgba(140,190,230,0.10) 0 1px, transparent 1px 58px)",
    "repeating-linear-gradient(-60deg, rgba(140,190,230,0.10) 0 1px, transparent 1px 58px)",
    "repeating-linear-gradient(0deg, rgba(140,190,230,0.055) 0 1px, transparent 1px 100px)",
  ].join(","),
  maskImage:
    "linear-gradient(180deg, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.9) 45%, transparent 100%)",
  WebkitMaskImage:
    "linear-gradient(180deg, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.9) 45%, transparent 100%)",
};

/**
 * Ground plane. ``perspective`` + ``rotateX`` gives a genuine
 * receding grid rather than a faked gradient, which is what makes the
 * composition read as a place instead of a wash. The transform is
 * applied once; nothing here animates.
 */
const floorWrapStyle: CSSProperties = {
  position: "absolute",
  left: "-30%",
  right: "-30%",
  bottom: 0,
  height: "52%",
  perspective: "420px",
  perspectiveOrigin: "50% 0%",
  overflow: "hidden",
};

const floorGridStyle = (accent: string): CSSProperties => ({
  position: "absolute",
  inset: "0 0 -60% 0",
  transform: "rotateX(74deg)",
  transformOrigin: "50% 0%",
  backgroundImage: [
    `repeating-linear-gradient(90deg, ${accent}3D 0 1px, transparent 1px 92px)`,
    `repeating-linear-gradient(0deg, ${accent}30 0 1px, transparent 1px 92px)`,
  ].join(","),
  maskImage:
    "linear-gradient(180deg, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.35) 42%, transparent 78%)",
  WebkitMaskImage:
    "linear-gradient(180deg, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.35) 42%, transparent 78%)",
});

/** The bright seam where the grid meets the sky. Carries the accent. */
const horizonStyle = (accent: string): CSSProperties => ({
  position: "absolute",
  left: 0,
  right: 0,
  bottom: "52%",
  height: "22%",
  background: `linear-gradient(180deg, transparent 0%, ${accent}10 62%, ${accent}55 92%, ${accent}88 100%)`,
  maskImage:
    "linear-gradient(90deg, transparent 0%, rgba(0,0,0,1) 22%, rgba(0,0,0,1) 78%, transparent 100%)",
  WebkitMaskImage:
    "linear-gradient(90deg, transparent 0%, rgba(0,0,0,1) 22%, rgba(0,0,0,1) 78%, transparent 100%)",
});

/**
 * Slow vertical sweep. Very low contrast and tall on purpose — the
 * first cut of this was a hard band and read as a rendering seam
 * rather than a scanline.
 */
const scanStyle = (accent: string): CSSProperties => ({
  position: "absolute",
  left: 0,
  right: 0,
  top: 0,
  height: "55%",
  background: `linear-gradient(180deg, transparent 0%, ${accent}07 40%, ${accent}0C 50%, ${accent}07 60%, transparent 100%)`,
  pointerEvents: "none",
});

/**
 * Darkened edges. Doing real work here: it is what keeps a webcam and
 * a chat column legible on top instead of competing with the nebula.
 */
const vignetteStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  background:
    "radial-gradient(115% 90% at 50% 50%, transparent 42%, rgba(4,6,12,0.42) 78%, rgba(3,4,9,0.72) 100%)",
};

const BRACKET_LEN = "clamp(34px, 4.5vw, 74px)";

function bracketStyle(
  accent: string,
  corner: "tl" | "tr" | "bl" | "br",
): CSSProperties {
  const top = corner === "tl" || corner === "tr";
  const left = corner === "tl" || corner === "bl";
  const edge = "clamp(14px, 1.6vw, 30px)";
  return {
    position: "absolute",
    width: BRACKET_LEN,
    height: BRACKET_LEN,
    [top ? "top" : "bottom"]: edge,
    [left ? "left" : "right"]: edge,
    [top ? "borderTop" : "borderBottom"]: `3px solid ${accent}`,
    [left ? "borderLeft" : "borderRight"]: `3px solid ${accent}`,
    borderRadius: top
      ? left
        ? "6px 0 0 0"
        : "0 6px 0 0"
      : left
        ? "0 0 0 6px"
        : "0 0 6px 0",
  } as CSSProperties;
}

const centerStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 20,
  textAlign: "center",
  // Lifted off centre so the headline sits in the sky rather than
  // being bisected by the horizon glow at 48%.
  padding: "0 8vw 14% 8vw",
};

const headlineStyle: CSSProperties = {
  fontSize: "clamp(32px, 6.5vw, 92px)",
  fontWeight: 900,
  letterSpacing: "0.24em",
  textTransform: "uppercase",
  // A static text-shadow is a one-time raster; animating it would not
  // be. See the perf note at the top of the file.
  textShadow: "0 0 34px rgba(10,14,26,0.9)",
};

const ruleStyle = (accent: string): CSSProperties => ({
  width: "min(380px, 44vw)",
  height: 3,
  borderRadius: 999,
  background: `linear-gradient(90deg, transparent, ${accent} 30%, #F1F5F9 50%, ${accent} 70%, transparent)`,
});

const messageStyle: CSSProperties = {
  fontSize: "clamp(15px, 2vw, 27px)",
  fontWeight: 500,
  color: "rgba(241,245,249,0.82)",
  maxWidth: "68vw",
  overflowWrap: "anywhere",
};

const countdownStyle = (accent: string): CSSProperties => ({
  marginTop: 4,
  fontSize: "clamp(38px, 7.5vw, 104px)",
  fontWeight: 800,
  fontVariantNumeric: "tabular-nums",
  letterSpacing: "0.06em",
  color: accent,
});
