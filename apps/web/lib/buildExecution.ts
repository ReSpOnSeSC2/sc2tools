import type { PracticeSource } from "./practiceAssignment";
import type { BuildEventRow } from "./build-events";
import type { OwnTimingDelta } from "./buildTimingComparison";

export type ExecutionRule = { index: number; name: string; type: string; sentence: string; pass: boolean; unavailable: boolean;
  got: number | null; need: number | null; evidenceSec: number | null; deadlineSec: number | null; evidenceKind: "event" | "deadline" | null };
export type ExecutionTiming = { token: string; displayName: string; kind: "natural" | "first_gas" | "first_tech" | "building";
  thisGameSec: number; medianSec: number | null; p25Sec: number | null; p75Sec: number | null; n: number; deltaSec: number | null };
export type BuildExecution = { build: (PracticeSource & { source: "custom" | "catalog"; deleted?: boolean }) | null;
  source: "confirmed" | "detected" | "none"; matchup: string | null; rules: ExecutionRule[];
  passedCount: number; knownCount: number; ruleCount: number; matchPct: number | null;
  timings: ExecutionTiming[]; timingMinSample: number; timingSampleSelected: number; timingSampleGames: number; timingSampleLimit: number;
  unavailable?: "no_build" | "definition_missing" | "log_missing" | "resumed" };

/** This exact normalized resource feeds the card, clock rail and timeline.
 * An unavailable/failed/previous response never supplies a percentage. */
export function checkedMatchPercentage(data: BuildExecution | undefined): number | null {
  return data && !data.unavailable && data.ruleCount > 0 && data.knownCount === data.ruleCount
    && Number.isFinite(data.matchPct) && data.matchPct! >= 0 && data.matchPct! <= 100 ? data.matchPct : null;
}
const tokenKey = (value: string) => value.replace(/[^a-z0-9]/gi, "").toLowerCase();
/** Match the observed start itself, including the second town hall (natural).
 * Repeated later buildings and opponent events cannot acquire that delta. */
export function executionTimingDeltas(rows: BuildEventRow[], timings?: ExecutionTiming[], matchup?: string | null): Map<string, OwnTimingDelta> {
  const out = new Map<string, OwnTimingDelta>(), used = new Set<string>();
  if (!/^[PTZ]v[PTZ]$/.test(matchup || "")) return out;
  for (const row of [...rows].sort((a, b) => a.time - b.time)) {
    if (row.category !== "building") continue;
    const key = tokenKey(row.iconName || row.rawName);
    const value = timings?.find(item => tokenKey(item.token) === key && Math.abs(item.thisGameSec - row.time) < 1);
    if (!value || used.has(key) || value.n < 3 || typeof value.medianSec !== "number" || typeof value.deltaSec !== "number" || !Number.isFinite(value.deltaSec)) continue;
    used.add(key);
    const delta = Math.abs(value.deltaSec) < 1 ? 0 : Math.round(value.deltaSec);
    out.set(row.key, { label: delta === 0 ? "Same as your median" : `${delta > 0 ? "+" : "−"}${Math.abs(delta)}s vs your median`,
      title: `${row.displayName}: construction start compared with your ${matchup} median from ${value.n} recorded timing observations. Differences do not explain the result.` });
  }
  return out;
}
