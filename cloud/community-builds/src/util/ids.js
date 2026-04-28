"use strict";

const { ID_REGEX } = require("../constants");

const CLIENT_ID_REGEX = /^[a-f0-9]{16,128}$/i;

/**
 * True if the given string is a valid build id (kebab-case 3..80).
 *
 * @param {unknown} id
 * @returns {boolean}
 */
function isValidBuildId(id) {
  return typeof id === "string" && ID_REGEX.test(id);
}

/**
 * True if the given string looks like a client id (hex, 16..128 chars).
 *
 * @param {unknown} id
 * @returns {boolean}
 */
function isValidClientId(id) {
  return typeof id === "string" && CLIENT_ID_REGEX.test(id);
}

module.exports = { isValidBuildId, isValidClientId, CLIENT_ID_REGEX };
