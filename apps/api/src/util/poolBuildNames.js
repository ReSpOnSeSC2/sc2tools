"use strict";

/**
 * Pool-first opener names.
 *
 * The classifier named these openers "8 Pool" during the 8-worker patch
 * 5.0.16 (agents 0.14.3 to 0.17.3) and "12 Pool" before it and again from
 * 5.0.17, which restored 12 starting workers. The catalog, the guides and
 * agent 0.17.4 know only the 12 Pool names, whichever patch a game was
 * played on (the guides' 8-worker view carries that context), so ingest
 * renames the labels older agents still send, and the one-shot migration
 * db/migrations/2026-09-30-rename-8-pool-builds.js renames stored ones.
 */

/** 8-worker patch label → the 12-worker game's label. */
const TWELVE_POOL_NAMES = Object.freeze({
  "Zerg - 8 Pool": "Zerg - 12 Pool",
  "ZvP - 8 Pool Rush": "ZvP - 12 Pool Rush",
  "ZvZ - 8 Pool into Baneling": "ZvZ - 12 Pool into Baneling",
  "ZvZ - 8 Pool Speedling": "ZvZ - 12 Pool Speedling",
});

/**
 * @param {unknown} name
 * @returns {string|null} the 12-worker name of an 8-worker pool label, else null
 */
function twelvePoolName(name) {
  if (typeof name !== "string" || !Object.hasOwn(TWELVE_POOL_NAMES, name)) return null;
  return TWELVE_POOL_NAMES[/** @type {keyof typeof TWELVE_POOL_NAMES} */ (name)];
}

/**
 * Rename 8 Pool labels to 12 Pool, in place.
 *
 * Example: `myBuild: "Zerg - 8 Pool"` → "Zerg - 12 Pool";
 * `opponent.strategy: "ZvP - 8 Pool Rush"` → "ZvP - 12 Pool Rush".
 *
 * @param {Record<string, any>|null|undefined} game an ingest payload
 * @returns {boolean} true when a label changed
 */
function normalizePoolBuildNames(game) {
  if (!game) return false;
  let changed = false;
  const myBuild = twelvePoolName(game.myBuild);
  if (myBuild) {
    game.myBuild = myBuild;
    changed = true;
  }
  if (game.opponent && typeof game.opponent === "object") {
    const strategy = twelvePoolName(game.opponent.strategy);
    if (strategy) {
      game.opponent.strategy = strategy;
      changed = true;
    }
  }
  const legacyStrategy = twelvePoolName(game.opp_strategy);
  if (legacyStrategy) {
    game.opp_strategy = legacyStrategy;
    changed = true;
  }
  return changed;
}

module.exports = { TWELVE_POOL_NAMES, twelvePoolName, normalizePoolBuildNames };
