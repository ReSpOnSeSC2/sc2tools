"use strict";

/**
 * Writer guards for build check-ins: the custom-build classifier keeps
 * deciding the detector's labels while a confirmed check-in owns
 * ``myBuild``/``_customBuildSlug`` ("you" axis) or a confirmed opponent
 * correction owns ``opponent.strategy``/``_customOpponentStrategySlug``
 * (opponent axis).
 *
 * The ingest tagger and the reclassify commit both write through per-document
 * aggregation pipelines: on a row whose override is active at write time the
 * classifier's outcome for that axis lands in ``buildIntent.detected`` (or
 * ``buildIntent.opponent.detected``) and the declared label stays; every
 * other row gets exactly the plain classifier write. Deciding per document
 * (not from an earlier read) keeps a check-in confirmed or cleared
 * mid-classification consistent either way, because the attribution
 * pipelines move the label between the two places atomically. The axes are
 * independent: either, both or neither may carry an override.
 */

const { COLLECTIONS } = require("../config/constants");
const { expectedVersion } = require("../db/schemaVersioning");
const {
  OVERRIDE_ACTIVE_EXPR,
  OPP_OVERRIDE_ACTIVE_EXPR,
} = require("./buildIntentShape");

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

/** Opponent-axis twin of ``OVERRIDE_SLUG_EXPR``. */
const OPP_OVERRIDE_SLUG_EXPR = Object.freeze({
  $cond: [
    {
      $and: [
        { $eq: ["$buildIntent.opponent.build.source", "custom"] },
        { $eq: [{ $type: "$buildIntent.opponent.build.slug" }, "string"] },
      ],
    },
    "$buildIntent.opponent.build.slug",
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
 * Opponent-axis twin of ``youClaimFilter``: matches the detector's
 * ``_customOpponentStrategySlug`` claim, never a declared opponent build.
 *
 * @param {string} slug
 * @returns {{$or: Array<Record<string, unknown>>}}
 */
function opponentClaimFilter(slug) {
  return {
    $or: [
      { "buildIntent.opponent.applied": true, "buildIntent.opponent.detected.slug": slug },
      { _customOpponentStrategySlug: slug, "buildIntent.opponent.applied": { $ne: true } },
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
 * Field expression: ``declared`` on opponent-correction rows, else
 * ``classified``.
 * @param {unknown} declared
 * @param {unknown} classified
 */
function unlessOppOverride(declared, classified) {
  return { $cond: [OPP_OVERRIDE_ACTIVE_EXPR, declared, classified] };
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
 * ``buildIntent`` field expression for both axes in one ``$set``: each axis
 * whose override is active gets its ``detected`` replaced (whole
 * subdocument); a row without any active override keeps ``buildIntent`` as
 * is (a missing one stays missing). Every operand reads the pre-update row.
 * @param {{you: unknown, opponent: unknown}} detected
 */
function intentDetectedOnOverride(detected) {
  return {
    $cond: [
      { $or: [OVERRIDE_ACTIVE_EXPR, OPP_OVERRIDE_ACTIVE_EXPR] },
      {
        $mergeObjects: [
          "$buildIntent",
          { $cond: [OVERRIDE_ACTIVE_EXPR, { detected: detected.you }, {}] },
          {
            $cond: [
              OPP_OVERRIDE_ACTIVE_EXPR,
              {
                opponent: {
                  $mergeObjects: ["$buildIntent.opponent", { detected: detected.opponent }],
                },
              },
              {},
            ],
          },
        ],
      },
      "$buildIntent",
    ],
  };
}

/**
 * ``opponent`` field expression that restores a declared opponent build
 * without touching any other row: the whole subdocument is re-set, so a row
 * without ``opponent`` never gains an empty one (a dotted
 * ``"opponent.strategy"`` write would create it).
 */
const RESTORE_DECLARED_OPPONENT_EXPR = Object.freeze({
  $cond: [
    OPP_OVERRIDE_ACTIVE_EXPR,
    { $mergeObjects: ["$opponent", { strategy: "$buildIntent.opponent.build.name" }] },
    "$opponent",
  ],
});

/**
 * The detector label an axis records on an override row.
 * @param {AxisOutcome} outcome
 * @param {string|null} payloadLabel the upload's agent label for the axis
 * @param {string} detectedPath e.g. ``"$buildIntent.detected"``
 */
function detectedOutcome(outcome, payloadLabel, detectedPath) {
  if (outcome.mode === "set") {
    return { name: { $literal: outcome.name }, slug: { $literal: outcome.slug } };
  }
  return {
    name: typeof payloadLabel === "string"
      ? { $literal: payloadLabel }
      : { $ifNull: [`${detectedPath}.name`, null] },
    slug: outcome.mode === "unset"
      ? null
      : { $ifNull: [`${detectedPath}.slug`, null] },
  };
}

/**
 * Revision-fenced ingest tagger write (``CustomBuildsService.tagSingleGame``).
 *
 * Plain rows (per axis): a "set" axis writes the definition's label and
 * slug, "unset" drops only the slug, "keep" leaves the axis alone. Override
 * rows (per axis): the declared build is (re)written onto the axis' label
 * and slug (a re-upload just patched the agent's label over it) and the
 * axis' outcome goes to its ``detected``, whose name falls back to the
 * upload's agent label (``payloadBuild`` / ``payloadStrategy``) or the
 * previous detector name.
 *
 * Every inlined value is wrapped in ``$literal``.
 *
 * @param {{
 *   you: AxisOutcome,
 *   opponent: AxisOutcome,
 *   payloadBuild: string|null,
 *   payloadStrategy?: string|null,
 *   clearStaging: boolean,
 * }} decision ``clearStaging`` drops reclassify staging + sequence (a
 *   definitive classification); false only restores a check-in's label
 * @returns {Array<Record<string, any>>}
 */
function tagClassificationPipeline(decision) {
  const { you, opponent, payloadBuild, clearStaging } = decision;
  const payloadStrategy = typeof decision.payloadStrategy === "string"
    ? decision.payloadStrategy
    : null;
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
    _customOpponentStrategySlug: unlessOppOverride(
      OPP_OVERRIDE_SLUG_EXPR,
      opponent.mode === "set"
        ? { $literal: opponent.slug }
        : opponent.mode === "unset" ? "$$REMOVE" : "$_customOpponentStrategySlug",
    ),
    buildIntent: intentDetectedOnOverride({
      you: detectedOutcome(you, payloadBuild, "$buildIntent.detected"),
      opponent: detectedOutcome(opponent, payloadStrategy, "$buildIntent.opponent.detected"),
    }),
  };
  if (opponent.mode === "set") {
    set["opponent.strategy"] = unlessOppOverride(
      "$buildIntent.opponent.build.name",
      { $literal: opponent.name },
    );
  } else {
    set.opponent = RESTORE_DECLARED_OPPONENT_EXPR;
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
  OPP_OVERRIDE_SLUG_EXPR,
  youClaimFilter,
  opponentClaimFilter,
  unlessOverride,
  unlessOppOverride,
  detectedOnOverride,
  intentDetectedOnOverride,
  tagClassificationPipeline,
};
