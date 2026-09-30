"use strict";

/**
 * Pool-first opener names by starting-worker count.
 *
 * The classifier named these openers "8 Pool" during the 8-worker patch
 * 5.0.16 (agents 0.14.3 to 0.17.3) and "12 Pool" before it and again from
 * 5.0.17, which restored 12 starting workers. Agents from before the
 * revert keep sending "8 Pool", so ingest renames those labels on
 * 12-worker games: every game from 5.0.17 on carries the 12 Pool name
 * whichever agent uploaded it. Games played on 5.0.16 keep their label.
 */

const { PATCH_ERA_AFTER, eraForGame } = require("./patchEra");

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
 * Rename 8 Pool labels to 12 Pool, in place, on a 12-worker game
 * (util/patchEra.js "after"). A game with no era signal is left alone.
 *
 * Example: a 5.0.17 game with `myBuild: "Zerg - 8 Pool"` → "Zerg - 12 Pool";
 * the same label on a 5.0.16 game is unchanged.
 *
 * @param {Record<string, any>|null|undefined} game an ingest payload
 * @returns {boolean} true when a label changed
 */
function normalizePoolBuildNames(game) {
  if (!game || eraForGame(game) !== PATCH_ERA_AFTER) return false;
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

module.exports = { TWELVE_POOL_NAMES, normalizePoolBuildNames };
