"use client";

/**
 * Asteroid Lock-On — builds drift through space bouncing off the walls
 * while a targeting reticle hunts them down, zapping the losers one by
 * one (rigged schedule) before locking onto the engine's winner.
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
const R = 24;
const DURATION_MS = 8500;

interface Rock {
  id: string;
  build: RandomizerBuild;
  src: string | null;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export function AsteroidLockReveal({
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
  useRevealSound({
    style: "asteroid",
    spinId,
    durationMs: DURATION_MS,
    reducedMotion,
    eliminationTimesMs: loserOrder.map(
      (_, i) => (DURATION_MS / (loserOrder.length + 1)) * (i + 1),
    ),
  });

  const sprites = useMemo(() => assignPoolSprites(pool), [pool]);
  const rocksRef = useRef<Rock[]>([]);
  const reticleRef = useRef({ x: W / 2, y: H / 2 });
  const [, force] = useState(0);

  useMemo(() => {
    rocksRef.current = pool.map((b, i) => {
      const angle = (i / pool.length) * Math.PI * 2;
      return {
        id: b.id,
        build: b,
        src: sprites.get(b.id) ?? null,
        x: W / 2 + Math.cos(angle) * (W / 4),
        y: H / 2 + Math.sin(angle) * (H / 4),
        vx: Math.cos(angle * 1.7 + i) * 0.14,
        vy: Math.sin(angle * 2.3 + i) * 0.14,
      };
    });
    reticleRef.current = { x: W / 2, y: H / 2 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spinId, pool]);

  useRaf(!reducedMotion && !settled, spinId, (dt) => {
    const speed = dt / 16;
    for (const r of rocksRef.current) {
      if (eliminated.has(r.id) && r.id !== winner.id) continue;
      r.x += r.vx * dt * speed;
      r.y += r.vy * dt * speed;
      if (r.x < R) { r.x = R; r.vx = Math.abs(r.vx); }
      if (r.x > W - R) { r.x = W - R; r.vx = -Math.abs(r.vx); }
      if (r.y < R) { r.y = R; r.vy = Math.abs(r.vy); }
      if (r.y > H - R) { r.y = H - R; r.vy = -Math.abs(r.vy); }
    }
    // Reticle chases the current target (next loser, else the winner).
    const targetId = nextOutId ?? winner.id;
    const target = rocksRef.current.find((r) => r.id === targetId);
    if (target) {
      reticleRef.current.x += (target.x - reticleRef.current.x) * Math.min(1, 0.08 * speed);
      reticleRef.current.y += (target.y - reticleRef.current.y) * Math.min(1, 0.08 * speed);
    }
    force((n) => (n + 1) % 1000000);
  });

  const targetId = nextOutId ?? winner.id;

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
            "radial-gradient(circle at 30% 20%, rgba(28,30,52,0.9) 0%, rgba(6,7,12,0.98) 100%)",
          border: `1px solid ${rarity.color}44`,
          boxShadow: "0 10px 30px rgba(0,0,0,0.55)",
        }}
      >
        <Starfield />
        {rocksRef.current.map((r) => {
          const out = eliminated.has(r.id) && r.id !== winner.id;
          return (
            <RockChip
              key={r.id}
              rock={r}
              isOut={out}
              isWinner={settled && r.id === winner.id}
            />
          );
        })}
        <Reticle
          x={reticleRef.current.x}
          y={reticleRef.current.y}
          locked={settled || targetId === winner.id}
          color={settled ? rarity.color : "#3ec0c7"}
        />
      </div>
      <SpriteLegend
        pool={pool}
        sprites={sprites}
        eliminated={eliminated}
        highlightId={settled ? winner.id : nextOutId}
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

function RockChip({
  rock,
  isOut,
  isWinner,
}: {
  rock: Rock;
  isOut: boolean;
  isWinner: boolean;
}) {
  const accent = raceHex(rock.build.race);
  return (
    <div
      style={{
        position: "absolute",
        left: rock.x,
        top: rock.y,
        width: R * 2,
        height: R * 2,
        transform: `translate(-50%, -50%) scale(${isOut ? 1.8 : isWinner ? 1.25 : 1})`,
        opacity: isOut ? 0 : 1,
        transition: "opacity 320ms ease, transform 320ms ease",
        borderRadius: "50%",
        border: `2px solid ${isWinner ? "#e6b450" : accent}`,
        background: SPRITE_TOKEN_BG,
        boxShadow: isWinner ? `0 0 22px ${accent}` : "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      <BuildSprite build={rock.build} src={rock.src} size={R * 2 - 12} />
    </div>
  );
}

function Reticle({
  x,
  y,
  locked,
  color,
}: {
  x: number;
  y: number;
  locked: boolean;
  color: string;
}) {
  const s = locked ? 64 : 52;
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: s,
        height: s,
        transform: "translate(-50%, -50%)",
        border: `2px solid ${color}`,
        borderRadius: "50%",
        boxShadow: `0 0 12px ${color}`,
        pointerEvents: "none",
        transition: "width 200ms ease, height 200ms ease",
      }}
    >
      {[0, 90, 180, 270].map((deg) => (
        <span
          key={deg}
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            width: 2,
            height: 12,
            background: color,
            transformOrigin: "center -10px",
            transform: `translate(-50%, -50%) rotate(${deg}deg) translateY(-${s / 2 - 4}px)`,
          }}
        />
      ))}
    </div>
  );
}

function Starfield() {
  const stars = Array.from({ length: 30 });
  return (
    <div aria-hidden style={{ position: "absolute", inset: 0 }}>
      {stars.map((_, i) => {
        const x = (i * 53) % 100;
        const y = (i * 37) % 100;
        return (
          <span
            key={i}
            style={{
              position: "absolute",
              left: `${x}%`,
              top: `${y}%`,
              width: i % 4 === 0 ? 2 : 1,
              height: i % 4 === 0 ? 2 : 1,
              borderRadius: "50%",
              background: "rgba(255,255,255,0.55)",
            }}
          />
        );
      })}
    </div>
  );
}
