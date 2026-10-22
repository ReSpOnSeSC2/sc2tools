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
 *
 * Every helper has an opponent-axis twin (``opponent`` / ``OPP_`` prefix)
 * for a corrected opponent build on ``opponent.strategy`` /
 * ``_customOpponentStrategySlug`` (owner flags ``oppStrategyPlanned`` /
 * ``detectedOppStrategy``).
 */

const {
  OVERRIDE_ACTIVE_EXPR,
  OPP_OVERRIDE_ACTIVE_EXPR,
  detectorView,
  opponentDetectorView,
  opponentOverrideActive,
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

/** Query mirror of ``OPP_OVERRIDE_ACTIVE_EXPR``. */
const OPP_OVERRIDE_ACTIVE_QUERY = Object.freeze({
  "buildIntent.opponent.status": "confirmed",
  "buildIntent.opponent.applied": true,
  "buildIntent.opponent.build": { $type: "object" },
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
 * Opponent-axis twin of ``DETECTOR_MY_BUILD_FIELD``: a value for
 * ``"opponent.strategy"`` (missing stays missing).
 */
const DETECTOR_OPP_STRATEGY_FIELD = Object.freeze({
  $cond: [
    OPP_OVERRIDE_ACTIVE_EXPR,
    {
      $cond: [
        { $eq: [{ $type: "$buildIntent.opponent.detected.name" }, "string"] },
        "$buildIntent.opponent.detected.name",
        "$$REMOVE",
      ],
    },
    "$opponent.strategy",
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
 * Opponent-axis twin of ``detectorLabelMatch``: rows whose classifier
 * opponent label (``opponent.strategy`` / ``_customOpponentStrategySlug``)
 * equals ``value``, whatever opponent build the player corrected it to.
 *
 * @param {"name"|"slug"} field
 * @param {string|RegExp|Record<string, unknown>} value equality value, regex or operator object
 * @returns {Record<string, any>}
 */
function opponentDetectorLabelMatch(field, value) {
  const stored = field === "slug" ? "_customOpponentStrategySlug" : "opponent.strategy";
  const detected = field === "slug"
    ? "buildIntent.opponent.detected.slug"
    : "buildIntent.opponent.detected.name";
  return {
    $or: [
      { [stored]: value, $nor: [OPP_OVERRIDE_ACTIVE_QUERY] },
      { ...OPP_OVERRIDE_ACTIVE_QUERY, [detected]: value },
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
 * JS mirror of ``OPP_AGREES_WITH_DETECTOR_MATCH``: true for every row
 * without a written opponent correction and for corrected rows whose
 * replay was classified as the declared opponent build anyway.
 *
 * @param {any} row raw games row (``_customOpponentStrategySlug`` + ``buildIntent``)
 * @returns {boolean}
 */
function opponentAgreesWithDetector(row) {
  const intent = row && typeof row === "object" ? row.buildIntent : null;
  const opp = intent && typeof intent === "object" ? intent.opponent : null;
  if (!opp || typeof opp !== "object" || opp.applied !== true) return true;
  const detected = opp.detected && typeof opp.detected === "object" ? opp.detected : {};
  const opponent = row.opponent && typeof row.opponent === "object" ? row.opponent : {};
  return (opponent.strategy ?? null) === (detected.name ?? null)
    && (row._customOpponentStrategySlug ?? null) === (detected.slug ?? null);
}

/**
 * @typedef {object} OwnerBuildFlags
 * @property {boolean} buildPlanned a confirmed check-in supplies ``myBuild``
 * @property {string|null} detectedBuild the classifier's ``myBuild`` then
 * @property {boolean} oppStrategyPlanned a confirmed opponent correction
 *   supplies ``opponent.strategy``
 * @property {string|null} detectedOppStrategy the classifier's opponent label then
 */

/**
 * Owner-list flags for one row, per axis: ``buildPlanned`` /
 * ``oppStrategyPlanned`` while a confirmed check-in supplies the label,
 * ``detectedBuild`` / ``detectedOppStrategy`` = the classifier's own label
 * then (null otherwise).
 *
 * @param {any} row a row projected with ``BUILD_INTENT_LABEL_PROJECTION``
 *   and ``OPP_INTENT_LABEL_PROJECTION``
 * @returns {OwnerBuildFlags}
 */
function ownerBuildFlags(row) {
  const you = overrideActive(row);
  const opp = opponentOverrideActive(row);
  return {
    buildPlanned: you,
    detectedBuild: you ? detectorView(row).myBuild : null,
    oppStrategyPlanned: opp,
    detectedOppStrategy: opp ? opponentDetectorView(row).strategy : null,
  };
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
  OPP_OVERRIDE_ACTIVE_QUERY,
  DETECTOR_MY_BUILD_FIELD,
  DETECTOR_OPP_STRATEGY_FIELD,
  detectorLabelMatch,
  opponentDetectorLabelMatch,
  agreesWithDetector,
  opponentAgreesWithDetector,
  ownerBuildFlags,
  withOwnerBuildFlags,
};
