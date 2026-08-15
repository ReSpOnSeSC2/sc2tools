"use client";

/**
 * Battle Royale elimination. The engine's already-decided winner is always
 * present, while large pools use a deterministic visual bracket so the reveal
 * stays readable and finishes on a predictable schedule.
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

export const BATTLE_ROYALE_MAX_CONTENDERS = 12;
export const BATTLE_ROYALE_TICK_MS = 450;
export const BATTLE_ROYALE_FINAL_DELAY_MS = 600;
export const BATTLE_ROYALE_MAX_DURATION_MS =
  (BATTLE_ROYALE_MAX_CONTENDERS - 1) * BATTLE_ROYALE_TICK_MS +
  BATTLE_ROYALE_FINAL_DELAY_MS;

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
  const visualField = useMemo(
    () => buildBattleRoyaleField(pool, winner, spinId),
    [pool, winner, spinId],
  );
  const eliminationOrder = useMemo(
    () => buildEliminationOrder(visualField, winner, spinId),
    [visualField, winner, spinId],
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
    durationMs: battleRoyaleDurationMs(eliminationOrder.length),
    reducedMotion,
    eliminationTimesMs: eliminationOrder.map(
      (_, i) => (i + 1) * BATTLE_ROYALE_TICK_MS,
    ),
  });

  const isVisualSubset = pool.length > visualField.length;

  return (
    <RevealFrame>
      <MatchupPill label={matchupLabel} />
      {isVisualSubset ? (
        <div
          role="note"
          style={{
            width: "min(560px, 92vw)",
            marginBottom: 8,
            padding: "6px 10px",
            borderRadius: 9,
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "3px 10px",
            color: "#aeb5c5",
            background: "rgba(11,13,18,0.78)",
            border: "1px solid rgba(174,181,197,0.2)",
            fontSize: 11,
            lineHeight: 1.35,
          }}
        >
          <span style={{ color: "#e6e8ee", fontWeight: 700 }}>
            Visual bracket · {visualField.length} of {pool.length} builds shown
          </span>
          <span>Winner drawn from the full eligible pool</span>
        </div>
      ) : null}
      <div
        role="list"
        aria-label="Battle Royale contenders"
        style={{
          display: "grid",
          gridTemplateColumns: gridColumns(visualField.length),
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
        {visualField.map((b) => (
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
      role="listitem"
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

/**
 * Selects a stable, bounded visual field without ever replacing the winner
 * that the randomizer engine already chose from the complete eligible pool.
 */
export function buildBattleRoyaleField(
  pool: RandomizerBuild[],
  winner: RandomizerBuild,
  spinId: number,
): RandomizerBuild[] {
  const seen = new Set<string>();
  const uniquePool: RandomizerBuild[] = [];

  for (const build of pool) {
    if (seen.has(build.id)) continue;
    seen.add(build.id);
    uniquePool.push(build.id === winner.id ? winner : build);
  }
  if (!seen.has(winner.id)) uniquePool.push(winner);

  if (uniquePool.length <= BATTLE_ROYALE_MAX_CONTENDERS) return uniquePool;

  const sampledLosers = shuffled(
    uniquePool.filter((build) => build.id !== winner.id),
    spinId ^ 0x6d2b79f5,
  ).slice(0, BATTLE_ROYALE_MAX_CONTENDERS - 1);
  const shownIds = new Set(sampledLosers.map((build) => build.id));
  shownIds.add(winner.id);

  // Preserve source ordering so the winner's position does not become a tell.
  return uniquePool.filter((build) => shownIds.has(build.id));
}

/** Duration for a bounded number of visual knockouts, including the final beat. */
export function battleRoyaleDurationMs(eliminationCount: number): number {
  const boundedCount = Math.min(
    BATTLE_ROYALE_MAX_CONTENDERS - 1,
    Math.max(0, Math.trunc(eliminationCount)),
  );
  return (
    boundedCount * BATTLE_ROYALE_TICK_MS + BATTLE_ROYALE_FINAL_DELAY_MS
  );
}

function buildEliminationOrder(
  pool: RandomizerBuild[],
  winner: RandomizerBuild,
  spinId: number,
): string[] {
  return shuffled(
    pool.filter((b) => b.id !== winner.id),
    spinId,
  ).map((b) => b.id);
}

function shuffled<T>(items: T[], seed: number): T[] {
  const result = [...items];
  let s = seed | 0;
  for (let i = result.length - 1; i > 0; i -= 1) {
    s = (s * 1664525 + 1013904223) | 0;
    const j = Math.abs(s) % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
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
        }, (i + 1) * BATTLE_ROYALE_TICK_MS),
      );
    });
    handles.push(
      window.setTimeout(
        () => {
          setSettled(true);
          onComplete?.();
        },
        battleRoyaleDurationMs(order.length),
      ),
    );

    return () => {
      for (const h of handles) window.clearTimeout(h);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spinId, reducedMotion, order]);

  return { eliminated, settled };
}
