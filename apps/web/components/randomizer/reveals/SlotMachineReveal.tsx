"use client";

/**
 * 3-reel slot machine reveal — race icon · build name · build name. The
 * outer two reels are decorative race glyphs; the middle reel locks
 * onto the winning build name. Reels stop sequentially for that classic
 * jackpot rhythm.
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

const REEL_W = 150;
const REEL_H = 64;
const ITEM_H = REEL_H;
const SPIN_TURNS = 24;
const REEL_DURATIONS = [2400, 3000, 3700];
const TOTAL_MS = REEL_DURATIONS[REEL_DURATIONS.length - 1] + 200;

export function SlotMachineReveal({
  pool,
  winner,
  winnerProbability,
  spinId,
  matchupLabel,
  onComplete,
}: RevealProps) {
  const reducedMotion = useReducedMotion();
  const started = useRevealStart(spinId, reducedMotion);
  const settled = useRevealTimer(spinId, TOTAL_MS, reducedMotion, onComplete);
  const rarity = rarityFor(winnerProbability);

  const reels = useMemo(
    () => buildReels(pool, winner, spinId),
    [pool, winner, spinId],
  );

  return (
    <RevealFrame>
      <MatchupPill label={matchupLabel} />
      <div
        style={{
          display: "flex",
          gap: 8,
          padding: 12,
          borderRadius: 16,
          background:
            "linear-gradient(180deg, rgba(11,13,18,0.95) 0%, rgba(22,26,35,0.95) 100%)",
          border: `2px solid ${rarity.color}66`,
          boxShadow: `0 10px 30px rgba(0,0,0,0.55), 0 0 22px ${rarity.glow}`,
        }}
      >
        {reels.map((reel, idx) => (
          <Reel
            key={`${spinId}-${idx}`}
            items={reel.items}
            stopIndex={reel.stopIndex}
            kind={idx === 1 ? "name" : "race"}
            duration={REEL_DURATIONS[idx]}
            reducedMotion={reducedMotion}
            started={started}
            settled={settled}
          />
        ))}
      </div>
      <WinnerCard winner={winner} rarity={rarity} show={settled} />
    </RevealFrame>
  );
}

interface ReelData {
  items: RandomizerBuild[];
  stopIndex: number;
}

function buildReels(
  pool: RandomizerBuild[],
  winner: RandomizerBuild,
  spinId: number,
): ReelData[] {
  return [0, 1, 2].map((reelIdx) => {
    const items: RandomizerBuild[] = [];
    for (let r = 0; r < SPIN_TURNS; r += 1) {
      for (const b of pool) items.push(b);
    }
    // Middle reel lands the actual winner — side reels can land any
    // build (still drawn from the same pool so race icons make sense).
    const sideTarget =
      pool[(spinId + reelIdx + 1) % pool.length] ?? winner;
    const target = reelIdx === 1 ? winner : sideTarget;
    const stopIndex = items.length - pool.length + Math.max(
      0,
      pool.findIndex((b) => b.id === target.id),
    );
    items[stopIndex] = target;
    return { items, stopIndex };
  });
}

function Reel({
  items,
  stopIndex,
  kind,
  duration,
  reducedMotion,
  started,
  settled,
}: {
  items: RandomizerBuild[];
  stopIndex: number;
  kind: "race" | "name";
  duration: number;
  reducedMotion: boolean;
  started: boolean;
  settled: boolean;
}) {
  const targetY = stopIndex * ITEM_H;
  // Each reel scrolls toward its stop the moment it mounts (`started`)
  // over its own duration, so the reels visibly lock in sequence.
  const y = started ? targetY : 0;
  return (
    <div
      style={{
        position: "relative",
        width: REEL_W,
        height: REEL_H,
        overflow: "hidden",
        borderRadius: 10,
        background:
          "linear-gradient(180deg, rgba(28,32,42,0.96) 0%, rgba(16,18,26,0.96) 100%)",
        border: "1px solid rgba(255,255,255,0.06)",
        boxShadow:
          "inset 0 6px 14px rgba(0,0,0,0.55), inset 0 -6px 14px rgba(0,0,0,0.55)",
      }}
    >
      <div
        style={{
          transform: `translateY(${-y}px)`,
          transition: reducedMotion
            ? "none"
            : `transform ${duration}ms cubic-bezier(.14,.7,.2,1)`,
          willChange: "transform",
        }}
      >
        {items.map((b, i) => (
          <ReelCell key={`${b.id}-${i}`} build={b} kind={kind} />
        ))}
      </div>
      {/* Lock indicator that lights up when the reel stops. */}
      <span
        aria-hidden
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: "100%",
          height: "100%",
          border: settled ? "2px solid #e6b450" : "2px solid transparent",
          borderRadius: 10,
          pointerEvents: "none",
          transition: "border-color 220ms ease",
        }}
      />
    </div>
  );
}

function ReelCell({
  build,
  kind,
}: {
  build: RandomizerBuild;
  kind: "race" | "name";
}) {
  const accent = raceHex(build.race);
  if (kind === "race") {
    return (
      <div
        style={{
          height: ITEM_H,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
        }}
      >
        <RaceIcon race={build.race} size={28} />
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: accent,
          }}
        >
          {build.race[0]}
        </span>
      </div>
    );
  }
  return (
    <div
      style={{
        height: ITEM_H,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "0 10px",
        fontSize: 12,
        fontWeight: 700,
        textAlign: "center",
        lineHeight: 1.2,
        color: "#e6e8ee",
      }}
    >
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
        }}
      >
        {build.name}
      </span>
    </div>
  );
}
