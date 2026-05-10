"use strict";

/**
 * Filters that target the games collection by opponent identity.
 *
 * Each opponents row carries two identity fields:
 *   * ``pulseId`` — historically the raw sc2reader ``toon_handle``
 *     (``region-S2-realm-bnid``). Stable per Battle.net character on
 *     a single Pulse account; this is the storage key for the
 *     opponents collection and the join key the H2H lookup has
 *     used since day one.
 *   * ``pulseCharacterId`` — the canonical SC2Pulse character id
 *     (numeric string). Survives the rare "player rebound their
 *     Battle.net" case that rotates the toon_handle while keeping
 *     the SC2Pulse character identity stable, so two ``games``
 *     rows with different toon handles but the same Pulse id
 *     belong to the same opponent.
 *
 * Pre-fix queries matched on ``opponent.pulseId`` alone, which
 * meant a rebound opponent's pre-rebind games would silently
 * disappear from H2H counters / scouting widgets / k-anon
 * profiles. ``opponentGamesFilter`` returns the merged filter:
 *
 *   * pulseId OR pulseCharacterId when both are set,
 *   * pulseId only when pulseCharacterId is missing,
 *   * pulseCharacterId only when pulseId is missing.
 *
 * Callers compose this with their own ``userId`` / matchup /
 * date constraints — this helper only owns the identity clause
 * so query plans stay legible.
 */

/**
 * Build a games-collection filter that matches an opponent by
 * either of its two identity fields.
 *
 * Returns ``null`` when neither identifier is usable; callers should
 * fall back to display-name (or skip the lookup) in that case so we
 * don't accidentally return an unbounded result set.
 *
 * @param {{
 *   pulseId?: string|null,
 *   pulseCharacterId?: string|null,
 * }} ids
 * @returns {Record<string, any> | null}
 */
function opponentGamesFilter(ids) {
  const pulseId = cleanId(ids && ids.pulseId);
  const pulseCharacterId = cleanId(ids && ids.pulseCharacterId);
  if (pulseId && pulseCharacterId) {
    // $or on two indexed equality clauses; Mongo merges via index
    // intersection (or two index scans + merge). Both candidate
    // sets are tiny (one opponent per user) so the planner stays
    // fast. The unique-per-doc nature of toon handles means there
    // is no double-counting risk: any single games row matches at
    // most one branch.
    return {
      $or: [
        { "opponent.pulseId": pulseId },
        { "opponent.pulseCharacterId": pulseCharacterId },
      ],
    };
  }
  if (pulseId) return { "opponent.pulseId": pulseId };
  if (pulseCharacterId) {
    return { "opponent.pulseCharacterId": pulseCharacterId };
  }
  return null;
}

/**
 * Same shape as ``opponentGamesFilter`` but composed onto an
 * existing filter object so callers don't have to remember the
 * ``$and`` pattern when they already carry their own ``$or`` /
 * matchup / date clauses. Mutates and returns ``filter``.
 *
 * @param {Record<string, any>} filter
 * @param {{ pulseId?: string|null, pulseCharacterId?: string|null }} ids
 * @returns {Record<string, any> | null}
 *   ``null`` when neither identifier is usable — the same signal
 *   the bare helper returns.
 */
function attachOpponentIdsToFilter(filter, ids) {
  const clause = opponentGamesFilter(ids);
  if (!clause) return null;
  // Plain equality (one branch) — merge into the parent filter.
  // Two-branch $or — wrap so any caller-supplied $or stays
  // independent (Mongo only supports one top-level $or).
  if (clause.$or) {
    if (Array.isArray(filter.$and)) {
      filter.$and.push(clause);
    } else {
      filter.$and = [clause];
    }
  } else {
    Object.assign(filter, clause);
  }
  return filter;
}

function cleanId(v) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

module.exports = {
  opponentGamesFilter,
  attachOpponentIdsToFilter,
};
