"use client";

import { useCallback, useState } from "react";
import { Card } from "@/components/ui/Card";
import {
  METRIC_LABELS,
  type MetricKey,
  type PhaseName,
} from "./shared/snapshotTypes";

// Phase-aware weight sliders with locked-sum-to-1.0 redistribution.
// Moving one slider redistributes the remaining budget across the
// other metrics proportionally. Three preset buttons (Default,
// Economy-heavy, Combat-heavy) + Custom (live edits).

const PHASES: PhaseName[] = ["early", "mid", "late"];
const METRICS: MetricKey[] = [
  "army_value",
  "army_supply",
  "workers",
  "bases",
  "production_capacity",
  "income_min",
  "income_gas",
  "tech_tier_reached",
  "tech_path_winrate",
  "composition_matchup",
];

export type PresetName = "default" | "economy_heavy" | "combat_heavy" | "custom";

export interface WeightsByPhase {
  early: Record<MetricKey, number>;
  mid: Record<MetricKey, number>;
  late: Record<MetricKey, number>;
}

export interface WeightSliderGroupProps {
  defaultWeights: WeightsByPhase;
  value: WeightsByPhase | null;
  onChange: (value: WeightsByPhase, preset: PresetName) => void;
  preset: PresetName;
}

export function WeightSliderGroup({
  defaultWeights,
  value,
  onChange,
  preset,
}: WeightSliderGroupProps) {
  const [phase, setPhase] = useState<PhaseName>("mid");
  const active = value || defaultWeights;

  const setMetric = useCallback(
    (metric: MetricKey, next: number) => {
      const updated = rebalance(active[phase], metric, next);
      const nextAll = { ...active, [phase]: updated };
      onChange(nextAll, "custom");
    },
    [active, phase, onChange],
  );

  const applyPreset = useCallback(
    (name: PresetName) => {
      if (name === "default") {
        onChange(defaultWeights, "default");
      } else if (name === "economy_heavy") {
        onChange(applyDelta(defaultWeights, { workers: 0.05, bases: 0.05, army_value: -0.1 }), "economy_heavy");
      } else if (name === "combat_heavy") {
        onChange(applyDelta(defaultWeights, { army_value: 0.05, composition_matchup: 0.05, workers: -0.1 }), "combat_heavy");
      }
    },
    [defaultWeights, onChange],
  );

  return (
    <Card title="Scoring weights">
      <Card.Body>
        <PresetButtons preset={preset} onPick={applyPreset} />
        <PhaseTabs phase={phase} onChange={setPhase} />
        <ul className="mt-3 space-y-2">
          {METRICS.map((m) => {
            const w = active[phase][m] ?? 0;
            return (
              <li key={m}>
                <div className="flex items-baseline justify-between text-caption">
                  <span className="text-text">{METRIC_LABELS[m]}</span>
                  <span className="tabular-nums text-text-muted">
                    {(w * 100).toFixed(1)}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.005}
                  value={w}
                  onChange={(e) => setMetric(m, Number(e.target.value))}
                  aria-label={`${METRIC_LABELS[m]} weight for ${phase} phase`}
                  className="w-full"
                />
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-[11px] text-text-dim">
          Sliders are locked to a sum of 100%. Moving one redistributes
          the rest proportionally.
        </p>
      </Card.Body>
    </Card>
  );
}

function PresetButtons({
  preset,
  onPick,
}: {
  preset: PresetName;
  onPick: (name: PresetName) => void;
}) {
  const presets: PresetName[] = ["default", "economy_heavy", "combat_heavy", "custom"];
  return (
    <div className="mb-3 flex flex-wrap gap-1.5">
      {presets.map((p) => (
        <button
          key={p}
          type="button"
          aria-pressed={preset === p}
          disabled={p === "custom" && preset !== "custom"}
          onClick={() => onPick(p)}
          className={[
            "rounded-md border px-2.5 py-1 text-[11px] font-medium capitalize",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
            preset === p
              ? "border-accent bg-accent/10 text-accent"
              : "border-border text-text-muted hover:text-text",
          ].join(" ")}
        >
          {p.replace("_", " ")}
        </button>
      ))}
    </div>
  );
}

function PhaseTabs({
  phase,
  onChange,
}: {
  phase: PhaseName;
  onChange: (p: PhaseName) => void;
}) {
  return (
    <div className="flex gap-1 rounded-lg border border-border bg-bg-elevated p-0.5">
      {PHASES.map((p) => (
        <button
          key={p}
          type="button"
          aria-pressed={phase === p}
          onClick={() => onChange(p)}
          className={[
            "flex-1 rounded-md px-2 py-1.5 text-[11px] font-medium capitalize",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
            phase === p
              ? "bg-accent text-white"
              : "text-text-muted hover:text-text",
          ].join(" ")}
        >
          {p}
        </button>
      ))}
    </div>
  );
}

/** Rebalance so the sum still totals 1.0 when one slider moves. */
function rebalance(
  weights: Record<MetricKey, number>,
  changed: MetricKey,
  next: number,
): Record<MetricKey, number> {
  const clamped = Math.max(0, Math.min(1, next));
  const others = METRICS.filter((m) => m !== changed);
  const restBudget = 1 - clamped;
  const restSum = others.reduce((s, m) => s + (weights[m] ?? 0), 0);
  /** @type {Record<MetricKey, number>} */
  const out = { ...weights };
  out[changed] = clamped;
  if (restSum <= 0) {
    const share = restBudget / others.length;
    for (const m of others) out[m] = share;
    return out;
  }
  for (const m of others) {
    out[m] = ((weights[m] ?? 0) / restSum) * restBudget;
  }
  return out;
}

function applyDelta(base: WeightsByPhase, delta: Partial<Record<MetricKey, number>>): WeightsByPhase {
  /** @type {WeightsByPhase} */
  const out = { early: { ...base.early }, mid: { ...base.mid }, late: { ...base.late } };
  for (const phase of PHASES) {
    const w = { ...base[phase] };
    for (const [k, v] of Object.entries(delta) as Array<[MetricKey, number]>) {
      w[k] = Math.max(0, (w[k] ?? 0) + v);
    }
    const total = METRICS.reduce((s, m) => s + (w[m] ?? 0), 0);
    if (total > 0) for (const m of METRICS) w[m] = (w[m] ?? 0) / total;
    out[phase] = w as Record<MetricKey, number>;
  }
  return out;
}

export { rebalance, applyDelta };
