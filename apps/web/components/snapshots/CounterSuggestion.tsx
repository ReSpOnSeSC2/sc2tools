"use client";

import { Card } from "@/components/ui/Card";
import type { CounterSuggestion } from "./shared/snapshotTypes";

// "Build X to switch to Y comp, raises winrate to Z%."
// Surfaces the top counter-suggestions for the focal cell of the
// composition matrix. Includes a "you'd need" callout with the
// per-unit additions / removals (race-validated upstream so we
// never suggest impossible additions like Hatchery for a Protoss).

export interface CounterSuggestionProps {
  suggestions: CounterSuggestion[];
  currentWinRate?: number;
}

export function CounterSuggestionList({
  suggestions,
  currentWinRate,
}: CounterSuggestionProps) {
  if (!suggestions || suggestions.length === 0) {
    return (
      <Card title="Counter suggestions">
        <p className="py-3 text-center text-caption text-text-dim">
          Your current composition is already competitive against this opponent.
        </p>
      </Card>
    );
  }

  return (
    <Card title="Counter suggestions">
      <ul className="space-y-3" role="list">
        {suggestions.slice(0, 2).map((sug, idx) => (
          <SuggestionRow key={idx} sug={sug} currentWinRate={currentWinRate} />
        ))}
      </ul>
    </Card>
  );
}

function SuggestionRow({
  sug,
  currentWinRate,
}: {
  sug: CounterSuggestion;
  currentWinRate?: number;
}) {
  const isComposition = sug.strategy === "switch_composition";
  const projected = Math.round(sug.projectedWinRate * 100);
  const delta =
    typeof currentWinRate === "number"
      ? Math.round((sug.projectedWinRate - currentWinRate) * 100)
      : null;
  return (
    <li className="rounded-lg border border-border bg-bg-elevated/60 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-caption font-semibold text-text">
          {isComposition ? "Switch composition" : "Switch tech path"}
        </span>
        <span className="text-caption font-semibold text-success tabular-nums">
          {projected}% wins
          {delta !== null ? (
            <span className="ml-1 text-text-dim font-normal">
              ({delta > 0 ? "+" : ""}
              {delta}% vs current)
            </span>
          ) : null}
        </span>
      </div>
      <p className="mt-1 text-[12px] text-text-muted">
        To{" "}
        <span className="font-semibold text-text">
          {isComposition ? sug.targetClusterLabel : sug.targetPathLabel}
        </span>
        {sug.sampleSize ? ` (${sug.sampleSize} cohort games)` : ""}
      </p>
      <Needs sug={sug} />
      {sug.feasibility || sug.feasibilityNote ? (
        <p className="mt-1 text-[11px] italic text-text-dim">
          {sug.feasibility || sug.feasibilityNote}
        </p>
      ) : null}
    </li>
  );
}

function Needs({ sug }: { sug: CounterSuggestion }) {
  const parts: string[] = [];
  if (sug.unitsToAdd) {
    for (const [u, n] of Object.entries(sug.unitsToAdd)) {
      parts.push(`+${n} ${u}`);
    }
  }
  if (sug.unitsToRemove) {
    for (const [u, n] of Object.entries(sug.unitsToRemove)) {
      parts.push(`-${n} ${u}`);
    }
  }
  if (sug.buildingsToAdd) {
    for (const b of sug.buildingsToAdd) parts.push(`+${b}`);
  }
  if (parts.length === 0) return null;
  return (
    <p className="mt-1 text-[12px] text-text">
      <span className="text-text-dim">You'd need: </span>
      {parts.join(", ")}
    </p>
  );
}
