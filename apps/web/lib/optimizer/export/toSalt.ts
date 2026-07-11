/**
 * Adapt an optimizer result into a SALT practice string.
 *
 * The adapted sim's step list carries exactly what SALT encodes
 * (supply stamp, start second, action kind, canonical name), so the
 * optimizer's output becomes practicable in-game via the Salt / Build
 * Order Trainer custom maps — the bridge Spawning Tool users expect.
 */

import { encodeSaltDetailed } from "@/lib/salt";
import type { SaltStep } from "@/lib/salt";
import type { AdaptResult, BuildOrderStep } from "@/lib/optimizer/types";

const KIND_MAP: Record<string, SaltStep["kind"] | null> = {
  build: "structure",
  train: "unit",
  research: "upgrade",
  morph: "morph",
  // Chrono/inject-style macro actions have no SALT representation.
  chrono: null,
};

/** @returns null for steps SALT cannot express (macro abilities). */
function toSaltStep(step: BuildOrderStep): SaltStep | null {
  const kind = KIND_MAP[step.kind] ?? null;
  if (!kind) return null;
  return {
    supply: step.supply,
    timeSec: step.startSec,
    kind,
    name: step.name,
  };
}

export function saltFromAdaptResult(result: AdaptResult): {
  salt: string;
  skipped: string[];
} {
  const steps: SaltStep[] = [];
  const skippedKinds: string[] = [];
  for (const step of result.sim.steps) {
    const converted = toSaltStep(step);
    if (converted) steps.push(converted);
    else if (step.kind === "chrono") skippedKinds.push(step.name);
  }
  const { salt, skipped } = encodeSaltDetailed(
    `${result.referenceName} (${result.profileId})`,
    steps,
    { author: "sc2tools.com" },
  );
  return { salt, skipped: [...skipped, ...skippedKinds.map((n) => `chrono:${n}`)] };
}
