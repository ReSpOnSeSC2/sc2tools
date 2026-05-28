"use client";

/**
 * Battle Royale elimination — all eligible builds enter as contestants
 * and get knocked out one by one until the winner is crowned. The
 * elimination order is computed up front, so the visual matches the
 * engine's already-decided pick.
 */
import { useEffect, useMemo, useState } from "react";
import { RaceIcon } from "@/components/overlay/WidgetShell";
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
import { useRevealSound } from "./revealSound";

const TICK_MS = 450;
const FINAL_DELAY = 600;

export function BattleRoyaleReveal({
  pool,
  winner,
  winnerProbability,
  spinId,
  matchupLabel,
  onComplete,
}: RevealProps) {
  const reducedMotion = useReducedMotion();
  const rarity = rarityFor(winnerProbability);
  const eliminationOrder = useMemo(
    () => buildEliminationOrder(pool, winner, spinId),
    [pool, winner, spinId],
  );
  const { eliminated, settled } = useEliminationDriver(
    spinId,
    eliminationOrder,
    reducedMotion,
    onComplete,
  );
  useRevealSound({
    style: "battle",
    spinId,
    durationMs: eliminationOrder.length * TICK_MS + FINAL_DELAY,
    reducedMotion,
    eliminationTimesMs: eliminationOrder.map((_, i) => (i + 1) * TICK_MS),
  });

  return (
    <RevealFrame>
      <MatchupPill label={matchupLabel} />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: gridColumns(pool.length),
          gap: 8,
          padding: 14,
          borderRadius: 14,
          width: "min(560px, 92vw)",
          background:
            "linear-gradient(180deg, rgba(11,13,18,0.95) 0%, rgba(22,26,35,0.95) 100%)",
          border: `1px solid ${rarity.color}55`,
          boxShadow: `0 8px 28px rgba(0,0,0,0.5)`,
        }}
      >
        {pool.map((b) => (
          <Contestant
            key={b.id}
            build={b}
            isWinner={b.id === winner.id && settled}
            isDown={eliminated.has(b.id)}
          />
        ))}
      </div>
      <WinnerCard winner={winner} rarity={rarity} show={settled} />
    </RevealFrame>
  );
}

function Contestant({
  build,
  isWinner,
  isDown,
}: {
  build: RandomizerBuild;
  isWinner: boolean;
  isDown: boolean;
}) {
  const accent = raceHex(build.race);
  return (
    <div
      style={{
        position: "relative",
        padding: "8px 10px",
        borderRadius: 10,
        background: isDown
          ? "rgba(20,22,30,0.7)"
          : "linear-gradient(180deg, rgba(28,32,42,0.96) 0%, rgba(16,18,26,0.96) 100%)",
        border: `1px solid ${isWinner ? "#e6b450" : isDown ? "rgba(255,107,107,0.4)" : `${accent}55`}`,
        boxShadow: isWinner ? `0 0 22px ${accent}` : "none",
        opacity: isDown ? 0.35 : 1,
        filter: isDown ? "grayscale(0.9)" : "none",
        transition: "opacity 300ms ease, filter 300ms ease, transform 300ms ease",
        transform: isWinner ? "scale(1.04)" : "scale(1)",
        minHeight: 48,
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      <RaceIcon race={build.race} size={20} />
      <span
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: "#e6e8ee",
          lineHeight: 1.2,
          overflow: "hidden",
          textOverflow: "ellipsis",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
        }}
      >
        {build.name}
      </span>
      {isDown ? <KOOverlay /> : null}
    </div>
  );
}

function KOOverlay() {
  return (
    <span
      aria-hidden
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 18,
        fontWeight: 900,
        color: "#ff6b6b",
        letterSpacing: "0.1em",
        textShadow: "0 0 8px rgba(0,0,0,0.8)",
        pointerEvents: "none",
      }}
    >
      ✕
    </span>
  );
}

function gridColumns(n: number): string {
  if (n <= 2) return "repeat(2, 1fr)";
  if (n <= 6) return "repeat(3, 1fr)";
  return "repeat(4, 1fr)";
}

function buildEliminationOrder(
  pool: RandomizerBuild[],
  winner: RandomizerBuild,
  spinId: number,
): string[] {
  const losers = pool.filter((b) => b.id !== winner.id);
  let s = spinId | 0;
  for (let i = losers.length - 1; i > 0; i -= 1) {
    s = (s * 1664525 + 1013904223) | 0;
    const j = Math.abs(s) % (i + 1);
    [losers[i], losers[j]] = [losers[j], losers[i]];
  }
  return losers.map((b) => b.id);
}

function useEliminationDriver(
  spinId: number,
  order: string[],
  reducedMotion: boolean,
  onComplete?: () => void,
): { eliminated: Set<string>; settled: boolean } {
  const [eliminated, setEliminated] = useState<Set<string>>(() => new Set());
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    setEliminated(new Set());
    setSettled(false);

    if (reducedMotion || order.length === 0) {
      setEliminated(new Set(order));
      setSettled(true);
      onComplete?.();
      return;
    }

    const handles: number[] = [];
    order.forEach((id, i) => {
      handles.push(
        window.setTimeout(() => {
          setEliminated((prev) => {
            const next = new Set(prev);
            next.add(id);
            return next;
          });
        }, (i + 1) * TICK_MS),
      );
    });
    handles.push(
      window.setTimeout(
        () => {
          setSettled(true);
          onComplete?.();
        },
        order.length * TICK_MS + FINAL_DELAY,
      ),
    );

    return () => {
      for (const h of handles) window.clearTimeout(h);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spinId, reducedMotion, order]);

  return { eliminated, settled };
}
