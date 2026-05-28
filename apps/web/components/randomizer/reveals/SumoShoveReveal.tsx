"use client";

/**
 * Sumo Shove-Off — builds bump around a circular ring; losers get
 * launched off the edge one by one (rigged schedule) until the engine's
 * winner is the last sprite still inside the ring.
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
  assignPoolSprites,
  BuildSprite,
  seededShuffle,
  SPRITE_TOKEN_BG,
  SpriteLegend,
  useEliminationSchedule,
  useRaf,
} from "./spriteShared";
import { useRevealSound } from "./revealSound";

const SIZE = 360;
const CENTER = SIZE / 2;
const RING_R = 158;
const R = 26;
const DURATION_MS = 9000;

interface Sumo {
  id: string;
  build: RandomizerBuild;
  src: string | null;
  x: number;
  y: number;
  vx: number;
  vy: number;
  launched: boolean;
  hit: number;
}

export function SumoShoveReveal({
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
  const { eliminated, settled } = useEliminationSchedule(
    spinId,
    loserOrder,
    DURATION_MS,
    reducedMotion,
    onComplete,
  );
  useRevealSound({
    style: "sumo",
    spinId,
    durationMs: DURATION_MS,
    reducedMotion,
    eliminationTimesMs: loserOrder.map(
      (_, i) => (DURATION_MS / (loserOrder.length + 1)) * (i + 1),
    ),
  });

  const sprites = useMemo(() => assignPoolSprites(pool), [pool]);
  const sumosRef = useRef<Sumo[]>([]);
  const [, force] = useState(0);

  useMemo(() => {
    sumosRef.current = pool.map((b, i) => {
      const angle = (i / pool.length) * Math.PI * 2;
      const rad = RING_R * 0.5;
      return {
        id: b.id,
        build: b,
        src: sprites.get(b.id) ?? null,
        x: CENTER + Math.cos(angle) * rad,
        y: CENTER + Math.sin(angle) * rad,
        vx: Math.cos(angle + i) * 0.16,
        vy: Math.sin(angle + i) * 0.16,
        launched: false,
        hit: 0,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spinId, pool]);

  useRaf(!reducedMotion && !settled, spinId, (dt) => {
    const sumos = sumosRef.current;
    const speed = dt / 16;
    for (const s of sumos) {
      const out = eliminated.has(s.id) && s.id !== winner.id;
      if (out && !s.launched) {
        // Shove the loser outward off the ring.
        const dx = s.x - CENTER || 1;
        const dy = s.y - CENTER || 1;
        const d = Math.hypot(dx, dy) || 1;
        s.vx = (dx / d) * 2.6;
        s.vy = (dy / d) * 2.6;
        s.launched = true;
        s.hit = 160;
      }
      s.x += s.vx * dt * speed;
      s.y += s.vy * dt * speed;
      if (s.hit > 0) s.hit -= dt;
      if (!out) {
        // Keep alive sumos inside the ring.
        const dx = s.x - CENTER;
        const dy = s.y - CENTER;
        const d = Math.hypot(dx, dy);
        if (d > RING_R - R) {
          const nx = dx / (d || 1);
          const ny = dy / (d || 1);
          s.x = CENTER + nx * (RING_R - R);
          s.y = CENTER + ny * (RING_R - R);
          const dot = s.vx * nx + s.vy * ny;
          s.vx -= 2 * dot * nx;
          s.vy -= 2 * dot * ny;
        }
      }
    }
    const alive = sumos.filter((s) => !(eliminated.has(s.id) && s.id !== winner.id));
    for (let i = 0; i < alive.length; i += 1) {
      for (let j = i + 1; j < alive.length; j += 1) {
        const a = alive[i];
        const b = alive[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 1;
        if (dist < R * 2) {
          const nx = dx / dist;
          const ny = dy / dist;
          const overlap = R * 2 - dist;
          a.x -= (nx * overlap) / 2; a.y -= (ny * overlap) / 2;
          b.x += (nx * overlap) / 2; b.y += (ny * overlap) / 2;
          [a.vx, b.vx] = [b.vx, a.vx];
          [a.vy, b.vy] = [b.vy, a.vy];
          a.hit = 140; b.hit = 140;
        }
      }
    }
    force((n) => (n + 1) % 1000000);
  });

  return (
    <RevealFrame>
      <MatchupPill label={matchupLabel} />
      <div
        style={{
          position: "relative",
          width: SIZE,
          height: SIZE,
          maxWidth: "92vw",
        }}
      >
        {/* Ring */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: CENTER - RING_R,
            top: CENTER - RING_R,
            width: RING_R * 2,
            height: RING_R * 2,
            borderRadius: "50%",
            background:
              "radial-gradient(circle, rgba(30,34,46,0.85) 0%, rgba(11,13,18,0.6) 70%, transparent 72%)",
            border: `3px solid ${rarity.color}66`,
            boxShadow: `0 0 30px ${rarity.glow}`,
          }}
        />
        {sumosRef.current.map((s) => {
          const out = eliminated.has(s.id) && s.id !== winner.id;
          return (
            <SumoChip
              key={s.id}
              sumo={s}
              isOut={out}
              isWinner={settled && s.id === winner.id}
            />
          );
        })}
      </div>
      <SpriteLegend pool={pool} sprites={sprites} eliminated={eliminated} />
      <WinnerCard
        winner={winner}
        rarity={rarity}
        show={settled}
        src={sprites.get(winner.id) ?? null}
      />
    </RevealFrame>
  );
}

function SumoChip({
  sumo,
  isOut,
  isWinner,
}: {
  sumo: Sumo;
  isOut: boolean;
  isWinner: boolean;
}) {
  const accent = raceHex(sumo.build.race);
  return (
    <div
      style={{
        position: "absolute",
        left: sumo.x,
        top: sumo.y,
        width: R * 2,
        height: R * 2,
        transform: `translate(-50%, -50%) scale(${isWinner ? 1.25 : 1}) rotate(${isOut ? 40 : 0}deg)`,
        opacity: isOut ? 0 : 1,
        transition: "opacity 500ms ease, transform 360ms ease",
        borderRadius: "50%",
        border: `2px solid ${isWinner ? "#e6b450" : accent}`,
        background: sumo.hit > 0 ? "rgba(255,107,107,0.35)" : SPRITE_TOKEN_BG,
        boxShadow: isWinner
          ? `0 0 22px ${accent}`
          : sumo.hit > 0
            ? "0 0 14px rgba(255,107,107,0.8)"
            : "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      <BuildSprite build={sumo.build} src={sumo.src} size={R * 2 - 14} />
    </div>
  );
}
