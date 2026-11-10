"use strict";

/**
 * Strict Semantic Versioning 2.0.0 for reported analysis versions.
 *
 * Deliberately separate from services/agentVersion.compareVersions, which
 * treats invalid input as equal and ignores prerelease tags. Here anything
 * that is not canonical SemVer (leading zeros, missing parts, more than the
 * 40 characters ingest accepts) parses to null so callers count it as
 * unknown. Precedence follows the spec: numeric identifiers compare as exact
 * decimal strings (no Number rounding past 2^53), a release outranks its
 * prereleases, and build metadata is ignored.
 *
 * Example: compareStrictSemver("1.6.11-rc.1", "1.6.11") === -1
 */

const MAX_LENGTH = 40;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const DIGITS = /^[0-9]+$/;

/**
 * Same strict grammar, for Mongo `$regexMatch` (prerelease numerics without
 * leading zeros are enforced in the pattern itself there).
 */
const STRICT_SEMVER_PATTERN =
  "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)"
  + "(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?"
  + "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$";

/**
 * @typedef {{core: [string, string, string], prerelease: string[]}} StrictSemver
 */

/**
 * @param {unknown} value
 * @returns {StrictSemver|null}
 */
function parseStrictSemver(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LENGTH) return null;
  const match = SEMVER.exec(value);
  if (!match) return null;
  const prerelease = match[4] === undefined ? [] : match[4].split(".");
  if (prerelease.some((id) => DIGITS.test(id) && id.length > 1 && id[0] === "0")) return null;
  return { core: [match[1], match[2], match[3]], prerelease };
}

/**
 * Canonical decimal strings: longer is larger, equal length compares lexically.
 * @param {string} a @param {string} b
 */
function compareDecimal(a, b) {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

/** @param {string} a @param {string} b */
function compareIdentifier(a, b) {
  const numericA = DIGITS.test(a);
  const numericB = DIGITS.test(b);
  if (numericA && numericB) return compareDecimal(a, b);
  if (numericA !== numericB) return numericA ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

/** @param {unknown} value @returns {value is StrictSemver} */
function isParsed(value) {
  return Boolean(value) && typeof value === "object" && Array.isArray(/** @type {any} */ (value).core)
    && Array.isArray(/** @type {any} */ (value).prerelease);
}

/**
 * @param {StrictSemver|string|unknown} left
 * @param {StrictSemver|string|unknown} right
 * @returns {-1|0|1|null} null when either side is not strict SemVer
 */
function compareStrictSemver(left, right) {
  const a = isParsed(left) ? left : parseStrictSemver(left);
  const b = isParsed(right) ? right : parseStrictSemver(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    const order = compareDecimal(a.core[index], b.core[index]);
    if (order !== 0) return /** @type {-1|1} */ (order);
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }
  const shared = Math.min(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < shared; index += 1) {
    const order = compareIdentifier(a.prerelease[index], b.prerelease[index]);
    if (order !== 0) return /** @type {-1|1} */ (order);
  }
  if (a.prerelease.length === b.prerelease.length) return 0;
  return a.prerelease.length < b.prerelease.length ? -1 : 1;
}

module.exports = { parseStrictSemver, compareStrictSemver, STRICT_SEMVER_PATTERN, STRICT_SEMVER_MAX_LENGTH: MAX_LENGTH };
