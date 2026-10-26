export type OpeningForecast = {
  top: { name: string; probability: number; samples: number; of: number; why: string[] }[];
  effectiveN: number; confidence: "Low" | "Medium" | "High"; sampleSize: number; sourceWindowSize: number;
  matchup: string | null; map: string | null; limit: 50; otherProbability: number;
  partial: boolean; reason?: "source_window_truncated" | null;
  prior: { pseudoGames: number; n: number; bandLabel: string; matchup: string } | null;
  ratingBasis?: "current_replay" | "last_matchup_replay" | null;
};
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const finite = (value: unknown, max: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;
const count = (value: unknown, max = 50): value is number => finite(value, max) && Number.isSafeInteger(value);
const text = (value: unknown, max = 200) => typeof value === "string" ? value.trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max) : "";

/** Bounded display names only; never forward group ids or private identity metadata. */
export function scoutingAliases(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.slice(0, 19).map(name => text(name, 120)).filter(Boolean))] : [];
}

/** A malformed new response is unavailable, not an excuse to revive a legacy posterior. */
export function parseOpeningForecast(value: unknown): OpeningForecast | null {
  const row = object(value);
  if (!row || !Array.isArray(row.top) || row.top.length > 3 || !finite(row.effectiveN, 75)
    || !count(row.sampleSize) || !count(row.sourceWindowSize) || row.sampleSize > row.sourceWindowSize
    || !["Low", "Medium", "High"].includes(String(row.confidence)) || row.limit !== 50
    || !finite(row.otherProbability, 1) || typeof row.partial !== "boolean") return null;
  const top: OpeningForecast["top"] = [];
  for (const raw of row.top) {
    const item = object(raw);
    if (!item || !text(item.name) || !finite(item.probability, 1) || !count(item.samples)
      || !count(item.of) || item.of !== row.sampleSize || item.samples > item.of || !Array.isArray(item.why) || item.why.length > 3) return null;
    top.push({ name: text(item.name), probability: item.probability, samples: item.samples, of: item.of,
      why: item.why.map(reason => text(reason)).filter(Boolean) });
  }
  if (row.partial && (top.length || row.reason !== "source_window_truncated")) return null;
  if (top.reduce((sum, item) => sum + item.probability, 0) + row.otherProbability > 1.00001) return null;
  const prior = object(row.prior);
  return { top, effectiveN: row.effectiveN, confidence: row.confidence as OpeningForecast["confidence"],
    sampleSize: row.sampleSize, sourceWindowSize: row.sourceWindowSize, limit: 50, otherProbability: row.otherProbability,
    matchup: typeof row.matchup === "string" && /^[PTZ]v[PTZ]$/.test(row.matchup) ? row.matchup : null,
    map: text(row.map) || null, partial: row.partial, reason: row.partial ? "source_window_truncated" : null,
    prior: prior && count(prior.n, 1e9) && prior.n >= 50 && prior.pseudoGames === 3 && typeof prior.matchup === "string" && /^[PTZ]v[PTZ]$/.test(prior.matchup)
      ? { pseudoGames: 3, n: prior.n, bandLabel: text(prior.bandLabel), matchup: prior.matchup } : null,
    ratingBasis: row.ratingBasis === "current_replay" || row.ratingBasis === "last_matchup_replay" ? row.ratingBasis : null };
}
