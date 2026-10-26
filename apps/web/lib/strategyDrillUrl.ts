import type { StrategyDrillFilter } from "./strategyDrill";
const label = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
export function serializeStrategyDrill(drill: StrategyDrillFilter | null): string | null {
  if (!drill) return null;
  if (!drill.build) return label(drill.opp_strategy) ? `strategy:${drill.opp_strategy}` : null;
  if (!label(drill.build)) return null;
  if (!drill.opp_strategy) return `build:${drill.build}`;
  if (!label(drill.opp_strategy)) return null;
  return `build:${JSON.stringify({ build: drill.build, strategy: drill.opp_strategy, ...(drill.opp_race ? { race: drill.opp_race } : {}) })}`;
}
export function parseStrategyDrill(raw: string | null): StrategyDrillFilter | null {
  if (!raw || raw.length > 1600) return null;
  if (raw.startsWith("strategy:")) { const name = raw.slice(9); return label(name) ? { opp_strategy: name } : null; }
  if (!raw.startsWith("build:")) return null;
  const name = raw.slice(6);
  if (!name.startsWith("{")) return label(name) ? { build: name, opp_strategy: "" } : null;
  try {
    const value = JSON.parse(name);
    if (!value || Array.isArray(value) || Object.keys(value).some(key => !["build", "strategy", "race"].includes(key)) || !label(value.build) || !label(value.strategy) || value.race !== undefined && !["P", "T", "Z", "R"].includes(value.race)) return null;
    return { build: value.build, opp_strategy: value.strategy, ...(value.race ? { opp_race: value.race } : {}) };
  } catch { return null; }
}
