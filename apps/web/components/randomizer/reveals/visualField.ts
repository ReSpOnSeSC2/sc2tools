import type { RandomizerBuild } from "@/lib/randomizer/types";

/** Motion reveals animate a bracket, after the full weighted draw is decided. */
export const MOTION_REVEAL_MAX_CONTENDERS = 12;

export function buildMotionVisualField(
  pool: RandomizerBuild[],
  winner: RandomizerBuild,
  spinId: number,
): RandomizerBuild[] {
  if (pool.length <= MOTION_REVEAL_MAX_CONTENDERS) return pool;

  const losers = pool.filter((build) => build.id !== winner.id);
  let seed = spinId | 0;
  for (let index = losers.length - 1; index > 0; index -= 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    const other = (seed >>> 0) % (index + 1);
    [losers[index], losers[other]] = [losers[other], losers[index]];
  }
  const shown = new Set(losers.slice(0, MOTION_REVEAL_MAX_CONTENDERS - 1).map((build) => build.id));
  shown.add(winner.id);
  // Keep source order so the winner's position does not give the result away.
  return pool.filter((build) => shown.has(build.id));
}
