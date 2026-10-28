"use client";

/**
 * RandomizerStage — picks the appropriate reveal animation for a spin
 * and renders it. Every style shares `RevealProps`, so swapping between
 * them is just a switch.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SpinOutcome } from "@/lib/randomizer/types";
import { BattleRoyaleReveal } from "./reveals/BattleRoyaleReveal";
import { CaseUnboxingReveal } from "./reveals/CaseUnboxingReveal";
import { GachaSummonReveal } from "./reveals/GachaSummonReveal";
import { rarityFor, RevealAnnouncementContext, RevealKeyframes } from "./reveals/revealShared";
import { SlotMachineReveal } from "./reveals/SlotMachineReveal";
import { WheelSpinReveal } from "./reveals/WheelSpinReveal";
import { FighterBrawlReveal } from "./reveals/FighterBrawlReveal";
import { HorseRaceReveal } from "./reveals/HorseRaceReveal";
import { SumoShoveReveal } from "./reveals/SumoShoveReveal";
import { AsteroidLockReveal } from "./reveals/AsteroidLockReveal";
import { HungrySwarmReveal } from "./reveals/HungrySwarmReveal";
import { ClawMachineReveal } from "./reveals/ClawMachineReveal";
import { buildMotionVisualField } from "./reveals/visualField";

const MOTION_STYLES: ReadonlySet<SpinOutcome["style"]> = new Set([
  "fighter", "race", "sumo", "asteroid", "swarm", "claw",
]);

export interface RandomizerStageProps {
  outcome: SpinOutcome;
  /** Bumped each spin so the reveal animation re-runs. */
  spinId: number;
  onComplete?: () => void;
}

export function RandomizerStage(props: RandomizerStageProps) {
  // Clear the live region before a new spin paints, including callers that
  // update spinId without remounting. Old reveal timers cannot resolve it.
  return <RandomizerStageRun key={props.spinId} {...props} />;
}

function RandomizerStageRun({
  outcome,
  spinId,
  onComplete,
}: RandomizerStageProps) {
  const [resolved, setResolved] = useState(false);
  const active = useRef(true), completed = useRef(false), onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  const handleComplete = useCallback(() => {
    if (!active.current || completed.current) return;
    completed.current = true;
    setResolved(true);
    onCompleteRef.current?.();
  }, []);
  const winnerIndex = Math.max(
    0,
    outcome.pool.findIndex((b) => b.id === outcome.winner.id),
  );
  const winnerProbability = outcome.probabilities[winnerIndex] ?? 0;
  const visualPool = useMemo(
    () => MOTION_STYLES.has(outcome.style)
      ? buildMotionVisualField(outcome.pool, outcome.winner, spinId)
      : undefined,
    [outcome.style, outcome.pool, outcome.winner, spinId],
  );
  const common = {
    pool: outcome.pool,
    visualPool,
    probabilities: outcome.probabilities,
    winner: outcome.winner,
    winnerProbability,
    spinId,
    matchupLabel: outcome.matchup,
    onComplete: handleComplete,
  } as const;

  return (
    <>
      <RevealKeyframes />
      {visualPool && visualPool.length < outcome.pool.length ? (
        <div role="note" style={{ fontSize: 11, color: "#aab2c3", textAlign: "center", marginBottom: 6 }}>
          {visualPool.length} of {outcome.pool.length} contenders shown · Winner drawn from the full eligible pool
        </div>
      ) : null}
      <RevealAnnouncementContext.Provider value={resolved
        ? `Build chosen: ${outcome.winner.name}, ${rarityFor(winnerProbability).label}, ${Number((winnerProbability * 100).toFixed(1))}% chance`
        : ""}>
        {renderReveal(outcome.style, common)}
      </RevealAnnouncementContext.Provider>
    </>
  );
}

function renderReveal(
  style: SpinOutcome["style"],
  common: React.ComponentProps<typeof CaseUnboxingReveal>,
) {
  switch (style) {
    case "case":
      return <CaseUnboxingReveal {...common} />;
    case "slot":
      return <SlotMachineReveal {...common} />;
    case "gacha":
      return <GachaSummonReveal {...common} />;
    case "battle":
      return <BattleRoyaleReveal {...common} />;
    case "wheel":
      return <WheelSpinReveal {...common} />;
    case "fighter":
      return <FighterBrawlReveal {...common} />;
    case "race":
      return <HorseRaceReveal {...common} />;
    case "sumo":
      return <SumoShoveReveal {...common} />;
    case "asteroid":
      return <AsteroidLockReveal {...common} />;
    case "swarm":
      return <HungrySwarmReveal {...common} />;
    case "claw":
      return <ClawMachineReveal {...common} />;
    default:
      return <WheelSpinReveal {...common} />;
  }
}
