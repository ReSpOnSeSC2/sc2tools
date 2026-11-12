const PACE_STEP = 10;
export const PACE_WINDOW = 270;
export const PACE_CHECKPOINT_INDEX = 240 / PACE_STEP;
export const PACE_POINTS = PACE_WINDOW / PACE_STEP + 1;

export const PACE_MATCHUPS = ["PvP", "PvT", "PvZ", "TvP", "ZvP"] as const;
export type PaceMatchup = (typeof PACE_MATCHUPS)[number];
export type PaceEra = "before" | "after";

export function isPaceMatchup(value: unknown): value is PaceMatchup {
  return PACE_MATCHUPS.some((matchup) => matchup === value);
}

export function isPaceEra(value: unknown): value is PaceEra {
  return value === "before" || value === "after";
}

export function startingWorkers(era: PaceEra): number {
  return era === "before" ? 8 : 12;
}

export type PaceSample = {
  time: number;
  food_workers?: number;
  minerals_collection_rate?: number;
  vespene_collection_rate?: number;
};

export type PaceCurves = { workers: number[]; income: number[] };
type EconomyPoint = { time: number; workers: number; rate: number };

function measure(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function economyPoint(sample: PaceSample): EconomyPoint | null {
  const { time, food_workers: workers, minerals_collection_rate: minerals, vespene_collection_rate: gas } = sample;
  if (!measure(time) || !measure(workers) || !measure(minerals) || !measure(gas)) return null;
  const rate = minerals + gas;
  return measure(rate) ? { time, workers, rate } : null;
}

function interpolate(from: number, to: number, fraction: number): number {
  return from + (to - from) * fraction;
}

function orderedOpening(samples: readonly PaceSample[], era: PaceEra): EconomyPoint[] | null {
  const points = samples.flatMap((sample) => economyPoint(sample) ?? []);
  if (points[0]?.time !== 0 || points[0].workers !== startingWorkers(era)) return null;
  const ordered = points.every((point, i) => i === 0 || point.time > points[i - 1].time);
  return ordered ? points : null;
}

/**
 * Rates are resources per minute. Integrate the sum of minerals and gas with
 * the trapezoid rule on the same game-clock grid as worker counts.
 */
export function paceCurves(samples: readonly PaceSample[], era: PaceEra): PaceCurves | null {
  const points = orderedOpening(samples, era);
  if (!points) return null;

  const workers = [points[0].workers];
  const income = [0];
  let next = 1;
  let previousRate = points[0].rate;
  for (let time = PACE_STEP; time <= PACE_WINDOW; time += PACE_STEP) {
    while (next < points.length && points[next].time < time) next += 1;
    const left = points[next - 1], right = points[next];
    // Large holes aren't reliable samples of the opening. Never extrapolate.
    if (!right || right.time - left.time > 30) return null;
    const fraction = (time - left.time) / (right.time - left.time);
    const rate = interpolate(left.rate, right.rate, fraction);
    const total = income[income.length - 1] + (previousRate / 2 + rate / 2) * (PACE_STEP / 60);
    if (!measure(total)) return null;
    workers.push(interpolate(left.workers, right.workers, fraction));
    income.push(total);
    previousRate = rate;
  }
  return { workers, income };
}

/** First observed or interpolated time that meets a positive reference value. */
export function paceCrossing(curve: readonly number[], target: number): number | null {
  const index = curve.findIndex((value) => value >= target);
  if (index < 0) return null;
  if (index === 0) return 0;
  const previous = curve[index - 1];
  return (index - 1 + (target - previous) / (curve[index] - previous)) * PACE_STEP;
}
