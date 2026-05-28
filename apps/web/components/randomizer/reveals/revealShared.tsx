"use client";

/**
 * Shared building blocks for the randomizer reveal animations.
 *
 * Everything here renders identically in the app (settings preview) and
 * inside an OBS Browser Source, so it uses inline styles + an injected
 * <style> block of keyframes rather than Tailwind. Reveals are honest:
 * the winner is decided up front by the engine and every animation just
 * dramatises landing on it.
 */
import { useEffect, useState, type ReactNode } from "react";
import { RaceIcon } from "@/components/overlay/WidgetShell";
import type { RandomizerBuild } from "@/lib/randomizer/types";
import { spriteFor } from "./spriteShared";

/** Race → hex, matching the overlay WidgetShell palette. */
export const RACE_HEX: Record<string, string> = {
  Protoss: "#7c8cff",
  Terran: "#ff6b6b",
  Zerg: "#a78bfa",
  Random: "#9aa3b2",
};

export function raceHex(race: string | undefined): string {
  return RACE_HEX[race || "Random"] || RACE_HEX.Random;
}

export interface Rarity {
  tier: "common" | "uncommon" | "rare" | "epic" | "legendary";
  label: string;
  color: string;
  glow: string;
}

const RARITY_TABLE: Rarity[] = [
  { tier: "common", label: "Common", color: "#9aa3b2", glow: "rgba(154,163,178,0.5)" },
  { tier: "uncommon", label: "Uncommon", color: "#3ec07a", glow: "rgba(62,192,122,0.55)" },
  { tier: "rare", label: "Rare", color: "#3ec0c7", glow: "rgba(62,192,199,0.6)" },
  { tier: "epic", label: "Epic", color: "#d16ba5", glow: "rgba(209,107,165,0.65)" },
  { tier: "legendary", label: "Legendary", color: "#e6b450", glow: "rgba(230,180,80,0.75)" },
];

/**
 * Rarer (lower landing probability) builds get flashier rarity tiers —
 * the meme payoff of "I can't believe it actually rolled THAT".
 */
export function rarityFor(probability: number): Rarity {
  if (probability >= 0.5) return RARITY_TABLE[0];
  if (probability >= 0.3) return RARITY_TABLE[1];
  if (probability >= 0.15) return RARITY_TABLE[2];
  if (probability >= 0.06) return RARITY_TABLE[3];
  return RARITY_TABLE[4];
}

/** Tracks the OS "reduce motion" setting so reveals can short-circuit. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener?.("change", handler);
    return () => mq.removeEventListener?.("change", handler);
  }, []);
  return reduced;
}

/**
 * Drive a reveal's "settled" flag: false during the animation, true once
 * the winner is locked in. Honours reduced-motion by settling instantly.
 */
export function useRevealTimer(
  spinId: number,
  durationMs: number,
  reducedMotion: boolean,
  onComplete?: () => void,
): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    setSettled(false);
    const delay = reducedMotion ? 0 : durationMs;
    const handle = window.setTimeout(() => {
      setSettled(true);
      onComplete?.();
    }, delay);
    return () => window.clearTimeout(handle);
    // onComplete intentionally excluded — callers pass inline closures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spinId, durationMs, reducedMotion]);
  return settled;
}

/**
 * Kick a CSS-transition reveal into motion. Returns `false` for the
 * first painted frame (so the element renders at its start value) then
 * flips `true` a couple of frames later so the transition to the target
 * actually animates instead of being applied instantly. Reduced motion
 * skips straight to the target.
 *
 * Pairing this with `useRevealTimer` is what keeps the spin animation
 * and the winner reveal independent: the motion starts immediately on
 * mount and the winner card only appears once the timer elapses.
 */
export function useRevealStart(
  spinId: number,
  reducedMotion: boolean,
): boolean {
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (reducedMotion) {
      setStarted(true);
      return;
    }
    setStarted(false);
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setStarted(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [spinId, reducedMotion]);
  return started;
}

/** Props every reveal animation receives. */
export interface RevealProps {
  pool: RandomizerBuild[];
  probabilities: number[];
  winner: RandomizerBuild;
  winnerProbability: number;
  /** Bumped each spin so the reveal remounts/re-runs cleanly. */
  spinId: number;
  matchupLabel: string;
  onComplete?: () => void;
}

