"use strict";

/**
 * Writer guards for build check-ins: the custom-build classifier keeps
 * deciding the detector's "you" label while a confirmed check-in owns
 * ``myBuild``/``_customBuildSlug``.
 *
 * The ingest tagger and the reclassify commit both write through per-document
 * aggregation pipelines: on a row whose override is active at write time the
 * classifier's "you" outcome lands in ``buildIntent.detected`` and the
 * declared label stays; every other row gets exactly the plain classifier
 * write. Deciding per document (not from an earlier read) keeps a check-in
 * confirmed or cleared mid-classification consistent either way, because
 * ``applyOverridePipeline``/``clearOverridePipeline`` move the label between
 * the two places atomically. The opponent axis is never affected.
 */

const { COLLECTIONS } = require("../config/constants");
const { expectedVersion } = require("../db/schemaVersioning");
const { OVERRIDE_ACTIVE_EXPR } = require("./buildIntentShape");

/**
 * One axis' classifier decision: write a definition, drop the provenance
 * slug (the label stays), or leave the axis untouched.
 * @typedef {{mode: "set", name: string, slug: string} | {mode: "unset"} | {mode: "keep"}} AxisOutcome
 */

/** The declared slug as an override row stores it: custom → slug, catalog → removed. */
const OVERRIDE_SLUG_EXPR = Object.freeze({
  $cond: [
    {
      $and: [
        { $eq: ["$buildIntent.build.source", "custom"] },
        { $eq: [{ $type: "$buildIntent.build.slug" }, "string"] },
      ],
    },
    "$buildIntent.build.slug",
    "$$REMOVE",
  ],
});

/**
 * Query fragment: the row's detector-view "you" label is claimed by
 * ``slug``. Override rows match on ``buildIntent.detected.slug``, other rows
 * on ``_customBuildSlug``, so a staged clear can never match a declared slug
 * and still matches the detector's own stale claim.
 *
 * @param {string} slug
 * @returns {{$or: Array<Record<string, unknown>>}}
 */
function youClaimFilter(slug) {
  return {
    $or: [
      { "buildIntent.applied": true, "buildIntent.detected.slug": slug },
      { _customBuildSlug: slug, "buildIntent.applied": { $ne: true } },
    ],
  };
}

/**
 * Field expression: keep ``current`` on override rows, else ``classified``.
 * @param {unknown} current
 * @param {unknown} classified
 */
function unlessOverride(current, classified) {
  return { $cond: [OVERRIDE_ACTIVE_EXPR, current, classified] };
}

/**
 * ``buildIntent`` field expression: on override rows replace
 * ``buildIntent.detected`` with ``detected`` (whole-subdocument merge); other
 * rows keep ``buildIntent`` as is (a missing one stays missing).
 * @param {unknown} detected
 */
function detectedOnOverride(detected) {
  return {
    $cond: [
      OVERRIDE_ACTIVE_EXPR,
      { $mergeObjects: ["$buildIntent", { detected }] },
      "$buildIntent",
    ],
  };
}

/**
 * Revision-fenced ingest tagger write (``CustomBuildsService.tagSingleGame``).
 *
 * Plain rows: a "set" axis writes the definition's label and slug, "unset"
 * drops only the slug, "keep" leaves the axis alone. Override rows: the
 * declared build is (re)written onto ``myBuild``/``_customBuildSlug`` (a
 * re-upload just patched the agent's label over it) and the "you" outcome
 * goes to ``buildIntent.detected``, whose name falls back to the upload's
 * agent label (``payloadBuild``) or the previous detector name.
 *
 * Every inlined value is wrapped in ``$literal``.
 *
 * @param {{
 *   you: AxisOutcome,
 *   opponent: AxisOutcome,
 *   payloadBuild: string|null,
 *   clearStaging: boolean,
 * }} decision ``clearStaging`` drops reclassify staging + sequence (a
 *   definitive classification); false only restores a check-in's label
 * @returns {Array<Record<string, any>>}
 */
function tagClassificationPipeline(decision) {
  const { you, opponent, payloadBuild, clearStaging } = decision;
  const keptDetectedName = typeof payloadBuild === "string"
    ? { $literal: payloadBuild }
    : { $ifNull: ["$buildIntent.detected.name", null] };
  /** @type {Record<string, unknown>} */
  const detected = you.mode === "set"
    ? { name: { $literal: you.name }, slug: { $literal: you.slug } }
    : {
      name: keptDetectedName,
      slug: you.mode === "unset"
        ? null
        : { $ifNull: ["$buildIntent.detected.slug", null] },
    };
  /** @type {Record<string, unknown>} */
  const set = {
    _schemaVersion: expectedVersion(COLLECTIONS.GAMES),
    myBuild: unlessOverride(
      "$buildIntent.build.name",
      you.mode === "set" ? { $literal: you.name } : "$myBuild",
    ),
    _customBuildSlug: unlessOverride(
      OVERRIDE_SLUG_EXPR,
      you.mode === "set"
        ? { $literal: you.slug }
        : you.mode === "unset" ? "$$REMOVE" : "$_customBuildSlug",
    ),
    buildIntent: detectedOnOverride(detected),
  };
  if (opponent.mode === "set") {
    set["opponent.strategy"] = { $literal: opponent.name };
    set._customOpponentStrategySlug = { $literal: opponent.slug };
  } else if (opponent.mode === "unset") {
    set._customOpponentStrategySlug = "$$REMOVE";
  }
  return [
    { $set: set },
    ...(clearStaging
      ? [{ $unset: ["_customBuildReclassify", "_customBuildClassificationSequence"] }]
      : []),
  ];
}

module.exports = {
  OVERRIDE_SLUG_EXPR,
  youClaimFilter,
  unlessOverride,
  detectedOnOverride,
  tagClassificationPipeline,
};
