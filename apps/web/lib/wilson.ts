/** Wilson score bounds before display rounding, so verdicts use exact thresholds. */
export function wilsonInterval(wins: number, games: number, z = 1.96) {
  if (!Number.isSafeInteger(wins) || !Number.isSafeInteger(games) || wins < 0 || wins > games
    || games <= 0 || !Number.isFinite(z) || z <= 0) return null;
  const rate = wins / games;
  const zSquared = z ** 2;
  const denominator = 1 + zSquared / games;
  const center = (rate + zSquared / (2 * games)) / denominator;
  const margin = z * Math.sqrt((rate * (1 - rate)) / games + zSquared / (4 * games ** 2)) / denominator;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}
