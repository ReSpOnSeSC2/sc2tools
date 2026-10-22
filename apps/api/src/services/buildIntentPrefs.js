"use strict";

/**
 * Build check-in preferences.
 *
 * ``users.preferences.buildCheckin`` holds three booleans that all default
 * to true: a flag is off only when it is stored as ``false``. The randomizer
 * config (``users.preferences.randomizer``, written by the web Settings)
 * supplies the per-matchup pool the OBS widget rolls from.
 */

const CHECKIN_PREF_TYPE = "buildCheckin";

/** @typedef {{ enabled: boolean, askAtLoading: boolean, askAfterGame: boolean }} CheckinPrefs */

/**
 * Exactly the three booleans; anything but an explicit ``false`` is true.
 *
 * Example: `sanitizeCheckinPrefs({ askAtLoading: false, extra: 1 })` →
 * `{ enabled: true, askAtLoading: false, askAfterGame: true }`.
 *
 * @param {unknown} raw
 * @returns {CheckinPrefs}
 */
function sanitizeCheckinPrefs(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw)
    ? /** @type {Record<string, unknown>} */ (raw)
    : {};
  return {
    enabled: src.enabled !== false,
    askAtLoading: src.askAtLoading !== false,
    askAfterGame: src.askAfterGame !== false,
  };
}

/**
 * The randomizer pool for one matchup: the build ids the OBS widget can
 * roll. ``enabled`` mirrors the widget's own gate (matchup switched on with
 * at least one build), so a disabled matchup never spins.
 *
 * @param {unknown} randomizerPrefs ``users.preferences.randomizer``
 * @param {string} matchup "PvZ" form
 * @returns {{ enabled: boolean, ids: string[] }}
 */
function randomizerPool(randomizerPrefs, matchup) {
  const matchups = randomizerPrefs && typeof randomizerPrefs === "object"
    ? /** @type {Record<string, any>} */ (randomizerPrefs).matchups
    : null;
  const config = matchups && typeof matchups === "object" && Object.hasOwn(matchups, matchup)
    ? matchups[matchup]
    : null;
  if (!config || typeof config !== "object" || !Array.isArray(config.builds)) {
    return { enabled: false, ids: [] };
  }
  /** @type {string[]} */
  const ids = [];
  for (const build of config.builds) {
    if (!build || typeof build !== "object") continue;
    const { id, name } = /** @type {Record<string, unknown>} */ (build);
    if (typeof id !== "string" || id.length === 0 || id.length > 200) continue;
    if (typeof name !== "string" || name.length === 0) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  return { enabled: config.enabled === true && ids.length > 0, ids };
}

/**
 * One read of both preference blocks the feature needs.
 *
 * @param {import('mongodb').Collection} users
 * @param {string} userId
 * @returns {Promise<{ checkin: CheckinPrefs, randomizer: Record<string, unknown> }>}
 */
async function readBuildIntentPrefs(users, userId) {
  const doc = await users.findOne(
    { userId },
    {
      projection: {
        _id: 0,
        [`preferences.${CHECKIN_PREF_TYPE}`]: 1,
        "preferences.randomizer": 1,
      },
    },
  );
  const prefs = doc && doc.preferences && typeof doc.preferences === "object"
    ? doc.preferences
    : {};
  const randomizer = prefs.randomizer && typeof prefs.randomizer === "object"
    ? prefs.randomizer
    : {};
  return { checkin: sanitizeCheckinPrefs(prefs[CHECKIN_PREF_TYPE]), randomizer };
}

module.exports = {
  CHECKIN_PREF_TYPE,
  sanitizeCheckinPrefs,
  randomizerPool,
  readBuildIntentPrefs,
};
