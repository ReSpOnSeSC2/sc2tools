"use client";

/**
 * CS:GO-style case unboxing — a horizontal strip of build cards scrolls
 * past a center marker, decelerating sharply to settle on the winner.
 */
import { useMemo } from "react";
import { RaceIcon } from "@/components/overlay/WidgetShell";
import type { RandomizerBuild } from "@/lib/randomizer/types";
import {
  MatchupPill,
  RevealFrame,
  WinnerCard,
  raceHex,
  rarityFor,
  useReducedMotion,
  useRevealStart,
  useRevealTimer,
  type RevealProps,
} from "./revealShared";

const VIEWPORT_W = 520;
const VIEWPORT_H = 130;
const CARD_W = 160;
const GAP = 8;
const STEP = CARD_W + GAP;
const REPEATS = 8;
const DURATION_MS = 5200;

export function CaseUnboxingReveal({
  pool,
  winner,
  winnerProbability,
  spinId,
  matchupLabel,
  onComplete,
}: RevealProps) {
  const reducedMotion = useReducedMotion();
  const started = useRevealStart(spinId, reducedMotion);
  const settled = useRevealTimer(spinId, DURATION_MS, reducedMotion, onComplete);
  const rarity = rarityFor(winnerProbability);

  const { strip, targetOffset } = useMemo(() => {
    return buildStrip(pool, winner, spinId);
  }, [pool, winner, spinId]);

  // The strip starts scrolling the moment it mounts (`started`) and
  // decelerates over the full duration; the winner card only appears
  // once `settled`. Reduced motion snaps straight to the centered
  // winner with no slide.
  const offset = started ? targetOffset : 0;
  const transition = reducedMotion
    ? "none"
    : `transform ${DURATION_MS}ms cubic-bezier(.12,.85,.2,1)`;

  return (
    <RevealFrame>
      <MatchupPill label={matchupLabel} />
      <div
        style={{
          position: "relative",
          width: VIEWPORT_W,
          height: VIEWPORT_H,
          maxWidth: "92vw",
          borderRadius: 14,
          background:
            "linear-gradient(180deg, rgba(11,13,18,0.85) 0%, rgba(22,26,35,0.85) 100%)",
          border: "1px solid rgba(255,255,255,0.10)",
          boxShadow: "0 8px 28px rgba(0,0,0,0.45)",
          overflow: "hidden",
        }}
      >
        {/* Side fades */}
        <div style={fadeStyle("left")} aria-hidden />
        <div style={fadeStyle("right")} aria-hidden />
        {/* Center marker pointer */}
        <Pointer settled={settled} rarityColor={rarity.color} />
        {/* Scrolling strip */}
        <div
          key={spinId}
          style={{
            position: "absolute",
            top: (VIEWPORT_H - 90) / 2,
            left: VIEWPORT_W / 2,
            display: "flex",
            gap: GAP,
            transform: `translateX(${-offset - CARD_W / 2}px)`,
            transition,
            willChange: "transform",
          }}
        >
          {strip.map((b, i) => (
            <CaseCard key={`${b.id}-${i}`} build={b} />
          ))}
        </div>
      </div>
      <WinnerCard winner={winner} rarity={rarity} show={settled} />
    </RevealFrame>
  );
}

function CaseCard({ build }: { build: RandomizerBuild }) {
  const accent = raceHex(build.race);
  return (
    <div
      style={{
        flexShrink: 0,
        width: CARD_W,
        height: 90,
        borderRadius: 10,
        background:
          "linear-gradient(180deg, rgba(28,32,42,0.96) 0%, rgba(16,18,26,0.96) 100%)",
        border: `1px solid ${accent}55`,
        boxShadow: `inset 0 -3px 0 ${accent}88`,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        justifyContent: "center",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <RaceIcon race={build.race} size={20} />
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: accent,
          }}
        >
          {build.race}
        </span>
      </div>
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          lineHeight: 1.2,
          color: "#e6e8ee",
          overflow: "hidden",
          textOverflow: "ellipsis",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
        }}
      >
        {build.name}
      </div>
    </div>
  );
}

function Pointer({
  settled,
  rarityColor,
}: {
  settled: boolean;
  rarityColor: string;
}) {
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        top: 4,
        left: "50%",
        transform: "translateX(-50%)",
        width: 0,
        height: 0,
        borderLeft: "8px solid transparent",
        borderRight: "8px solid transparent",
        borderTop: `12px solid ${settled ? rarityColor : "#e6b450"}`,
        filter: `drop-shadow(0 0 6px ${settled ? rarityColor : "#e6b45088"})`,
        transition: "border-top-color 200ms ease, filter 200ms ease",
        zIndex: 2,
      }}
    />
  );
}

function fadeStyle(side: "left" | "right"): React.CSSProperties {
  return {
    position: "absolute",
    top: 0,
    [side]: 0 as 0,
    width: 90,
    height: "100%",
    pointerEvents: "none",
    zIndex: 1,
    background:
      side === "left"
        ? "linear-gradient(90deg, rgba(11,13,18,1) 0%, rgba(11,13,18,0) 100%)"
        : "linear-gradient(270deg, rgba(11,13,18,1) 0%, rgba(11,13,18,0) 100%)",
  };
}

/**
 * Build the horizontal strip and the translateX offset needed to land
 * the winner's card center exactly under the viewport's middle marker.
 */
function buildStrip(
  pool: RandomizerBuild[],
  winner: RandomizerBuild,
  spinId: number,
): { strip: RandomizerBuild[]; targetOffset: number } {
  const winnerIndexInPool = Math.max(
    0,
    pool.findIndex((b) => b.id === winner.id),
  );
  // Mix a per-spin pseudo-shuffle so the visual sequence varies.
  const shuffled = shuffleWithSeed(pool, spinId);
  const strip: RandomizerBuild[] = [];
  for (let r = 0; r < REPEATS; r += 1) strip.push(...shuffled);
  // Final landing slot — a few cards before the strip's end so the
  // deceleration has runway behind it.
  const landingIndex = (REPEATS - 1) * pool.length + winnerIndexInPool;
  strip[landingIndex] = winner;
  // Offset puts card[landingIndex] center exactly at viewport center.
  const targetOffset = landingIndex * STEP;
  return { strip, targetOffset };
}

function shuffleWithSeed(
  list: ReadonlyArray<RandomizerBuild>,
  seed: number,
): RandomizerBuild[] {
  const arr = [...list];
  let s = seed | 0;
  for (let i = arr.length - 1; i > 0; i -= 1) {
    s = (s * 1664525 + 1013904223) | 0;
    const j = Math.abs(s) % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
