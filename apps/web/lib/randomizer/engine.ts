/**
 * Randomizer engine — weighted selection, reveal-style rotation, and a
 * small seedable PRNG so tests (and deterministic replays) can pin a
 * spin's outcome.
 */
import {
  REVEAL_STYLES,
  UNIT_REVEAL_STYLES,
  type GatewayUnitId,
  type MatchupConfig,
  type MatchupKey,
  type OpeningUnitsOutcome,
  type RandomizerBuild,
  type RevealStyle,
  type SpinOutcome,
  type UnitRevealStyle,
  type WeightedGatewayUnit,
} from "./types";
import { isGatewayUnitId } from "./gatewayUnits";

/** Stable unsigned 32-bit FNV-1a hash for game-key-derived PRNG seeds. */
export function seedFromString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Deterministic 32-bit PRNG. Returns a function yielding [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Effective (non-negative) weight for a build under a matchup config. */
export function effectiveWeight(
  build: RandomizerBuild,
  useCustomWeights: boolean,
): number {
  if (!useCustomWeights) return 1;
  const w = Number(build.weight);
  return Number.isFinite(w) && w > 0 ? w : 0;
}

/** Normalize an array of weights into probabilities (sum 1). */
export function normalizeProbabilities(weights: number[]): number[] {
  const total = weights.reduce((s, w) => s + (w > 0 ? w : 0), 0);
  if (total <= 0) {
    // Degenerate (all zero) → uniform fallback so the wheel/plinko
    // visuals never render zero-width segments.
    const n = weights.length || 1;
    return weights.map(() => 1 / n);
  }
  return weights.map((w) => (w > 0 ? w : 0) / total);
}

/** Pick an index from a probability distribution using `rng`. */
export function pickIndex(probabilities: number[], rng: () => number): number {
  const r = rng();
  let acc = 0;
  for (let i = 0; i < probabilities.length; i += 1) {
    acc += probabilities[i];
    if (r < acc) return i;
  }
  return probabilities.length - 1;
}

/** Choose a reveal style at random, optionally avoiding the previous one. */
export function pickRevealStyle(
  rng: () => number = Math.random,
  avoid?: RevealStyle | null,
): RevealStyle {
  const choices = avoid
    ? REVEAL_STYLES.filter((s) => s !== avoid)
    : REVEAL_STYLES;
  const pool = choices.length > 0 ? choices : REVEAL_STYLES;
  return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
}

/** Choose one of the dedicated opening-unit reveal styles. */
export function pickUnitRevealStyle(
  rng: () => number = Math.random,
): UnitRevealStyle {
  return UNIT_REVEAL_STYLES[
    Math.min(UNIT_REVEAL_STYLES.length - 1, Math.floor(rng() * UNIT_REVEAL_STYLES.length))
  ];
}

/** Effective weight for one selected Gateway unit. */
export function effectiveOpeningUnitWeight(
  unit: WeightedGatewayUnit,
  useCustomWeights: boolean,
): number {
  if (!useCustomWeights) return 1;
  const weight = Number(unit.weight);
  return Number.isFinite(weight) && weight > 0 ? weight : 0;
}

/**
 * Roll one unit per configured Gateway. Each draw uses the same normalized
 * pool and is independent, so a two-Gate result may intentionally repeat.
 */
export function spinOpeningUnits(
  build: RandomizerBuild,
  enabled: boolean,
  rng: () => number = Math.random,
): OpeningUnitsOutcome | null {
  if (!enabled || build.race !== "Protoss" || !build.openingUnits) return null;

  const seen = new Set<GatewayUnitId>();
  const pool = build.openingUnits.units.filter((unit) => {
    if (!isGatewayUnitId(unit?.id) || seen.has(unit.id)) return false;
    seen.add(unit.id);
    return true;
  });
  if (pool.length === 0) return null;

  const probabilities = normalizeProbabilities(
    pool.map((unit) =>
      effectiveOpeningUnitWeight(unit, build.openingUnits!.useCustomWeights),
    ),
  );
  const gateCount = build.openingUnits.gateCount === 2 ? 2 : 1;
  const picks: GatewayUnitId[] = [];
  for (let gate = 0; gate < gateCount; gate += 1) {
    picks.push(pool[pickIndex(probabilities, rng)].id);
  }

  return {
    gateCount,
    picks,
    style: pickUnitRevealStyle(rng),
    pool,
    probabilities,
  };
}

/**
 * Resolve a full spin for a matchup. Returns null when the matchup is
 * disabled or has no builds — callers render nothing in that case.
 */
export function spinResult(
  matchup: MatchupKey,
  cfg: MatchupConfig | undefined,
  rng: () => number = Math.random,
  avoidStyle?: RevealStyle | null,
): SpinOutcome | null {
  if (!cfg || !cfg.enabled) return null;
  const pool = cfg.builds.filter((b) => b && typeof b.name === "string");
  if (pool.length === 0) return null;

  const weights = pool.map((b) => effectiveWeight(b, cfg.useCustomWeights));
  const probabilities = normalizeProbabilities(weights);
  const winnerIndex = pickIndex(probabilities, rng);
  // Preserve the original RNG ordering: build winner first, build reveal
  // style second. Opening-unit draws are appended only after both decisions.
  const style = pickRevealStyle(rng, avoidStyle);
  const winner = pool[winnerIndex];

  return {
    matchup,
    winner,
    style,
    pool,
    probabilities,
    openingUnits: spinOpeningUnits(
      winner,
      cfg.unitRandomizerEnabled === true,
      rng,
    ),
  };
}
