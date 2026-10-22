"use strict";

/**
 * Read-side helpers for build check-ins on surfaces outside the custom-build
 * library (contract §5). The aggregation fragments live in
 * buildIntentShape.js; this module holds their query-filter and per-row JS
 * counterparts:
 *
 *   - owner game lists flag a row whose label comes from a check-in
 *     (``buildPlanned``) and name what the replay was classified as
 *     (``detectedBuild``). Notes never leave through these rows;
 *   - cross-user and coach-facing readers select rows by the detector's
 *     label (``detectorLabelMatch``) or project it (``DETECTOR_MY_BUILD_FIELD``);
 *   - build-shape readers keep only rows whose label agrees with the
 *     detector (``agreesWithDetector``, the JS mirror of
 *     ``AGREES_WITH_DETECTOR_MATCH``).
 */

const {
  OVERRIDE_ACTIVE_EXPR,
  detectorView,
  overrideActive,
} = require("./buildIntentShape");

/**
 * Query mirror of ``OVERRIDE_ACTIVE_EXPR``: a confirmed override is written
 * onto the row.
 */
const OVERRIDE_ACTIVE_QUERY = Object.freeze({
  "buildIntent.status": "confirmed",
  "buildIntent.applied": true,
  "buildIntent.build": { $type: "object" },
});

/**
 * ``$project``/``$addFields`` value for ``myBuild`` that swaps in the
 * detector's label on override rows. Unlike ``DETECTOR_BUILD_EXPR`` it keeps
 * a missing label missing (``$$REMOVE``) instead of turning it into null, so
 * a remapped copy of a row behaves exactly like the original under
 * ``$exists`` / ``$type`` filters.
 */
const DETECTOR_MY_BUILD_FIELD = Object.freeze({
  $cond: [
    OVERRIDE_ACTIVE_EXPR,
    {
      $cond: [
        { $eq: [{ $type: "$buildIntent.detected.name" }, "string"] },
        "$buildIntent.detected.name",
        "$$REMOVE",
      ],
    },
    "$myBuild",
  ],
});

/**
 * Query filter: rows whose detector label equals ``value``. Rows without an
 * override match on their stored label, override rows on
 * ``buildIntent.detected``. The plain-row branch keeps ``myBuild`` /
 * ``_customBuildSlug`` as an equality so a userId-prefixed index on that
 * field still serves it.
 *
 * Example: `detectorLabelMatch("slug", "dt-rush")` selects games the
 * classifier tagged with the custom build "dt-rush", whatever the player
 * checked in.
 *
 * @param {"name"|"slug"} field ``myBuild`` or ``_customBuildSlug``
 * @param {string|RegExp|Record<string, unknown>} value equality value, regex or operator object
 * @returns {Record<string, any>}
 */
function detectorLabelMatch(field, value) {
  const stored = field === "slug" ? "_customBuildSlug" : "myBuild";
  const detected = field === "slug" ? "buildIntent.detected.slug" : "buildIntent.detected.name";
  return {
    $or: [
      { [stored]: value, $nor: [OVERRIDE_ACTIVE_QUERY] },
      { ...OVERRIDE_ACTIVE_QUERY, [detected]: value },
    ],
  };
}

/**
 * JS mirror of ``AGREES_WITH_DETECTOR_MATCH``: true for every row without a
 * written override and for override rows whose replay landed on the
 * declared build anyway. Build-shape views (timings, phases) keep only
 * these rows.
 *
 * @param {any} row raw games row (``_customBuildSlug`` + ``buildIntent``)
 * @returns {boolean}
 */
function agreesWithDetector(row) {
  const intent = row && typeof row === "object" ? row.buildIntent : null;
  if (!intent || typeof intent !== "object" || intent.applied !== true) return true;
  const detected = intent.detected && typeof intent.detected === "object"
    ? intent.detected
    : {};
  return (row.myBuild ?? null) === (detected.name ?? null)
    && (row._customBuildSlug ?? null) === (detected.slug ?? null);
}

/**
 * Owner-list flags for one row: ``buildPlanned`` while a confirmed check-in
 * supplies the row's label, ``detectedBuild`` = the classifier's own label
 * then (null otherwise).
 *
 * @param {any} row a row projected with ``BUILD_INTENT_LABEL_PROJECTION``
 * @returns {{buildPlanned: boolean, detectedBuild: string|null}}
 */
function ownerBuildFlags(row) {
  if (!overrideActive(row)) return { buildPlanned: false, detectedBuild: null };
  return { buildPlanned: true, detectedBuild: detectorView(row).myBuild };
}

/**
 * Replace a row's ``buildIntent`` subdocument by the owner-list flags. The
 * subdocument itself (notes, suggestion cache, randomizer roll) never
 * reaches a list response.
 *
 * @param {Record<string, any>} row
 * @returns {Record<string, any>}
 */
function withOwnerBuildFlags(row) {
  /** @type {Record<string, any>} */
  const out = { ...row, ...ownerBuildFlags(row) };
  delete out.buildIntent;
  return out;
}

module.exports = {
  OVERRIDE_ACTIVE_QUERY,
  DETECTOR_MY_BUILD_FIELD,
  detectorLabelMatch,
  agreesWithDetector,
  ownerBuildFlags,
  withOwnerBuildFlags,
};
