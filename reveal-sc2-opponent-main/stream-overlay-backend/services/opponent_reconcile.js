// @ts-check
/**
 * OPPONENT RECONCILIATION SERVICE
 * ============================================================
 * Owns the in-memory cache that maps a recently-faced opponent's
 * display name to the SC2Pulse character_id that the deep replay
 * parse resolved via toon_handle. The cache is the bridge between
 * the live phase (which only sees the on-screen display name --
 * brittle for "barcode" players whose names visually collide) and
 * the post-game phase (where the replay file's toon_handle is the
 * authoritative identifier of the player behind that name).
 *
 * Why a separate module
 * ---------------------
 * The Stage-11 audit pinned analyzer.js / index.js as too tangled
 * to unit-test directly (socket.io + tmi.js + Pulse polling all
 * boot at require time). Pulling the reconciliation cache out into
 * a pure module keeps the new behaviour testable without spinning
 * up the whole server. index.js delegates to this module.
 *
 * What it does NOT do
 * -------------------
 * No HTTP, no Pulse calls, no fs I/O. The Python watcher is the
 * canonical resolver -- this module just holds what the watcher
 * told us so the Node side can correlate it with subsequent live
 * `opponentDetected` events on the same name.
 *
 * Engineering preamble compliance:
 *   - Function size <= 30 lines, no magic constants.
 *   - JSDoc + tsc --checkJs clean (strict mode).
 *   - Pure: dependency-injected `stripClanTag` so we don't drag
 *     index.js's helper into every test.
 *
 * Example:
 *   const recon = createReconcileService({ stripClanTag });
 *   recon.recordFromDeepPayload({ oppName: 'IIIIIIII', oppPulseId: '452727' });
 *   recon.getReconciledPulseId('IIIIIIII');  // -> '452727'
 */

'use strict';

/**
 * @typedef {Object} ReconcileEntry
 * @property {string} pulseId         Authoritative SC2Pulse character_id.
 * @property {string|null} oppToon    Raw sc2reader toon_handle (or null
 *                                    when the watcher didn't carry it).
 * @property {string|null} oppRace    Race letter (P/T/Z/R) at last sighting.
 * @property {number} updatedAt       Date.now() of the latest deep payload.
 */

/**
 * @typedef {Object} ReconcileService
 * @property {(payload: Object) => Object|null} recordFromDeepPayload
 * @property {(oppName: string) => string|null} getReconciledPulseId
 * @property {(oppName: string) => ReconcileEntry|null} getReconciledEntry
 * @property {() => void} clear
 * @property {() => number} size
 */

/**
 * @typedef {Object} ReconcileServiceOptions
 * @property {(name: string) => string} [stripClanTag] Strips ``[CLAN]`` prefix
 *   from a display name. Defaults to the bracket-style stripper.
 */

/**
 * Default clan-tag stripper. Mirrors index.js / data_store.py so the
 * Node and Python identity comparisons stay aligned.
 *
 * @param {string} name
 * @returns {string}
 */
function defaultStripClanTag(name) {
  if (typeof name !== 'string') return '';
  const idx = name.indexOf(']');
  return idx >= 0 ? name.slice(idx + 1).trim() : name.trim();
}

/**
 * Construct a reconciliation service with its own private Map.
 *
 * @param {ReconcileServiceOptions} [opts]
 * @returns {ReconcileService}
 */
function createReconcileService(opts) {
  const stripClanTag = (opts && opts.stripClanTag) || defaultStripClanTag;
  /** @type {Map<string, ReconcileEntry>} */
  const cache = new Map();

  function keyOf(oppName) {
    if (!oppName || typeof oppName !== 'string') return null;
    const stripped = stripClanTag(oppName);
    return stripped ? stripped.toLowerCase() : null;
  }

  /**
   * Ingest a deep replay payload, recording the resolved pulse_id when
   * present. Returns the diff for the caller (typically index.js)
   * to emit on Socket.io, or null when nothing actionable changed.
   *
   * @param {Object} payload Deep replay payload (subset of /api/replay/deep body).
   * @returns {{ key: string, oppName: string, oppPulseId: string,
   *            previousPulseId: string|null,
   *            entry: ReconcileEntry } | null}
   */
  function recordFromDeepPayload(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const oppName = typeof payload.oppName === 'string' ? payload.oppName : '';
    const oppPulseId = payload.oppPulseId != null ? String(payload.oppPulseId) : '';
    if (!oppName || !oppPulseId) return null;
    const key = keyOf(oppName);
    if (!key) return null;
    const previous = cache.get(key) || null;
    /** @type {ReconcileEntry} */
    const entry = {
      pulseId: oppPulseId,
      oppToon: typeof payload.oppToon === 'string' && payload.oppToon
        ? payload.oppToon
        : null,
      oppRace: typeof payload.oppRace === 'string' && payload.oppRace
        ? payload.oppRace
        : null,
      updatedAt: Date.now(),
    };
    cache.set(key, entry);
    return {
      key,
      oppName: stripClanTag(oppName),
      oppPulseId,
      previousPulseId: previous ? previous.pulseId : null,
      entry,
    };
  }

  /**
   * Pulse_id last attached to ``oppName`` by a deep parse, or null.
   *
   * @param {string} oppName
   * @returns {string|null}
   */
  function getReconciledPulseId(oppName) {
    const key = keyOf(oppName);
    if (!key) return null;
    const hit = cache.get(key);
    return hit ? hit.pulseId : null;
  }

  /**
   * Full cache row for ``oppName``, or null. Useful for diagnostics.
   *
   * @param {string} oppName
   * @returns {ReconcileEntry|null}
   */
  function getReconciledEntry(oppName) {
    const key = keyOf(oppName);
    if (!key) return null;
    return cache.get(key) || null;
  }

  function clear() {
    cache.clear();
  }

  function size() {
    return cache.size;
  }

  return {
    recordFromDeepPayload,
    getReconciledPulseId,
    getReconciledEntry,
    clear,
    size,
  };
}

module.exports = {
  createReconcileService,
  defaultStripClanTag,
};
