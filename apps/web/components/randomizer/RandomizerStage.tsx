"use client";

/**
 * RandomizerStage — picks the appropriate reveal animation for a spin
 * and renders it. Every style shares `RevealProps`, so swapping between
 * them is just a switch.
 */
import type { SpinOutcome } from "@/lib/randomizer/types";
import { BattleRoyaleReveal } from "./reveals/BattleRoyaleReveal";
import { CaseUnboxingReveal } from "./reveals/CaseUnboxingReveal";
import { GachaSummonReveal } from "./reveals/GachaSummonReveal";
import { RevealKeyframes } from "./reveals/revealShared";
import { SlotMachineReveal } from "./reveals/SlotMachineReveal";
import { WheelSpinReveal } from "./reveals/WheelSpinReveal";
import { FighterBrawlReveal } from "./reveals/FighterBrawlReveal";
import { HorseRaceReveal } from "./reveals/HorseRaceReveal";
import { SumoShoveReveal } from "./reveals/SumoShoveReveal";
import { AsteroidLockReveal } from "./reveals/AsteroidLockReveal";
import { HungrySwarmReveal } from "./reveals/HungrySwarmReveal";
import { ClawMachineReveal } from "./reveals/ClawMachineReveal";

export interface RandomizerStageProps {
  outcome: SpinOutcome;
  /** Bumped each spin so the reveal animation re-runs. */
  spinId: number;
  onComplete?: () => void;
}

export function RandomizerStage({
  outcome,
  spinId,
  onComplete,
}: RandomizerStageProps) {
  const winnerIndex = Math.max(
    0,
    outcome.pool.findIndex((b) => b.id === outcome.winner.id),
  );
  const winnerProbability = outcome.probabilities[winnerIndex] ?? 0;
  const common = {
    pool: outcome.pool,
    probabilities: outcome.probabilities,
    winner: outcome.winner,
    winnerProbability,
    spinId,
    matchupLabel: outcome.matchup,
    onComplete,
  } as const;

  return (
    <>
      <RevealKeyframes />
      {renderReveal(outcome.style, common)}
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
