"use client";

/** Dispatches the preselected opening-unit outcome to one of three gamey UIs. */
import type { OpeningUnitsOutcome } from "@/lib/randomizer/types";
import { HoloDraftReveal } from "./unit-reveals/HoloDraftReveal";
import { PowerSurgeReveal } from "./unit-reveals/PowerSurgeReveal";
import { WarpGateChambersReveal } from "./unit-reveals/WarpGateChambersReveal";
import {
  UnitRevealKeyframes,
  type UnitRevealProps,
} from "./unit-reveals/unitRevealShared";

export interface UnitRandomizerStageProps {
  outcome: OpeningUnitsOutcome;
  spinId: number;
  matchupLabel: string;
  buildName: string;
  onComplete?: () => void;
}

export function UnitRandomizerStage(props: UnitRandomizerStageProps) {
  const common: UnitRevealProps = props;
  return (
    <>
      <UnitRevealKeyframes />
      {renderUnitReveal(props.outcome.style, common)}
    </>
  );
}

function renderUnitReveal(
  style: OpeningUnitsOutcome["style"],
  props: UnitRevealProps,
) {
  switch (style) {
    case "warp-gate":
      return <WarpGateChambersReveal {...props} />;
    case "psi-draft":
      return <HoloDraftReveal {...props} />;
    case "power-surge":
      return <PowerSurgeReveal {...props} />;
    default:
      return <WarpGateChambersReveal {...props} />;
  }
}
