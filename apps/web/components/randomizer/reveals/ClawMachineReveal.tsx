"use client";

/**
 * Claw Machine — the classic arcade grabber. A claw slides over a bin of
 * jumbled build sprites, descends, grabs the engine's winner, and hoists
 * it up out of the pile.
 */
import { useMemo } from "react";
import type { RandomizerBuild } from "@/lib/randomizer/types";
import {
  MatchupPill,
  RevealFrame,
  WinnerCard,
  raceHex,
  rarityFor,
  useReducedMotion,
  type RevealProps,
} from "./revealShared";
import { BuildSprite, seededShuffle, spriteFor, useElapsedReveal } from "./spriteShared";

const W = 460;
const H = 320;
const TOP_Y = 30;
const BIN_Y = H - 56;
const GRAB_Y = H - 70;
const R = 24;
const DURATION_MS = 6200;

interface Toy {
  build: RandomizerBuild;
  src: string | null;
  x: number;
  rot: number;
}

export function ClawMachineReveal({
  pool,
  winner,
  winnerProbability,
  spinId,
  matchupLabel,
  onComplete,
}: RevealProps) {
  const reducedMotion = useReducedMotion();
  const rarity = rarityFor(winnerProbability);
  const { elapsed, settled } = useElapsedReveal(
    spinId,
    DURATION_MS,
    reducedMotion,
    onComplete,
  );

  const toys = useMemo<Toy[]>(() => {
    const order = seededShuffle(pool, spinId);
    const slotW = (W - 60) / Math.max(1, order.length);
    return order.map((b, i) => ({
      build: b,
      src: spriteFor(b),
      x: 30 + slotW * (i + 0.5),
      rot: ((i * 47) % 30) - 15,
    }));
  }, [pool, spinId]);

  const winnerToy = toys.find((t) => t.build.id === winner.id) ?? toys[0];
  const p = Math.min(1, elapsed / DURATION_MS);
  const { clawX, clawTipY, grabbed } = clawMotion(p, winnerToy.x);

  return (
    <RevealFrame>
      <MatchupPill label={matchupLabel} />
      <div
        style={{
          position: "relative",
          width: W,
          height: H,
          maxWidth: "92vw",
          borderRadius: 14,
          overflow: "hidden",
          background:
            "linear-gradient(180deg, rgba(20,24,34,0.96) 0%, rgba(11,13,18,0.97) 100%)",
          border: `1px solid ${rarity.color}55`,
          boxShadow: `0 10px 30px rgba(0,0,0,0.5), inset 0 0 40px ${rarity.glow}`,
        }}
      >
        {/* Top rail */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            top: TOP_Y - 8,
            left: 0,
            width: "100%",
            height: 4,
            background: "rgba(255,255,255,0.14)",
          }}
        />
        {/* Cable + claw */}
        <Claw x={clawX} tipY={clawTipY} grabbed={grabbed} color={rarity.color} />

        {/* Toys in the bin */}
        {toys.map((t) => {
          const isWinner = t.build.id === winner.id;
          const lifted = isWinner && grabbed;
          const x = lifted ? clawX : t.x;
          const y = lifted ? clawTipY + R : BIN_Y;
          return (
            <ToyChip
              key={t.build.id}
              toy={t}
              x={x}
              y={y}
              rot={lifted ? 0 : t.rot}
              isWinner={isWinner}
              highlight={settled && isWinner}
            />
          );
        })}

        {/* Bin lip */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            width: "100%",
            height: 22,
            background: "linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02))",
            borderTop: "1px solid rgba(255,255,255,0.12)",
          }}
        />
      </div>
      <WinnerCard winner={winner} rarity={rarity} show={settled} />
    </RevealFrame>
  );
}

/** Scripted claw path: slide → drop → grab → lift. */
function clawMotion(
  p: number,
  winnerX: number,
): { clawX: number; clawTipY: number; grabbed: boolean } {
  const startX = W * 0.22;
  if (p < 0.3) {
    // Slide across to above the winner.
    const t = p / 0.3;
    return { clawX: lerp(startX, winnerX, easeInOut(t)), clawTipY: TOP_Y, grabbed: false };
  }
  if (p < 0.52) {
    // Descend into the bin.
    const t = (p - 0.3) / 0.22;
    return { clawX: winnerX, clawTipY: lerp(TOP_Y, GRAB_Y, easeInOut(t)), grabbed: false };
  }
  if (p < 0.62) {
    // Grab pause.
    return { clawX: winnerX, clawTipY: GRAB_Y, grabbed: true };
  }
  // Lift back up.
  const t = Math.min(1, (p - 0.62) / 0.3);
  return { clawX: winnerX, clawTipY: lerp(GRAB_Y, TOP_Y, easeInOut(t)), grabbed: true };
}

function Claw({
  x,
  tipY,
  grabbed,
  color,
}: {
  x: number;
  tipY: number;
  grabbed: boolean;
  color: string;
}) {
  return (
    <div aria-hidden style={{ position: "absolute", left: 0, top: 0 }}>
      {/* Cable */}
      <div
        style={{
          position: "absolute",
          left: x,
          top: TOP_Y,
          width: 2,
          height: Math.max(0, tipY - TOP_Y),
          background: "rgba(255,255,255,0.5)",
          transform: "translateX(-50%)",
        }}
      />
      {/* Claw prongs */}
      {[-1, 1].map((dir) => (
        <div
          key={dir}
          style={{
            position: "absolute",
            left: x,
            top: tipY,
            width: 4,
            height: 22,
            background: color,
            borderRadius: 2,
            transformOrigin: "top center",
            transform: `translateX(-50%) rotate(${dir * (grabbed ? 12 : 32)}deg)`,
            transition: "transform 150ms ease",
            boxShadow: `0 0 8px ${color}`,
          }}
        />
      ))}
      {/* Hub */}
      <div
        style={{
          position: "absolute",
          left: x,
          top: tipY - 6,
          width: 16,
          height: 10,
          background: color,
          borderRadius: 3,
          transform: "translateX(-50%)",
        }}
      />
    </div>
  );
}

function ToyChip({
  toy,
  x,
  y,
  rot,
  isWinner,
  highlight,
}: {
  toy: Toy;
  x: number;
  y: number;
  rot: number;
  isWinner: boolean;
  highlight: boolean;
}) {
  const accent = raceHex(toy.build.race);
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: R * 2,
        height: R * 2,
        transform: `translate(-50%, -50%) rotate(${rot}deg) scale(${highlight ? 1.2 : 1})`,
        transition: "left 120ms linear, top 120ms linear, transform 300ms ease",
        borderRadius: "50%",
        border: `2px solid ${isWinner && highlight ? "#e6b450" : accent}`,
        background: `${accent}22`,
        boxShadow: highlight ? `0 0 22px ${accent}` : "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      <BuildSprite build={toy.build} src={toy.src} size={R * 2 - 12} />
    </div>
  );
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}
