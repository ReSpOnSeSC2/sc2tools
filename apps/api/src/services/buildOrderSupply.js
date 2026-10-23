"use strict";

/**
 * Supply is a prior replay sample, not a precise event counter. Never borrow
 * a future sample, overwrite measured event supply or mutate stored events.
 * @param {Array<Record<string, any>>} events
 * @param {unknown} samples
 */
function stampBuildSupply(events, samples) {
  const stats = (Array.isArray(samples) ? samples : [])
    .filter(row => row && Number.isFinite(row.time) && row.time >= 0
      && Number.isFinite(row.food_used) && row.food_used >= 0)
    .slice().sort((a, b) => a.time - b.time);
  return events.map(event => {
    if (typeof event.supply === "number" && Number.isFinite(event.supply) && event.supply >= 0) return { ...event };
    if (!Number.isFinite(event.time) || !stats.length) return { ...event };
    let low = 0, high = stats.length - 1, prior = -1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      if (stats[middle].time <= event.time) { prior = middle; low = middle + 1; }
      else high = middle - 1;
    }
    return prior < 0 ? { ...event } : { ...event, supply: stats[prior].food_used, supplyApprox: true };
  });
}

module.exports = { stampBuildSupply };
