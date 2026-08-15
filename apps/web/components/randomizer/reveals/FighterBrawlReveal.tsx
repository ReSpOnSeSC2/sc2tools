"use client";

/**
 * Fighter Brawl — every build enters as an SC2 sprite with a health bar
 * and they bounce around trading blows. Losers' HP drains on a rigged
 * schedule so the engine's predetermined winner is always the last one
 * standing, then gets crowned.
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

const W = 540;
const H = 300;
const R = 26;
export const FIGHTER_BRAWL_DURATION_MS = 11_000;
const DURATION_MS = FIGHTER_BRAWL_DURATION_MS;

interface Fighter {
  id: string;
  build: RandomizerBuild;
  src: string | null;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hit: number; // frames of hit-flash remaining
}

export function FighterBrawlReveal({
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
  const deathAt = useMemo(() => {
    const step = DURATION_MS / (loserOrder.length + 1);
    const map = new Map<string, number>();
    loserOrder.forEach((id, i) => map.set(id, step * (i + 1)));
    return map;
  }, [loserOrder]);

  const { eliminated, settled } = useEliminationSchedule(
    spinId,
    loserOrder,
    DURATION_MS,
    reducedMotion,
    onComplete,
  );
  useRevealSound({
    style: "fighter",
    spinId,
    durationMs: DURATION_MS,
    reducedMotion,
    eliminationTimesMs: loserOrder.map((id) => deathAt.get(id) ?? DURATION_MS),
  });

  const sprites = useMemo(() => assignPoolSprites(pool), [pool]);
  const fightersRef = useRef<Fighter[]>([]);
  const [, force] = useState(0);
  const elapsedRef = useRef(0);

  useMemo(() => {
    fightersRef.current = pool.map((b, i) => {
      const angle = (i / pool.length) * Math.PI * 2;
      return {
        id: b.id,
        build: b,
        src: sprites.get(b.id) ?? null,
        x: W / 2 + Math.cos(angle) * (W / 3.5),
        y: H / 2 + Math.sin(angle) * (H / 3.5),
        vx: Math.cos(angle * 2.7 + i) * 0.18,
        vy: Math.sin(angle * 1.9 + i) * 0.18,
        hit: 0,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spinId, pool]);

  useRaf(!reducedMotion && !settled, spinId, (dt, elapsed) => {
    elapsedRef.current = elapsed;
    const fighters = fightersRef.current;
    const alive = fighters.filter((f) => !eliminated.has(f.id) || f.id === winner.id);
    const speed = dt / 16;
    for (const f of alive) {
      f.x += f.vx * dt * speed;
      f.y += f.vy * dt * speed;
      if (f.x < R) { f.x = R; f.vx = Math.abs(f.vx); }
      if (f.x > W - R) { f.x = W - R; f.vx = -Math.abs(f.vx); }
      if (f.y < R) { f.y = R; f.vy = Math.abs(f.vy); }
      if (f.y > H - R) { f.y = H - R; f.vy = -Math.abs(f.vy); }
      if (f.hit > 0) f.hit -= dt;
    }
    // Pairwise collisions → swap velocities + hit flash.
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
          a.x -= nx * overlap / 2; a.y -= ny * overlap / 2;
          b.x += nx * overlap / 2; b.y += ny * overlap / 2;
          [a.vx, b.vx] = [b.vx, a.vx];
          [a.vy, b.vy] = [b.vy, a.vy];
          a.hit = 140; b.hit = 140;
        }
      }
    }
    force((n) => (n + 1) % 1000000);
  });

  const elapsed = settled ? DURATION_MS : elapsedRef.current;

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
            "radial-gradient(circle at 50% 40%, rgba(30,34,46,0.95) 0%, rgba(11,13,18,0.97) 100%)",
          border: `1px solid ${rarity.color}44`,
          boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
        }}
      >
        <ArenaFloor />
        {fightersRef.current.map((f) => {
          const isOut = eliminated.has(f.id) && f.id !== winner.id;
          const hp = hpFor(f.id, winner.id, deathAt, elapsed, isOut);
          return (
            <FighterChip
              key={f.id}
              fighter={f}
              hp={hp}
              isOut={isOut}
              isWinner={settled && f.id === winner.id}
            />
          );
        })}
      </div>
      <SpriteLegend
        pool={pool}
        sprites={sprites}
        eliminated={eliminated}
      />
      <WinnerCard
        winner={winner}
        rarity={rarity}
        show={settled}
        src={sprites.get(winner.id) ?? null}
      />
    </RevealFrame>
  );
}

function hpFor(
  id: string,
  winnerId: string,
  deathAt: Map<string, number>,
  elapsed: number,
  isOut: boolean,
): number {
  if (id === winnerId) {
    // Winner takes chip damage but never dies — bottoms out at 35%.
    return Math.max(0.35, 1 - (elapsed / DURATION_MS) * 0.55);
  }
  if (isOut) return 0;
  const death = deathAt.get(id) ?? DURATION_MS;
  return Math.max(0, 1 - elapsed / death);
}

function FighterChip({
  fighter,
  hp,
  isOut,
  isWinner,
}: {
  fighter: Fighter;
  hp: number;
  isOut: boolean;
  isWinner: boolean;
}) {
  const accent = raceHex(fighter.build.race);
  return (
    <div
      style={{
        position: "absolute",
        left: fighter.x,
        top: fighter.y,
        width: R * 2,
        transform: `translate(-50%, -50%) scale(${isOut ? 0.2 : isWinner ? 1.25 : 1})`,
        opacity: isOut ? 0 : 1,
        transition: "opacity 360ms ease, transform 360ms ease",
        textAlign: "center",
        pointerEvents: "none",
      }}
    >
      <HpBar hp={hp} winner={isWinner} />
      <div
        style={{
          width: R * 2,
          height: R * 2,
          borderRadius: "50%",
          background: fighter.hit > 0 ? "rgba(255,107,107,0.4)" : SPRITE_TOKEN_BG,
          border: `2px solid ${isWinner ? "#e6b450" : accent}`,
          boxShadow: isWinner ? `0 0 22px ${accent}` : fighter.hit > 0 ? "0 0 14px rgba(255,107,107,0.8)" : "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          margin: "0 auto",
        }}
      >
        <BuildSprite build={fighter.build} src={fighter.src} size={R * 2 - 12} />
      </div>
    </div>
  );
}

function HpBar({ hp, winner }: { hp: number; winner: boolean }) {
  const color = hp > 0.5 ? "#3ec07a" : hp > 0.25 ? "#e6b450" : "#ff6b6b";
  return (
    <div
      style={{
        width: R * 2,
        height: 5,
        borderRadius: 3,
        background: "rgba(0,0,0,0.55)",
        margin: "0 auto 4px",
        overflow: "hidden",
        border: "1px solid rgba(255,255,255,0.12)",
      }}
    >
      <div
        style={{
          width: `${Math.round(hp * 100)}%`,
          height: "100%",
          background: winner ? "#e6b450" : color,
          transition: "width 200ms linear",
        }}
      />
    </div>
  );
}

function ArenaFloor() {
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        inset: 0,
        backgroundImage:
          "repeating-linear-gradient(0deg, rgba(255,255,255,0.03) 0 1px, transparent 1px 26px), repeating-linear-gradient(90deg, rgba(255,255,255,0.03) 0 1px, transparent 1px 26px)",
      }}
    />
  );
}
