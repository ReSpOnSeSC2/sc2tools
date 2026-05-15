"use strict";

/**
 * MMR bucketing helpers shared by the build / strategy MMR-bracket
 * analytics endpoints. Buckets are half-open intervals ``[min, max)``
 * keyed by ``min`` so adjacent buckets never double-count a game
 * sitting on a boundary.
 *
 * Default bucket width is 200 MMR — wide enough that every bucket
 * holds a usable sample for a typical streamer, narrow enough to
 * surface the league transitions players actually care about
 * (Diamond → Master is ~250 MMR; 200 keeps each one its own row).
 *
 * The width is clamped to a sane range so a typo on the wire
 * (?width=0, ?width=99999) can't blow up the aggregation or
 * generate thousands of empty buckets.
 */

const DEFAULT_BUCKET_WIDTH = 200;
const MIN_BUCKET_WIDTH = 25;
const MAX_BUCKET_WIDTH = 1000;
// Anything below this is almost certainly non-ladder noise (custom
// games, mods, AI matches). Buckets that would land entirely below
// the floor are dropped from the response.
const MMR_FLOOR = 1000;
// Anything above this is a ladder anomaly (corrupted data, agent
// bug). Bound the top so the chart x-axis doesn't stretch to
// infinity for one bad row.
const MMR_CEILING = 8000;

/**
 * Parse + clamp the bucket-width query param.
 *
 * @param {unknown} raw
 * @returns {number}
 */
function parseBucketWidth(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_BUCKET_WIDTH;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_BUCKET_WIDTH;
  if (n < MIN_BUCKET_WIDTH) return MIN_BUCKET_WIDTH;
  if (n > MAX_BUCKET_WIDTH) return MAX_BUCKET_WIDTH;
  // Snap to the nearest 25 so the URL doesn't carry meaningless
  // precision and adjacent requests hit the same cache key.
  return Math.round(n / 25) * 25;
}

/**
 * Return the bucket's lower bound (the value we key the bucket on).
 * ``mmr=4499`` with width 200 → 4400. ``mmr=4500`` → 4500.
 *
 * @param {number} mmr
 * @param {number} width
 * @returns {number}
 */
function bucketFor(mmr, width) {
  return Math.floor(mmr / width) * width;
}

/**
 * Human-readable bucket label, e.g. ``"4400–4599"``. Used by the
 * chart x-axis tick formatter so the visualisation reads naturally
 * without the client having to know the bucket width.
 *
 * @param {number} bucketMin
 * @param {number} width
 * @returns {string}
 */
function bracketLabel(bucketMin, width) {
  return `${bucketMin}–${bucketMin + width - 1}`;
}

/**
 * Whether the bucket is plausible enough to surface on the chart.
 * Drops the obvious garbage (negative, sub-1000, above 8000).
 *
 * @param {number} bucketMin
 * @returns {boolean}
 */
function isBucketInRange(bucketMin) {
  return bucketMin >= MMR_FLOOR && bucketMin < MMR_CEILING;
}

/**
 * Parse the optional mirror-MMR range. The chart caller passes a
 * single ``mmrDelta`` value meaning "only count games where
 * ``|myMmr - oppMmr| <= mmrDelta``". An undefined / non-finite value
 * disables the filter (legacy behaviour). Clamped to a sane range
 * so a fat-finger 999999 doesn't accidentally match every game
 * (which is what no filter does anyway, but we don't want callers
 * to think the filter is active when it isn't).
 *
 * @param {unknown} raw
 * @returns {number|undefined}
 */
function parseMmrDelta(raw) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  if (n > MMR_CEILING) return MMR_CEILING;
  return Math.round(n);
}

module.exports = {
  DEFAULT_BUCKET_WIDTH,
  MIN_BUCKET_WIDTH,
  MAX_BUCKET_WIDTH,
  MMR_FLOOR,
  MMR_CEILING,
  parseBucketWidth,
  bucketFor,
  bracketLabel,
  isBucketInRange,
  parseMmrDelta,
};
