"use strict";

/**
 * Pool-first opener names by patch.
 *
 * The openers are "8 Pool" on the 8-worker patch 5.0.16 and "12 Pool"
 * before it and again from 5.0.17, which restored 12 starting workers. The
 * detection rule is the same; only the name follows the patch the game was
 * played on (util/patchEra.js). Agent 0.17.4 names them by the replay's
 * version. Older agents sent "8 Pool" on every patch (0.14.3 to 0.17.3) or
 * "12 Pool" on every patch (before 0.14.3), so ingest corrects the label,
 * and the one-shot migration db/migrations/2026-09-30-rename-8-pool-builds.js
 * corrects stored ones.
 */

const { PATCH_ERA_AFTER, PATCH_ERA_BEFORE, eraForGame } = require("./patchEra");

/** 8-worker patch name → the 12-worker game's name. */
const TWELVE_POOL_NAMES = Object.freeze({
  "Zerg - 8 Pool": "Zerg - 12 Pool",
  "ZvP - 8 Pool Rush": "ZvP - 12 Pool Rush",
  "ZvZ - 8 Pool into Baneling": "ZvZ - 12 Pool into Baneling",
  "ZvZ - 8 Pool Speedling": "ZvZ - 12 Pool Speedling",
});

/** The 12-worker game's name → the 8-worker patch's name. */
const EIGHT_POOL_NAMES = Object.freeze(
  Object.fromEntries(Object.entries(TWELVE_POOL_NAMES).map(([eight, twelve]) => [twelve, eight])),
);

/**
 * @param {Readonly<Record<string, string>>} names
 * @param {unknown} name
 * @returns {string|null} the mapped name, or null when ``name`` is not a key
 */
function mapped(names, name) {
  return typeof name === "string" && Object.hasOwn(names, name) ? names[name] : null;
}

/**
 * The pool-opener name a game's patch uses: "8 Pool" on 5.0.16, "12 Pool"
 * elsewhere. Any other name, or a game with no era signal, is unchanged.
 *
 * Example: `poolNameForGame("Zerg - 12 Pool", { gameVersion: "5.0.16.97425" })`
 * → "Zerg - 8 Pool".
 *
 * @param {unknown} name
 * @param {Record<string, any>} game
 * @returns {unknown}
 */
function poolNameForGame(name, game) {
  const era = eraForGame(game);
  if (era === PATCH_ERA_BEFORE) return mapped(EIGHT_POOL_NAMES, name) ?? name;
  if (era === PATCH_ERA_AFTER) return mapped(TWELVE_POOL_NAMES, name) ?? name;
  return name;
}

/**
 * Name the pool openers of an ingest payload for its patch, in place:
 * ``myBuild``, ``opponent.strategy`` and the legacy ``opp_strategy``.
 *
 * Example: a 5.0.17 game with `myBuild: "Zerg - 8 Pool"` → "Zerg - 12 Pool";
 * a 5.0.16 game with `myBuild: "Zerg - 12 Pool"` → "Zerg - 8 Pool".
 *
 * @param {Record<string, any>|null|undefined} game an ingest payload
 * @returns {boolean} true when a label changed
 */
function normalizePoolBuildNames(game) {
  if (!game) return false;
  let changed = false;
  const rename = (/** @type {Record<string, any>} */ holder, /** @type {string} */ field) => {
    const next = poolNameForGame(holder[field], game);
    if (next !== holder[field]) {
      holder[field] = next;
      changed = true;
    }
  };
  rename(game, "myBuild");
  if (game.opponent && typeof game.opponent === "object") rename(game.opponent, "strategy");
  rename(game, "opp_strategy");
  return changed;
}

module.exports = { TWELVE_POOL_NAMES, EIGHT_POOL_NAMES, poolNameForGame, normalizePoolBuildNames };
