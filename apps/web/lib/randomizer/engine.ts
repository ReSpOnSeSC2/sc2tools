/**
 * Randomizer engine — weighted selection, reveal-style rotation, and a
 * small seedable PRNG so tests (and deterministic replays) can pin a
 * spin's outcome.
 */
import {
  REVEAL_STYLES,
  UNIT_REVEAL_STYLES,
  isOpeningUnitId,
  playedRace,
  type GameDraw,
  type MatchupConfig,
  type MatchupKey,
  type OpeningUnitId,
  type OpeningUnitsConfig,
  type OpeningUnitsOutcome,
  type PlayedRace,
  type RandomizerBuild,
  type RevealStyle,
  type SpinOutcome,
  type UnitRevealStyle,
  type WeightedOpeningUnit,
} from "./types";

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

/** Effective weight for one selected opening unit. */
export function effectiveOpeningUnitWeight(
  unit: WeightedOpeningUnit,
  useCustomWeights: boolean,
): number {
  if (!useCustomWeights) return 1;
  const weight = Number(unit.weight);
  return Number.isFinite(weight) && weight > 0 ? weight : 0;
}

/**
 * Roll one unit per Gateway or building. Each draw uses the same normalized
 * pool and is independent, so a two-unit result may intentionally repeat.
 */
export function drawOpeningUnits(
  race: PlayedRace,
  opening: OpeningUnitsConfig,
  rng: () => number = Math.random,
): OpeningUnitsOutcome | null {
  const seen = new Set<OpeningUnitId>();
  const pool = opening.units.filter((unit) => {
    if (!isOpeningUnitId(unit?.id, race) || seen.has(unit.id)) return false;
    seen.add(unit.id);
    return true;
  });
  if (pool.length === 0) return null;

  const probabilities = normalizeProbabilities(
    pool.map((unit) => effectiveOpeningUnitWeight(unit, opening.useCustomWeights)),
  );
  const gateCount = opening.gateCount === 2 ? 2 : 1;
  const picks: OpeningUnitId[] = [];
  for (let gate = 0; gate < gateCount; gate += 1) {
    picks.push(pool[pickIndex(probabilities, rng)].id);
  }

  return {
    race,
    gateCount,
    picks,
    style: pickUnitRevealStyle(rng),
    pool,
    probabilities,
  };
}

/**
 * The unit settings that follow a drawn build: its pool entry's own, else
 * (a Terran or Zerg entry saved without any) the matchup's. A saved pick no
 * longer in the pool draws no units.
 */
function unitSettingsAfterBuild(
  cfg: MatchupConfig,
  winner: RandomizerBuild,
): OpeningUnitsConfig | undefined {
  const inPool = cfg.builds.some((build) => build?.id === winner.id && typeof build.name === "string");
  return inPool ? winner.openingUnits ?? cfg.units : undefined;
}

/**
 * One game's complete draw for a matchup: its build, then its opening
 * units, each behind its own switch. The units take the generator's next
 * values after the build's two (winner, then reveal style), or its first
 * values when no build is drawn. Null when nothing is drawn.
 */
export function drawGame(
  matchup: MatchupKey,
  cfg: MatchupConfig | undefined,
  rng: () => number = Math.random,
  avoidStyle?: RevealStyle | null,
  winnerOverride?: RandomizerBuild,
): GameDraw | null {
  if (!cfg) return null;
  const build = spinResult(matchup, cfg, rng, avoidStyle, winnerOverride);
  const opening = build ? unitSettingsAfterBuild(cfg, build.winner) : cfg.enabled ? undefined : cfg.units;
  const units = cfg.unitRandomizerEnabled && opening
    ? drawOpeningUnits(playedRace(matchup), opening, rng)
    : null;
  return build || units ? { matchup, build, units } : null;
}

/**
 * Resolve the build spin for a matchup. Returns null when its build draw
 * is off or it has no builds — callers render nothing in that case.
 */
export function spinResult(
  matchup: MatchupKey,
  cfg: MatchupConfig | undefined,
  rng: () => number = Math.random,
  avoidStyle?: RevealStyle | null,
  winnerOverride?: RandomizerBuild,
): SpinOutcome | null {
  if (!cfg || !cfg.enabled) return null;
  const configured = cfg.builds.filter((b) => b && typeof b.name === "string");
  const pool = winnerOverride
    ? configured.some((build) => build.id === winnerOverride.id)
      ? configured.map((build) => build.id === winnerOverride.id ? winnerOverride : build)
      : [winnerOverride]
    : configured;
  if (pool.length === 0) return null;

  const weights = pool.map((b) => effectiveWeight(b, cfg.useCustomWeights));
  const probabilities = normalizeProbabilities(weights);
  const winnerIndex = pickIndex(probabilities, rng);
  // Preserve the original RNG ordering: build winner first, build reveal
  // style second. Opening-unit draws are appended only after both decisions.
  const style = pickRevealStyle(rng, avoidStyle);
  const winner = winnerOverride ? pool.find((build) => build.id === winnerOverride.id)! : pool[winnerIndex];

  return { matchup, winner, style, pool, probabilities };
}