/** Centering frame shared by every reveal. */
export function RevealFrame({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        width: "100%",
        height: "100%",
        minHeight: 280,
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        color: "#e6e8ee",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
}

/** Small matchup pill shown above a reveal. */
export function MatchupPill({ label }: { label: string }) {
  return (
    <div
      style={{
        fontSize: 13,
        fontWeight: 700,
        letterSpacing: "0.18em",
        textTransform: "uppercase",
        color: "#9aa3b2",
        marginBottom: 10,
      }}
    >
      {label} · Build Roulette
    </div>
  );
}

/**
 * The final winner card every reveal lands on — a big zoomed-in reveal
 * of the chosen build's unit sprite + name so it's instantly clear
 * which build won. `src` is the winner's assigned sprite (so the card
 * matches the icon shown during the animation); it defaults to the
 * build's resolved unit sprite.
 */
export function WinnerCard({
  winner,
  rarity,
  show,
  src,
}: {
  winner: RandomizerBuild;
  rarity: Rarity;
  show: boolean;
  src?: string | null;
}) {
  const resolvedSrc = src === undefined ? spriteFor(winner) : src;
  return (
    <div
      style={{
        marginTop: 18,
        minWidth: 300,
        maxWidth: 480,
        padding: "18px 26px 20px",
        borderRadius: 18,
        textAlign: "center",
        position: "relative",
        background:
          "linear-gradient(135deg, rgba(11,13,18,0.97) 0%, rgba(24,28,38,0.97) 100%)",
        border: `2px solid ${rarity.color}`,
        boxShadow: `0 12px 46px rgba(0,0,0,0.62), 0 0 44px ${rarity.glow}`,
        opacity: show ? 1 : 0,
        transform: show ? "scale(1)" : "scale(0.7)",
        transition: "opacity 280ms ease, transform 360ms cubic-bezier(.34,1.8,.5,1)",
      }}
    >
      <div
        style={{
          display: "inline-block",
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: rarity.color,
          padding: "3px 10px",
          borderRadius: 999,
          border: `1px solid ${rarity.color}`,
          marginBottom: 12,
        }}
      >
        {rarity.label} · Build Chosen
      </div>
      {/* Large zoom-in of the winning unit. */}
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          marginBottom: 12,
        }}
      >
        {show ? (
          <span
            key="winzoom"
            style={{
              position: "relative",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 96,
              height: 96,
              borderRadius: "50%",
              background: `radial-gradient(circle, ${rarity.color}33 0%, transparent 70%)`,
              animation: "rdz-winzoom 560ms cubic-bezier(.2,1.4,.4,1) both",
            }}
          >
            <span
              aria-hidden
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: "50%",
                border: `2px solid ${rarity.color}`,
                boxShadow: `0 0 26px ${rarity.glow}`,
                animation: "rdz-pulse 1600ms ease-in-out infinite",
              }}
            />
            <SpriteOrRace build={winner} src={resolvedSrc} size={72} />
          </span>
        ) : null}
      </div>
      <div
        style={{
          fontSize: 26,
          fontWeight: 800,
          lineHeight: 1.15,
          letterSpacing: "-0.01em",
        }}
      >
        {winner.name}
      </div>
      {show ? <Confetti color={rarity.color} /> : null}
    </div>
  );
}

/**
 * Render the winner's unit sprite, falling back to the race glyph.
 * Lives here (rather than importing BuildSprite) so revealShared stays
 * free of a dependency cycle with spriteShared.
 */
function SpriteOrRace({
  build,
  src,
  size,
}: {
  build: RandomizerBuild;
  src?: string | null;
  size: number;
}) {
  const [errored, setErrored] = useState(false);
  if (!src || errored) return <RaceIcon race={build.race} size={size} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="eager"
      decoding="sync"
      draggable={false}
      onError={() => setErrored(true)}
      style={{
        width: size,
        height: size,
        objectFit: "contain",
        display: "block",
        position: "relative",
      }}
    />
  );
}

/** Lightweight CSS confetti burst on the winner reveal. */
function Confetti({ color }: { color: string }) {
  const bits = Array.from({ length: 14 });
  const colors = [color, "#e6b450", "#3ec0c7", "#d16ba5", "#3ec07a"];
  return (
    <div
      aria-hidden
      style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" }}
    >
      {bits.map((_, i) => {
        const left = (i / bits.length) * 100;
        const delay = (i % 5) * 60;
        return (
          <span
            key={i}
            className="rdz-confetti"
            style={{
              position: "absolute",
              top: -8,
              left: `${left}%`,
              width: 7,
              height: 10,
              background: colors[i % colors.length],
              borderRadius: 2,
              animationDelay: `${delay}ms`,
            }}
          />
        );
      })}
    </div>
  );
}

/**
 * Injected keyframes used across every reveal. Mounted once at the top
 * of `RandomizerStage`. Scoped with the `rdz-` prefix.
 */
export function RevealKeyframes() {
  return (
    <style>{`
      @keyframes rdz-confetti {
        0%   { transform: translateY(0) rotate(0deg); opacity: 1; }
        100% { transform: translateY(120px) rotate(420deg); opacity: 0; }
      }
      .rdz-confetti { animation: rdz-confetti 900ms ease-in forwards; }
      @keyframes rdz-pulse {
        0%, 100% { transform: scale(1); opacity: 0.85; }
        50%      { transform: scale(1.12); opacity: 1; }
      }
      @keyframes rdz-charge {
        0%   { transform: scale(0.2); opacity: 0; }
        70%  { transform: scale(1.25); opacity: 1; }
        100% { transform: scale(1); opacity: 1; }
      }
      @keyframes rdz-flash {
        0%   { opacity: 0; }
        45%  { opacity: 0.95; }
        100% { opacity: 0; }
      }
      @keyframes rdz-beam {
        0%   { transform: scaleY(0); opacity: 0; }
        55%  { transform: scaleY(1); opacity: 0.95; }
        100% { transform: scaleY(1); opacity: 0.55; }
      }
      @keyframes rdz-shake {
        0%, 100% { transform: translateX(0); }
        25% { transform: translateX(-4px); }
        75% { transform: translateX(4px); }
      }
      @keyframes rdz-spin-in {
        0% { transform: scale(0.6) rotate(-12deg); opacity: 0; }
        100% { transform: scale(1) rotate(0deg); opacity: 1; }
      }
      @keyframes rdz-winzoom {
        0%   { transform: scale(0.2); opacity: 0; }
        55%  { transform: scale(1.22); opacity: 1; }
        75%  { transform: scale(0.94); }
        100% { transform: scale(1); opacity: 1; }
      }
      @media (prefers-reduced-motion: reduce) {
        .rdz-confetti { animation: none !important; opacity: 0 !important; }
      }
    `}</style>
  );
}
