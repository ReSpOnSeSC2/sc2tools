"use strict";

/**
 * Player-name normalisation shared by every comparison between a live
 * envelope's names (raw ``/game`` names, possibly clan-tagged and carrying a
 * BattleTag discriminator) and a replay's ``opponent.displayName`` (clan tag
 * already stripped by the agent's ``_sanitize_name``).
 */

const LEADING_CLAN_TAG_RE = /^\s*\[[^\]]*\]\s*/u;
const TRAILING_DISCRIMINATOR_RE = /#\d+$/u;

/**
 * NFC, strip one leading ``[TAG]`` clan tag and the spaces around it, strip a
 * trailing ``#1234`` discriminator, trim, lowercase.
 *
 * Example: `normalizePlayerName(" [oM]Cure#123 ")` → "cure".
 *
 * @param {unknown} value
 * @returns {string} "" for non-strings and blank names
 */
function normalizePlayerName(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFC")
    .replace(LEADING_CLAN_TAG_RE, "")
    .trim()
    .replace(TRAILING_DISCRIMINATOR_RE, "")
    .trim()
    .toLowerCase();
}

module.exports = { normalizePlayerName };
