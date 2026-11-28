"use client";

/**
 * Coordinates one game's randomizer draw as up to two clean acts:
 * build reveal -> readable winner hold -> full exit -> opening-unit reveal.
 * A draw without a build opens on the unit reveal; one without units keeps
 * the build's winner card.
 *
 * The selected units already belong to the draw in `GameDraw`, so this
 * component never re-rolls or guesses. Timer cleanup is keyed to `spinId`
 * so a new game cannot inherit a delayed transition from the previous one.
 * The unit reveal loads on demand (`loadUnitStage`) to keep the overlay's
 * first load small; the widget warms it while a game is pending.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import dynamic from "next/dynamic";
import type { GameDraw } from "@/lib/randomizer/types";
import { RandomizerStage } from "@/components/randomizer/RandomizerStage";
import { useReducedMotion } from "@/components/randomizer/reveals/revealShared";
import { UNIT_STAGE_HEIGHT } from "@/components/randomizer/unit-reveals/unitStageSize";

export const BUILD_RESULT_HOLD_MS = 1_100;
export const BUILD_EXIT_MS = 320;
export const BETWEEN_ACTS_MS = 160;
export const UNIT_RESULT_HOLD_MS = 1_400;
export const UNIT_EXIT_MS = 300;
/** The height a build reveal alone keeps. */
const BUILD_STAGE_MIN_HEIGHT = 320;

type SequencePhase =
  | "build"
  | "build-exit"
  | "units"
  | "unit-exit"
  | "done";

/** The unit reveal's code. Starting it early makes the reveal instant. */
export function loadUnitStage() {
  return import("@/components/randomizer/UnitRandomizerStage");
}

const UnitRandomizerStage = dynamic(
  () => loadUnitStage().then((module) => module.UnitRandomizerStage),
  // The frame's own height, held while its code loads so nothing jumps.
  { ssr: false, loading: () => <div aria-hidden data-unit-stage-placeholder style={{ minHeight: UNIT_STAGE_HEIGHT }} /> },
);

export interface RandomizerSequenceProps {
  draw: GameDraw;
  spinId: number;
  onComplete?: () => void;
}

export function RandomizerSequence({
  draw,
  spinId,
  onComplete,
}: RandomizerSequenceProps) {
  // The run is keyed internally as well as by the production callers. This
  // guarantees a clean state/timer boundary for previews, tests, or future
  // callers that update `spinId` without remounting the surrounding widget.
  return (
    <RandomizerSequenceRun
      key={spinId}
      draw={draw}
      spinId={spinId}
      onComplete={onComplete}
    />
  );
}

function RandomizerSequenceRun({
  draw,
  spinId,
  onComplete,
}: RandomizerSequenceProps) {
  const [phase, setPhase] = useState<SequencePhase>(draw.build ? "build" : "units");
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
    // A draw without units keeps the established one-act behaviour and
    // winner card instead of fading to an empty panel.
    if (!draw.units) return;

    const hold = reducedMotion ? 700 : BUILD_RESULT_HOLD_MS;
    const exit = reducedMotion ? 0 : BUILD_EXIT_MS;
    const gap = reducedMotion ? 0 : BETWEEN_ACTS_MS;
    schedule(() => setPhase("build-exit"), hold);
    schedule(() => setPhase("units"), hold + exit + gap);
  }, [draw.units, reducedMotion, schedule]);

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

  const build = phase === "build" || phase === "build-exit" ? draw.build : null;
  const units = phase === "units" || phase === "unit-exit" ? draw.units : null;

  return (
    <div
      data-randomizer-phase={phase}
      style={{
        position: "relative",
        width: "100%",
        // A draw with units keeps the unit frame's height from its first act.
        minHeight: draw.units ? UNIT_STAGE_HEIGHT : BUILD_STAGE_MIN_HEIGHT,
        display: "grid",
        placeItems: "center",
        pointerEvents: "none",
      }}
    >
      {build ? (
        <div style={actStyle(phase === "build-exit", reducedMotion, BUILD_EXIT_MS, "translateY(-10px) scale(0.97)", true)}>
          <RandomizerStage
            outcome={build}
            spinId={spinId}
            onComplete={handleBuildComplete}
          />
        </div>
      ) : null}

      {units ? (
        <div style={actStyle(phase === "unit-exit", reducedMotion, UNIT_EXIT_MS, "translateY(-8px) scale(0.98)", false)}>
          <UnitRandomizerStage
            outcome={units}
            spinId={spinId}
            matchupLabel={draw.matchup}
            buildName={draw.build?.winner.name ?? null}
            onComplete={handleUnitsComplete}
          />
        </div>
      ) : null}
    </div>
  );
}

/** One act's wrapper: it fades, lifts and (for the build) blurs out. */
function actStyle(
  exiting: boolean,
  reducedMotion: boolean,
  exitMs: number,
  exitTransform: string,
  blur: boolean,
): CSSProperties {
  const blurTransition = blur ? `, filter ${exitMs}ms ease` : "";
  return {
    position: "relative",
    width: "100%",
    display: "grid",
    placeItems: "center",
    opacity: exiting ? 0 : 1,
    transform: exiting ? exitTransform : "none",
    ...(blur ? { filter: exiting ? "blur(3px)" : "none" } : {}),
    transition: reducedMotion
      ? "none"
      : `opacity ${exitMs}ms ease, transform ${exitMs}ms ease${blurTransition}`,
  };
}
