"use client";

/**
 * Hungry Swarm — Agar.io style. The engine's winner hunts down the
 * other builds, devouring them one by one (rigged schedule) and
 * visibly growing with every bite until it's the giant left standing.
 */
import { useMemo, useRef, useState } from "react";
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
import {
  BuildSprite,
  seededShuffle,
  spriteFor,
  useEliminationSchedule,
  useRaf,
} from "./spriteShared";

const W = 540;
const H = 300;
const BASE_R = 22;
const GROW = 8;
const DURATION_MS = 8500;

interface Blob {
  id: string;
  build: RandomizerBuild;
  src: string | null;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export function HungrySwarmReveal({
  pool,
  winner,
  winnerProbability,
  spinId,
  matchupLabel,
  onComplete,
}: RevealProps) {
  const reducedMotion = useReducedMotion();
  const rarity = rarityFor(winnerProbability);

  const loserOrder = useMemo(
    () => seededShuffle(pool.filter((b) => b.id !== winner.id), spinId).map((b) => b.id),
    [pool, winner.id, spinId],
  );
  const { eliminated, settled, nextOutId } = useEliminationSchedule(
    spinId,
    loserOrder,
    DURATION_MS,
    reducedMotion,
    onComplete,
  );

  const blobsRef = useRef<Blob[]>([]);
  const [, force] = useState(0);

  useMemo(() => {
    blobsRef.current = pool.map((b, i) => {
      const angle = (i / pool.length) * Math.PI * 2;
      return {
        id: b.id,
        build: b,
        src: spriteFor(b),
        x: b.id === winner.id ? W / 2 : W / 2 + Math.cos(angle) * (W / 3.2),
        y: b.id === winner.id ? H / 2 : H / 2 + Math.sin(angle) * (H / 3.2),
        vx: Math.cos(angle * 1.3 + i) * 0.1,
        vy: Math.sin(angle * 1.7 + i) * 0.1,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spinId, pool]);

  useRaf(!reducedMotion && !settled, spinId, (dt) => {
    const speed = dt / 16;
    const blobs = blobsRef.current;
    const win = blobs.find((b) => b.id === winner.id);
    for (const b of blobs) {
      if (b.id === winner.id) continue;
      if (eliminated.has(b.id)) continue;
      b.x += b.vx * dt * speed;
      b.y += b.vy * dt * speed;
      if (b.x < BASE_R) { b.x = BASE_R; b.vx = Math.abs(b.vx); }
      if (b.x > W - BASE_R) { b.x = W - BASE_R; b.vx = -Math.abs(b.vx); }
      if (b.y < BASE_R) { b.y = BASE_R; b.vy = Math.abs(b.vy); }
      if (b.y > H - BASE_R) { b.y = H - BASE_R; b.vy = -Math.abs(b.vy); }
    }
    // Winner glides toward its current prey (or screen centre at the end).
    if (win) {
      const preyId = nextOutId ?? winner.id;
      const prey = blobs.find((b) => b.id === preyId);
      const tx = prey && prey.id !== winner.id ? prey.x : W / 2;
      const ty = prey && prey.id !== winner.id ? prey.y : H / 2;
      win.x += (tx - win.x) * Math.min(1, 0.06 * speed);
      win.y += (ty - win.y) * Math.min(1, 0.06 * speed);
    }
    force((n) => (n + 1) % 1000000);
  });

  const eatenCount = [...eliminated].filter((id) => id !== winner.id).length;
  const winnerR = BASE_R + eatenCount * GROW;

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
            "radial-gradient(circle at 50% 50%, rgba(24,30,28,0.95) 0%, rgba(11,13,18,0.97) 100%)",
          border: `1px solid ${rarity.color}44`,
          boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
        }}
      >
        {blobsRef.current
          .filter((b) => b.id !== winner.id)
          .map((b) => (
            <BlobChip
              key={b.id}
              blob={b}
              r={BASE_R}
              isOut={eliminated.has(b.id)}
              isWinner={false}
            />
          ))}
        {/* Winner rendered last so it sits on top as it grows. */}
        {blobsRef.current
          .filter((b) => b.id === winner.id)
          .map((b) => (
            <BlobChip key={b.id} blob={b} r={winnerR} isOut={false} isWinner />
          ))}
      </div>
      <WinnerCard winner={winner} rarity={rarity} show={settled} />
    </RevealFrame>
  );
}

function BlobChip({
  blob,
  r,
  isOut,
  isWinner,
}: {
  blob: Blob;
  r: number;
  isOut: boolean;
  isWinner: boolean;
}) {
  const accent = raceHex(blob.build.race);
  return (
    <div
      style={{
        position: "absolute",
        left: blob.x,
        top: blob.y,
        width: r * 2,
        height: r * 2,
        transform: `translate(-50%, -50%) scale(${isOut ? 0 : 1})`,
        opacity: isOut ? 0 : 1,
        transition: "opacity 260ms ease, transform 260ms ease, width 300ms ease, height 300ms ease",
        borderRadius: "50%",
        border: `2px solid ${isWinner ? "#e6b450" : accent}`,
        background: isWinner
          ? `radial-gradient(circle, ${accent}55 0%, ${accent}22 100%)`
          : `${accent}22`,
        boxShadow: isWinner ? `0 0 26px ${accent}` : "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      <BuildSprite build={blob.build} src={blob.src} size={Math.max(16, r * 2 - 14)} />
    </div>
  );
}
