"use strict";

/**
 * Where StarCraft II lives on each streaming platform. The channel setup
 * (`streamingChannel.js`) and the public live list (`liveStreamProviders.js`)
 * both read these, so a renamed category is fixed in one place.
 */

/** Twitch's catalogue id for StarCraft II; stable for the life of the game. */
const TWITCH_STARCRAFT_GAME_ID = "490422";
const KICK_CATEGORY_NAME = "StarCraft II";
const KICK_CATEGORIES_URL = "https://api.kick.com/public/v2/categories";

/** @param {string} name Category name searched on Kick. */
function kickCategorySearchUrl(name = KICK_CATEGORY_NAME) {
  return `${KICK_CATEGORIES_URL}?${new URLSearchParams({ name })}`;
}

/**
 * The id of the exact "StarCraft II" row in a Kick category search result
 * (the search also returns "StarCraft II Campaign" and similar), or null.
 *
 * @param {unknown} data The `data` array of the search response.
 * @returns {number | null}
 */
function pickKickCategoryId(data) {
  const match = (Array.isArray(data) ? data : []).find(
    (/** @type {{ id?: unknown, name?: unknown }} */ row) =>
      String(row?.name).toLowerCase() === KICK_CATEGORY_NAME.toLowerCase(),
  );
  const id = match?.id;
  return typeof id === "number" && Number.isInteger(id) && id >= 1 ? id : null;
}

module.exports = {
  TWITCH_STARCRAFT_GAME_ID,
  KICK_CATEGORY_NAME,
  kickCategorySearchUrl,
  pickKickCategoryId,
};
