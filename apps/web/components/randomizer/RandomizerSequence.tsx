"use client";

/**
 * Coordinates the complete game-start randomizer as two clean acts:
 * build reveal -> readable winner hold -> full exit -> opening-unit reveal.
 *
 * The selected units already belong to the exact winning build in
 * `SpinOutcome`, so this component never re-rolls or guesses. Timer cleanup is
 * keyed to `spinId` so a new game cannot inherit a delayed transition from the
 * previous one.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { SpinOutcome } from "@/lib/randomizer/types";
import { RandomizerStage } from "@/components/randomizer/RandomizerStage";
import { UnitRandomizerStage } from "@/components/randomizer/UnitRandomizerStage";
import { useReducedMotion } from "@/components/randomizer/reveals/revealShared";

export const BUILD_RESULT_HOLD_MS = 1_100;
export const BUILD_EXIT_MS = 320;
export const BETWEEN_ACTS_MS = 160;
export const UNIT_RESULT_HOLD_MS = 1_400;
export const UNIT_EXIT_MS = 300;

type SequencePhase =
  | "build"
  | "build-exit"
  | "units"
  | "unit-exit"
  | "done";

export interface RandomizerSequenceProps {
  outcome: SpinOutcome;
  spinId: number;
  onComplete?: () => void;
}

export function RandomizerSequence({
  outcome,
  spinId,
  onComplete,
}: RandomizerSequenceProps) {
  // The run is keyed internally as well as by the production callers. This
  // guarantees a clean state/timer boundary for previews, tests, or future
  // callers that update `spinId` without remounting the surrounding widget.
  return (
    <RandomizerSequenceRun
      key={spinId}
      outcome={outcome}
      spinId={spinId}
      onComplete={onComplete}
    />
  );
}

function RandomizerSequenceRun({
  outcome,
  spinId,
  onComplete,
}: RandomizerSequenceProps) {
  const [phase, setPhase] = useState<SequencePhase>("build");
  const timersRef = useRef<Set<number>>(new Set());
  const buildCompleteRef = useRef(false);
  const unitsCompleteRef = useRef(false);
  const reducedMotion = useReducedMotion();

  const clearTimers = useCallback(() => {
    for (const timer of timersRef.current) window.clearTimeout(timer);
    timersRef.current.clear();
  }, []);

  const schedule = useCallback((callback: () => void, delayMs: number) => {
    const timer = window.setTimeout(() => {
      timersRef.current.delete(timer);
      callback();
    }, delayMs);
    timersRef.current.add(timer);
  }, []);

  // Cleanup only. Clearing on mount would race child reduced-motion effects,
  // which are allowed to complete synchronously in their first passive effect.
  useEffect(() => clearTimers, [clearTimers]);

  const handleBuildComplete = useCallback(() => {
    if (buildCompleteRef.current) return;
    buildCompleteRef.current = true;
    // A build without an eligible opening-unit config keeps the established
    // one-act behaviour and winner card instead of fading to an empty panel.
    if (!outcome.openingUnits) return;

    const hold = reducedMotion ? 700 : BUILD_RESULT_HOLD_MS;
    const exit = reducedMotion ? 0 : BUILD_EXIT_MS;
    const gap = reducedMotion ? 0 : BETWEEN_ACTS_MS;
    schedule(() => setPhase("build-exit"), hold);
    schedule(() => setPhase("units"), hold + exit + gap);
  }, [outcome.openingUnits, reducedMotion, schedule]);

  const handleUnitsComplete = useCallback(() => {
    if (unitsCompleteRef.current) return;
    unitsCompleteRef.current = true;
    const hold = reducedMotion ? 1_000 : UNIT_RESULT_HOLD_MS;
    const exit = reducedMotion ? 0 : UNIT_EXIT_MS;
    schedule(() => setPhase("unit-exit"), hold);
    schedule(() => {
      setPhase("done");
      onComplete?.();
    }, hold + exit);
  }, [onComplete, reducedMotion, schedule]);

  if (phase === "done") return null;

  const showBuild = phase === "build" || phase === "build-exit";
  const showUnits = phase === "units" || phase === "unit-exit";

  return (
    <div
      data-randomizer-phase={phase}
      style={{
        position: "relative",
        width: "100%",
        minHeight: 320,
        display: "grid",
        placeItems: "center",
        pointerEvents: "none",
      }}
    >
      {showBuild ? (
        <div
          style={{
            position: "relative",
            width: "100%",
            display: "grid",
            placeItems: "center",
            opacity: phase === "build-exit" ? 0 : 1,
            transform:
              phase === "build-exit" ? "translateY(-10px) scale(0.97)" : "none",
            filter: phase === "build-exit" ? "blur(3px)" : "none",
            transition: reducedMotion
              ? "none"
              : `opacity ${BUILD_EXIT_MS}ms ease, transform ${BUILD_EXIT_MS}ms ease, filter ${BUILD_EXIT_MS}ms ease`,
          }}
        >
          <RandomizerStage
            outcome={outcome}
            spinId={spinId}
            onComplete={handleBuildComplete}
          />
        </div>
      ) : null}

      {showUnits && outcome.openingUnits ? (
        <div
          style={{
            position: "relative",
            width: "100%",
            display: "grid",
            placeItems: "center",
            opacity: phase === "unit-exit" ? 0 : 1,
            transform:
              phase === "unit-exit" ? "translateY(-8px) scale(0.98)" : "none",
            transition: reducedMotion
              ? "none"
              : `opacity ${UNIT_EXIT_MS}ms ease, transform ${UNIT_EXIT_MS}ms ease`,
          }}
        >
          <UnitRandomizerStage
            outcome={outcome.openingUnits}
            spinId={spinId}
            matchupLabel={outcome.matchup}
            buildName={outcome.winner.name}
            onComplete={handleUnitsComplete}
          />
        </div>
      ) : null}
    </div>
  );
}
