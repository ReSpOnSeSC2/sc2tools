"use client";

/**
 * Horse Race — each build is a sprite sprinting down its own lane toward
 * a finish line. Lead changes keep it tense, but the rigged final
 * standings put the engine's winner across the line first.
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
import { assignPoolSprites, BuildSprite, useElapsedReveal } from "./spriteShared";

const W = 560;
const LANE_H = 38;
const DURATION_MS = 7200;
const SPRITE = 30;

interface Racer {
  build: RandomizerBuild;
  src: string | null;
  finalProgress: number;
  wobbleAmp: number;
  wobbleFreq: number;
  phase: number;
}

export function HorseRaceReveal({
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

  const sprites = useMemo(() => assignPoolSprites(pool), [pool]);
  const racers = useMemo<Racer[]>(() => {
    let s = spinId | 0;
    const rng = () => {
      s = (s * 1664525 + 1013904223) | 0;
      return Math.abs(s) / 0x7fffffff;
    };
    return pool.map((b) => ({
      build: b,
      src: sprites.get(b.id) ?? null,
      finalProgress: b.id === winner.id ? 1 : 0.7 + rng() * 0.24,
      wobbleAmp: 0.06 + rng() * 0.05,
      wobbleFreq: 5 + rng() * 4,
      phase: rng() * Math.PI * 2,
    }));
  }, [pool, winner.id, spinId, sprites]);

  const trackW = W - SPRITE - 28;
  const p = Math.min(1, elapsed / DURATION_MS);

  return (
    <RevealFrame>
      <MatchupPill label={matchupLabel} />
      <div
        style={{
          position: "relative",
          width: W,
          maxWidth: "92vw",
          borderRadius: 14,
          padding: "10px 14px",
          background:
            "linear-gradient(180deg, rgba(18,21,29,0.96) 0%, rgba(11,13,18,0.96) 100%)",
          border: `1px solid ${rarity.color}44`,
          boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
        }}
      >
        {/* Finish line */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            top: 8,
            bottom: 8,
            right: 18,
            width: 8,
            backgroundImage:
              "repeating-linear-gradient(45deg, #e6e8ee 0 5px, #11131a 5px 10px)",
            borderRadius: 2,
            opacity: 0.8,
          }}
        />
        {racers.map((r, i) => (
          <Lane
            key={r.build.id}
            racer={r}
            progress={progressFor(r, p)}
            trackW={trackW}
            isWinner={settled && r.build.id === winner.id}
            laneIndex={i}
          />
        ))}
      </div>
      <WinnerCard
        winner={winner}
        rarity={rarity}
        show={settled}
        src={sprites.get(winner.id) ?? null}
      />
    </RevealFrame>
  );
}

function progressFor(r: Racer, p: number): number {
  const ease = 1 - Math.pow(1 - p, 2.4);
  // Wobble fades to zero by the finish so the standings settle cleanly.
  const wobble = r.wobbleAmp * Math.sin(p * r.wobbleFreq + r.phase) * (1 - p);
  const cap = r.finalProgress >= 1 ? 1 : 0.97;
  return Math.max(0, Math.min(cap, r.finalProgress * ease + wobble));
}

function Lane({
  racer,
  progress,
  trackW,
  isWinner,
  laneIndex,
}: {
  racer: Racer;
  progress: number;
  trackW: number;
  isWinner: boolean;
  laneIndex: number;
}) {
  const accent = raceHex(racer.build.race);
  const x = progress * trackW;
  return (
    <div
      style={{
        position: "relative",
        height: LANE_H,
        borderBottom: "1px dashed rgba(255,255,255,0.07)",
        background: laneIndex % 2 === 0 ? "rgba(255,255,255,0.015)" : "transparent",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: x,
          top: "50%",
          transform: `translateY(-50%) scale(${isWinner ? 1.2 : 1})`,
          transition: "transform 300ms ease",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <div
          style={{
            width: SPRITE,
            height: SPRITE,
            borderRadius: "50%",
            border: `2px solid ${isWinner ? "#e6b450" : accent}`,
            background: `${accent}22`,
            boxShadow: isWinner ? `0 0 18px ${accent}` : "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <BuildSprite build={racer.build} src={racer.src} size={SPRITE - 8} />
        </div>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: isWinner ? "#e6b450" : "#9aa3b2",
            whiteSpace: "nowrap",
            maxWidth: 150,
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {racer.build.name}
        </span>
      </div>
    </div>
  );
}
