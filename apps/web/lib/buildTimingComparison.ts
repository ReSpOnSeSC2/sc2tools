import type { GameIntentState } from "./buildIntent";
import type { BuildEventRow } from "./build-events";
import type { DossierAnalysis } from "./dossierTypes";
import { visibleDossierTimings, timingDisplay } from "./dossierTimings";

export type OwnTimingContext = { path: string; matchup: string };
export type OwnTimingDelta = { label: string; title: string };
const race = (value: unknown) => typeof value === "string" ? ({ p: "P", protoss: "P", t: "T", terran: "T", z: "Z", zerg: "Z" } as Record<string, string>)[value.toLowerCase()] : undefined;
const safeText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
const tokenKey = (name: string) => name.replace(/[^a-z0-9]/gi, "").toLowerCase();

/** A loaded exact owner intent supplies custom identity; never guess by name. */
export function ownTimingContext(state: GameIntentState | undefined, gameId: string, myRace: unknown, oppRace: unknown, revision: number): OwnTimingContext | undefined {
  const my = race(myRace), opp = race(oppRace);
  if (!state || String(state.gameId) !== gameId || !my || !opp) return undefined;
  const declared = state.status === "confirmed" && state.applied && state.build ? state.build : null;
  if (declared?.deleted) return undefined;
  const ref = declared ?? state.detected;
  if (!ref || !safeText(ref.name) || !safeText(ref.key)) return undefined;
  const custom = declared ? declared.source === "custom" : !!ref.slug;
  if (custom && (!safeText(ref.slug) || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(ref.slug))) return undefined;
  const path = custom ? `/v1/custom-builds/${encodeURIComponent(ref.slug!)}/matches` : `/v1/builds/${encodeURIComponent(ref.name)}`;
  return { path: `${path}#${Math.max(0, Math.floor(revision) || 0)}`, matchup: `${my}v${opp}` };
}

/** DNA rows are first building occurrences. A later repeat must never inherit
 * that baseline, and opponent events never enter this owner-only mapping. */
export function ownTimingDeltas(rows: BuildEventRow[], data: DossierAnalysis | undefined, matchup: string): Map<string, OwnTimingDelta> {
  const deltas = new Map<string, OwnTimingDelta>();
  if (!data || !/^[PTZ]v[PTZ]$/.test(matchup)) return deltas;
  const timings = new Map(visibleDossierTimings(data, matchup, "build_log").map(item => [tokenKey(item.token), item]));
  const seen = new Set<string>();
  for (const row of [...rows].sort((a, b) => a.time - b.time)) {
    const key = tokenKey(row.iconName || row.rawName);
    if (seen.has(key) || row.category !== "building" || !Number.isFinite(row.time) || row.time < 0) continue;
    seen.add(key);
    const item = timings.get(key);
    if (!item) continue;
    const raw = row.time - item.median, delta = Math.abs(raw) < 1 ? 0 : Math.round(raw);
    deltas.set(row.key, { label: delta === 0 ? "Same as your median" : `${delta > 0 ? "+" : "−"}${Math.abs(delta)}s vs your median`,
      title: `${row.displayName}: ${timingDisplay(row.time)} this game; your ${matchup} median ${timingDisplay(item.median)} from ${item.n} recorded timing observations. First construction start only; differences do not explain the result.` });
  }
  return deltas;
}
