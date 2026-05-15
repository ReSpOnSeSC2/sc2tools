"use client";

import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card } from "@/components/ui/Card";
import { AXIS_LINE, GRID_LINE } from "./shared/colorScales";
import {
  fmtTick,
  type CohortTick,
  type GameTick,
} from "./shared/snapshotTypes";

// Stacked-area composition chart. Two view modes:
//   - "mine": this game's per-tick unit counts (stacked).
//   - "cohort": the cohort's winner-median composition.
// Each unit gets a stable hue (hash-based); top 8 units are
// stacked, the rest collapse into a single "Other" stripe so the
// legend stays readable.

const UNIT_PALETTE = [
  "#7c8cff",
  "#3ec0c7",
  "#fbbf24",
  "#22c55e",
  "#ef4444",
  "#a78bfa",
  "#3ec07a",
  "#e6b450",
];

export interface CompositionStackChartProps {
  cohort: CohortTick[];
  gameTicks: GameTick[];
  side: "my" | "opp";
}

export function CompositionStackChart({
  cohort,
  gameTicks,
  side,
}: CompositionStackChartProps) {
  const [mode, setMode] = useState<"mine" | "cohort">("mine");
  const { rows, topUnits } = useMemo(
    () => buildChartData(cohort, gameTicks, side, mode),
    [cohort, gameTicks, side, mode],
  );

  return (
    <Card>
      <Card.Header>
        <h3 className="text-caption font-semibold text-text">
          Composition over time — {side === "my" ? "you" : "opponent"}
        </h3>
        <div className="flex gap-1 rounded-md border border-border bg-bg-elevated p-0.5">
          {(["mine", "cohort"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={[
                "rounded px-2 py-1 text-[11px] font-medium capitalize",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                mode === m ? "bg-accent text-white" : "text-text-muted hover:text-text",
              ].join(" ")}
            >
              {m === "mine" ? "Your deck" : "Cohort winners"}
            </button>
          ))}
        </div>
      </Card.Header>
      <Card.Body>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={rows} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_LINE} />
              <XAxis
                dataKey="t"
                type="number"
                domain={[0, 1200]}
                ticks={[0, 180, 360, 540, 720, 900, 1080]}
                tickFormatter={(v: number) => fmtTick(v)}
                stroke={AXIS_LINE}
                fontSize={11}
              />
              <YAxis stroke={AXIS_LINE} fontSize={11} allowDecimals={false} />
              <Tooltip
                contentStyle={{
                  background: "#11141b",
                  border: "1px solid #1f2533",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelFormatter={(v) => fmtTick(Number(v))}
              />
              {topUnits.map((unit, i) => (
                <Area
                  key={unit}
                  type="monotone"
                  dataKey={unit}
                  stackId="comp"
                  stroke={UNIT_PALETTE[i % UNIT_PALETTE.length]}
                  fill={UNIT_PALETTE[i % UNIT_PALETTE.length]}
                  fillOpacity={0.7}
                  isAnimationActive={false}
                />
              ))}
              <Area
                type="monotone"
                dataKey="Other"
                stackId="comp"
                stroke="#3a4252"
                fill="#3a4252"
                fillOpacity={0.5}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
          {topUnits.map((u, i) => (
            <span key={u} className="inline-flex items-center gap-1">
              <span
                aria-hidden
                className="inline-block h-2 w-2 rounded-sm"
                style={{ background: UNIT_PALETTE[i % UNIT_PALETTE.length] }}
              />
              <span className="text-text-muted">{u}</span>
            </span>
          ))}
        </div>
      </Card.Body>
    </Card>
  );
}

function buildChartData(
  cohort: CohortTick[],
  gameTicks: GameTick[],
  side: "my" | "opp",
  mode: "mine" | "cohort",
) {
  const unitTotals = new Map<string, number>();
  const allRows: Array<Record<string, number>> = [];
  for (const cohortRow of cohort) {
    const t = cohortRow.t;
    let units: Record<string, number> = {};
    if (mode === "cohort") {
      units = cohortRow.composition?.[side]?.winnerCentroid || {};
    } else {
      const g = gameTicks.find((x) => x.t === t);
      const arr = g?.compositionDelta?.[side] || [];
      for (const r of arr) units[r.unit] = r.mine;
    }
    const row: Record<string, number> = { t };
    for (const [unit, count] of Object.entries(units)) {
      const v = Number(count);
      if (!Number.isFinite(v) || v <= 0) continue;
      row[unit] = Math.round(v);
      unitTotals.set(unit, (unitTotals.get(unit) || 0) + v);
    }
    allRows.push(row);
  }
  const topUnits = Array.from(unitTotals.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([u]) => u);
  const topSet = new Set(topUnits);
  const rows = allRows.map((row) => {
    let other = 0;
    const out: Record<string, number> = { t: row.t };
    for (const [k, v] of Object.entries(row)) {
      if (k === "t") continue;
      if (topSet.has(k)) out[k] = v;
      else other += v;
    }
    if (other > 0) out.Other = Math.round(other);
    return out;
  });
  return { rows, topUnits };
}
