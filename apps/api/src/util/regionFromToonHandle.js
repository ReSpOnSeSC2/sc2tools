"use strict";

/**
 * Map the region segment of an SC2 toon handle (everything before the
 * first ``-``) to a short Blizzard-region label.
 *
 * Blizzard's toon-handle wire format is ``<region>-S2-<realm>-<bnid>``;
 * the numeric region segment identifies the server cluster:
 *
 *   ``1`` → NA, ``2`` → EU, ``3`` → KR / TW (one cluster),
 *   ``5`` → CN, ``6`` → SEA, ``98`` → PTR (the Public Test Realm).
 *
 * Returns ``null`` for unknown / malformed handles so the caller can
 * leave ``region`` undefined (the renderer treats that as "no region
 * available") instead of mis-labelling.
 *
 * PTR is a real region for filtering and grouping, so PTR games are not
 * lost behind a region filter, but it has no SC2Pulse ladder. Callers that
 * pick a region for an SC2Pulse lookup must use ``isLadderRegion``.
 *
 * Lifted out of ``services/games.js`` so the live-bridge enrichment
 * cache and the session-aggregate code share the same source of truth
 * — without it, the two sides could disagree on whether a NA "Maru"
 * and an EU "Maru" are the same person and silently cross-pollinate
 * scouting data.
 *
 * @param {unknown} toonHandle
 * @returns {string|null}
 */
function regionFromToonHandle(toonHandle) {
  if (typeof toonHandle !== "string") return null;
  const head = toonHandle.split("-")[0];
  return Object.prototype.hasOwnProperty.call(REGION_BY_HANDLE_PREFIX, head)
    ? REGION_BY_HANDLE_PREFIX[head]
    : null;
}

/** Label of the Public Test Realm (toon handles starting ``98-``). */
const PTR_REGION = "PTR";

/**
 * Region label → toon-handle prefix, in display order. The inverse of
 * ``regionFromToonHandle``; the region filters use it to match rows that
 * have no stored region by their toon handle.
 * @type {Readonly<Record<string, string>>}
 */
const REGION_HANDLE_PREFIX = Object.freeze({
  NA: "1",
  EU: "2",
  KR: "3",
  CN: "5",
  SEA: "6",
  [PTR_REGION]: "98",
});

/** @type {Readonly<Record<string, string>>} */
const REGION_BY_HANDLE_PREFIX = Object.freeze(
  Object.fromEntries(
    Object.entries(REGION_HANDLE_PREFIX).map(([label, prefix]) => [prefix, label]),
  ),
);

/** Every region label ``regionFromToonHandle`` can return. */
const REGION_LABELS = Object.freeze(Object.keys(REGION_HANDLE_PREFIX));

/**
 * True for a region with an SC2Pulse ladder (every label but PTR).
 * Example: isLadderRegion("NA") === true; isLadderRegion("PTR") === false
 * @param {unknown} region
 * @returns {boolean}
 */
function isLadderRegion(region) {
  return typeof region === "string"
    && region !== PTR_REGION
    && Object.prototype.hasOwnProperty.call(REGION_HANDLE_PREFIX, region);
}

/**
 * The SC2Pulse ladder region of a toon handle, or ``null`` for a PTR
 * (``98-``) or unrecognised handle. For callers that pin an SC2Pulse
 * lookup or track ladder MMR, where a PTR game must read as
 * region-unknown.
 *
 * Example: ladderRegionFromToonHandle("1-S2-1-267727") === "NA";
 *          ladderRegionFromToonHandle("98-S2-1-30230") === null
 *
 * @param {unknown} toonHandle
 * @returns {string|null}
 */
function ladderRegionFromToonHandle(toonHandle) {
  const region = regionFromToonHandle(toonHandle);
  return isLadderRegion(region) ? region : null;
}

module.exports = {
  regionFromToonHandle,
  isLadderRegion,
  ladderRegionFromToonHandle,
  PTR_REGION,
  REGION_HANDLE_PREFIX,
  REGION_LABELS,
};
