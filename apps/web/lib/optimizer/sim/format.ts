/**
 * Build-order presentation helpers: "14 Pylon 0:24"-style step
 * stamping and plain-text export of a simulated build.
 */
import { formatBuildTime, humanizeBuildName } from "@/lib/build-events";
import type { BuildOrderStep, SimResult } from "../types";

export interface FormattedStep {
  supply: number;
  label: string;
  time: string;
  doneTime: string;
  kind: BuildOrderStep["kind"];
  name: string;
  startSec: number;
}

export function formatStep(step: BuildOrderStep): FormattedStep {
  return {
    supply: Math.floor(step.supply),
    label: humanizeBuildName(step.name),
    time: formatBuildTime(step.startSec),
    doneTime: formatBuildTime(step.doneSec),
    kind: step.kind,
    name: step.name,
    startSec: step.startSec,
  };
}

/**
 * Steps the player actually executes, in start order. Drops auto-fired
 * worker production so the list reads like a written build order
 * (worker production is implied "constant probes/SCVs/drones").
 */
export function displaySteps(
  result: SimResult,
  options: { includeWorkers?: boolean } = {},
): FormattedStep[] {
  const workerNames = new Set(["Probe", "SCV", "Drone"]);
  return result.steps
    .filter(
      (step) => options.includeWorkers || !workerNames.has(step.name),
    )
    .map(formatStep);
}

/** Plain-text build order, one step per line — clipboard export. */
export function buildOrderText(result: SimResult): string {
  return displaySteps(result)
    .map((s) => `${s.supply}  ${s.label}  ${s.time}`)
    .join("\n");
}
