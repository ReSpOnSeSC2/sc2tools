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

/** The final winner card every reveal lands on. */
export function WinnerCard({
  winner,
  rarity,
  show,
}: {
  winner: RandomizerBuild;
  rarity: Rarity;
  show: boolean;
}) {
  return (
    <div
      style={{
        marginTop: 18,
        minWidth: 280,
        maxWidth: 460,
        padding: "16px 22px",
        borderRadius: 16,
        textAlign: "center",
        background:
          "linear-gradient(135deg, rgba(11,13,18,0.96) 0%, rgba(24,28,38,0.96) 100%)",
        border: `2px solid ${rarity.color}`,
        boxShadow: `0 10px 40px rgba(0,0,0,0.6), 0 0 36px ${rarity.glow}`,
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
        {rarity.label}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
        }}
      >
        <RaceIcon race={winner.race} size={34} />
        <span
          style={{
            fontSize: 24,
            fontWeight: 800,
            lineHeight: 1.15,
            letterSpacing: "-0.01em",
          }}
        >
          {winner.name}
        </span>
      </div>
      {show ? <Confetti color={rarity.color} /> : null}
    </div>
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
        60%  { transform: scaleY(1); opacity: 0.9; }
        100% { transform: scaleY(1); opacity: 0.25; }
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
      @media (prefers-reduced-motion: reduce) {
        .rdz-confetti { animation: none !important; opacity: 0 !important; }
      }
    `}</style>
  );
}
