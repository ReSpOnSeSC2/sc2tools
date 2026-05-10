"use strict";

/**
 * Map the leading region byte of an SC2 toon handle to a short
 * Blizzard-region label.
 *
 * Blizzard's toon-handle wire format is ``<region>-S2-<realm>-<bnid>``;
 * the leading numeric byte identifies the server cluster:
 *
 *   ``1`` → NA, ``2`` → EU, ``3`` → KR / TW (one cluster),
 *   ``5`` → CN, ``6`` → SEA.
 *
 * Returns ``null`` for unknown / malformed handles so the caller can
 * leave ``region`` undefined (the renderer treats that as "no region
 * available") instead of mis-labelling.
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
  switch (head) {
    case "1": return "NA";
    case "2": return "EU";
    case "3": return "KR";
    case "5": return "CN";
    case "6": return "SEA";
    default: return null;
  }
}

module.exports = { regionFromToonHandle };
