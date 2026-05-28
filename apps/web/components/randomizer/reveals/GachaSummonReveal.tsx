"use client";

/**
 * Gacha summon — a charging orb builds tension, a quick screen flash
 * detonates, and the winner card lands inside a fan of rarity-coloured
 * beams. Beam colour intensifies with the build's rarity (lower
 * landing probability = more dramatic reveal).
 */
import { useEffect, useState } from "react";
import type { RandomizerBuild } from "@/lib/randomizer/types";
import {
  MatchupPill,
  RevealFrame,
  WinnerCard,
  raceHex,
  rarityFor,
  useReducedMotion,
  useRevealTimer,
  type RevealProps,
} from "./revealShared";
import { useRevealSound } from "./revealSound";

const CHARGE_MS = 1500;
const FLASH_MS = 320;
const DURATION_MS = CHARGE_MS + FLASH_MS;
const BEAM_COUNT = 8;

export function GachaSummonReveal({
  winner,
  winnerProbability,
  spinId,
  matchupLabel,
  onComplete,
}: RevealProps) {
  const reducedMotion = useReducedMotion();
  const settled = useRevealTimer(spinId, DURATION_MS, reducedMotion, onComplete);
  const rarity = rarityFor(winnerProbability);
  useRevealSound({ style: "gacha", spinId, durationMs: DURATION_MS, reducedMotion });
  const flashOn = useFlashWindow(spinId, reducedMotion);
  const accent = raceHex(winner.race);

  return (
    <RevealFrame>
      <MatchupPill label={matchupLabel} />
      <div
        style={{
          position: "relative",
          width: 480,
          maxWidth: "92vw",
          minHeight: 240,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {/* Beams fan out behind the winner card when settled. */}
        {settled ? <Beams color={rarity.color} /> : null}
        {/* Charging orb during the wind-up. */}
        {!settled ? <ChargeOrb color={accent} rarityColor={rarity.color} /> : null}
        {/* Reveal flash. */}
        <Flash on={flashOn && !reducedMotion} color={rarity.color} />
        <WinnerCard winner={winner} rarity={rarity} show={settled} />
      </div>
    </RevealFrame>
  );
}

function ChargeOrb({
  color,
  rarityColor,
}: {
  color: string;
  rarityColor: string;
}) {
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        width: 110,
        height: 110,
        borderRadius: "50%",
        background: `radial-gradient(circle, ${color} 0%, ${rarityColor} 60%, transparent 100%)`,
        boxShadow: `0 0 60px ${rarityColor}, inset 0 0 24px ${color}`,
        animation: "rdz-charge 1500ms ease-out forwards, rdz-pulse 700ms ease-in-out 1500ms infinite",
      }}
    />
  );
}

function Flash({ on, color }: { on: boolean; color: string }) {
  if (!on) return null;
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        inset: -120,
        background: `radial-gradient(circle, ${color} 0%, rgba(255,255,255,0.85) 35%, transparent 70%)`,
        opacity: 0,
        animation: `rdz-flash ${FLASH_MS}ms ease-out forwards`,
        pointerEvents: "none",
      }}
    />
  );
}

function Beams({ color }: { color: string }) {
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      {Array.from({ length: BEAM_COUNT }).map((_, i) => {
        const angle = (i * 360) / BEAM_COUNT;
        return (
          <span
            key={i}
            style={{
              position: "absolute",
              width: 4,
              height: 220,
              background: `linear-gradient(180deg, ${color} 0%, transparent 100%)`,
              transformOrigin: "50% 0%",
              transform: `rotate(${angle}deg)`,
              animation: `rdz-beam 700ms ease-out ${i * 40}ms both`,
              filter: `drop-shadow(0 0 6px ${color})`,
            }}
          />
        );
      })}
    </div>
  );
}

/**
 * Flicks `true` briefly at the end of the charge so the flash element
 * animates exactly once per spin. Without this the flash would either
 * fail to fire after a remount or fire on the wrong frame.
 */
function useFlashWindow(spinId: number, reducedMotion: boolean): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (reducedMotion) return;
    setOn(false);
    const onHandle = window.setTimeout(() => setOn(true), CHARGE_MS - 80);
    const offHandle = window.setTimeout(() => setOn(false), DURATION_MS + 80);
    return () => {
      window.clearTimeout(onHandle);
      window.clearTimeout(offHandle);
    };
  }, [spinId, reducedMotion]);
  return on;
}
