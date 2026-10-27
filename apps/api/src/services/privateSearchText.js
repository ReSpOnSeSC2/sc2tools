"use strict";

// Adapted from reviewed owner/_id proposal02 (6209087f...). No I/O or retained state.
const CONTROLS = /\p{Cc}/u;
/** @param {string} value */
const hasControls = value => CONTROLS.test(value);

/** @param {string} value */
function hasUnpairedSurrogates(value) {
  for (const point of value) {
    const first = point.charCodeAt(0);
    if (point.length === 1 && first >= 0xD800 && first <= 0xDFFF) return true;
  }
  return false;
}

/** @param {unknown} value @param {number} maximumUnits @param {boolean} [allowEmpty]
 * @returns {value is string} */
function validText(value, maximumUnits, allowEmpty = false) {
  return typeof value === "string" && (allowEmpty || value.length > 0)
    && value.length <= maximumUnits && !hasControls(value) && !hasUnpairedSurrogates(value);
}

/** @param {unknown} value @param {number} maximumUnits @returns {value is string} */
function validId(value, maximumUnits) {
  return validText(value, maximumUnits) && value !== "." && value !== "..";
}

module.exports = { hasControls, hasUnpairedSurrogates, validText, validId };
