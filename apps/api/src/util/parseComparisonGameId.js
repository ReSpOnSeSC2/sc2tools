"use strict";

/**
 * Comparison identifiers follow the persisted gameId length limit. Reject
 * arrays/objects and invisible control characters before allocating a cache
 * entry. An omitted identifier means the ordinary cohort summary.
 * @param {unknown} raw
 * @returns {string|undefined|null} null denotes an invalid query value.
 */
function parseComparisonGameId(raw) {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 200) return null;
  if (raw !== raw.trim()) return null;
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    if (code < 32 || code === 127) return null;
  }
  return raw;
}

module.exports = { parseComparisonGameId };
