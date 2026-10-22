"use strict";

/**
 * Atomic writers for build check-in overrides on ``games`` rows.
 *
 * Every write is a single aggregation-pipeline update that reads its own
 * document, so a concurrent ingest tagger, reclassify commit or second
 * confirmation can never capture the declared label as the "detected" one.
 * None of these touch ``_customBuildRevision`` or the reclassify staging
 * fields: an in-flight ingest tagger must not be superseded by a check-in,
 * and staged reclassify decisions route through the commit pipeline's own
 * override guard whichever side of a check-in they land on.
 */

const { COLLECTIONS } = require("../config/constants");
const { expectedVersion } = require("../db/schemaVersioning");
const {
  OVERRIDE_ACTIVE_EXPR,
  OPP_OVERRIDE_ACTIVE_EXPR,
} = require("./buildIntentShape");

/**
 * @typedef {{key: string, name: string, slug: string|null, source: "catalog"|"custom"}} BuildRef
 */

const CAPTURE_DETECTED_EXPR = Object.freeze({
  $cond: [
    OVERRIDE_ACTIVE_EXPR,
    "$buildIntent.detected",
    {
      name: { $ifNull: ["$myBuild", null] },
      slug: { $ifNull: ["$_customBuildSlug", null] },
    },
  ],
});

/**
 * Pipeline that writes ``build`` as the row's effective label and merges
 * ``intentPatch`` into ``buildIntent``. ``detected`` is captured from the
 * row's current label only when no override was active, so changing a
 * confirmed build from A to B keeps the original detector label.
 *
 * ``build.name`` must already be era-normalised for this game
 * (util/poolBuildNames.js ``poolNameForGame``).
 *
 * @param {BuildRef} build
 * @param {Record<string, unknown>} intentPatch merged verbatim (``$literal``)
 * @returns {Array<Record<string, any>>}
 */
function applyOverridePipeline(build, intentPatch) {
  const customSlug = build.source === "custom" && typeof build.slug === "string"
    ? build.slug
    : null;
  return [{
    $set: {
      _schemaVersion: expectedVersion(COLLECTIONS.GAMES),
      myBuild: { $literal: build.name },
      _customBuildSlug: customSlug ? { $literal: customSlug } : "$$REMOVE",
      buildIntent: {
        $mergeObjects: [
          { $ifNull: ["$buildIntent", {}] },
          {
            $literal: {
              ...intentPatch,
              status: "confirmed",
              applied: true,
              build: { ...build },
            },
          },
          { detected: CAPTURE_DETECTED_EXPR },
        ],
      },
    },
  }];
}

/**
 * Pipeline that removes an active override (restoring the detector label
 * exactly: a missing detected field is unset, never left as the declared
 * one) and merges ``intentPatch``. Rows without an active override keep
 * their labels untouched. Use for "No set build", for demoting a
 * declaration, and for any intent change that must not count.
 *
 * @param {Record<string, unknown>} intentPatch merged verbatim (``$literal``)
 * @returns {Array<Record<string, any>>}
 */
function clearOverridePipeline(intentPatch) {
  const restore = (/** @type {string} */ field, /** @type {string} */ current) => ({
    $cond: [
      OVERRIDE_ACTIVE_EXPR,
      {
        $cond: [
          { $eq: [{ $type: field }, "string"] },
          field,
          "$$REMOVE",
        ],
      },
      current,
    ],
  });
  return [{
    $set: {
      _schemaVersion: expectedVersion(COLLECTIONS.GAMES),
      myBuild: restore("$buildIntent.detected.name", "$myBuild"),
      _customBuildSlug: restore("$buildIntent.detected.slug", "$_customBuildSlug"),
      buildIntent: {
        $mergeObjects: [
          { $ifNull: ["$buildIntent", {}] },
          { $literal: { ...intentPatch, applied: false, detected: null } },
        ],
      },
    },
  }];
}

/**
 * Pipeline that merges ``intentPatch`` into ``buildIntent`` without touching
 * the effective label (notes, defer, suggestion cache, a confirmation that
 * must not apply). Callers must not use it to change ``status``/``build``
 * of an applied override; use the two pipelines above for that.
 *
 * @param {Record<string, unknown>} intentPatch merged verbatim (``$literal``)
 * @returns {Array<Record<string, any>>}
 */
function mergeIntentPipeline(intentPatch) {
  return [{
    $set: {
      _schemaVersion: expectedVersion(COLLECTIONS.GAMES),
      buildIntent: {
        $mergeObjects: [
          { $ifNull: ["$buildIntent", {}] },
          { $literal: intentPatch },
        ],
      },
    },
  }];
}

/**
 * Keep override rows in step with a renamed custom build. Name-keyed stats
 * (``/v1/builds``, MMR, trends, overlay) would otherwise split the build
 * into an old-name row. When the replay itself matched the build
 * (``detected.slug === slug``) the detected name follows too, so a game
 * that ran the build never starts counting as a check-in. Served by the
 * ``{userId, _customBuildSlug, date}`` index.
 *
 * @param {import("mongodb").Collection} games
 * @param {string} userId
 * @param {string} slug
 * @param {string} newName
 * @returns {Promise<number>} rows renamed
 */
async function renameCustomOverrides(games, userId, slug, newName) {
  const name = { $literal: newName };
  const res = await games.updateMany(
    {
      userId,
      _customBuildSlug: slug,
      "buildIntent.applied": true,
      "buildIntent.build.source": "custom",
      "buildIntent.build.slug": slug,
    },
    [{
      $set: {
        myBuild: name,
        "buildIntent.build.name": name,
        "buildIntent.detected.name": {
          $cond: [
            { $eq: ["$buildIntent.detected.slug", { $literal: slug }] },
            name,
            { $ifNull: ["$buildIntent.detected.name", null] },
          ],
        },
      },
    }],
  );
  return res.modifiedCount || 0;
}

const CAPTURE_OPP_DETECTED_EXPR = Object.freeze({
  $cond: [
    OPP_OVERRIDE_ACTIVE_EXPR,
    "$buildIntent.opponent.detected",
    {
      name: { $ifNull: ["$opponent.strategy", null] },
      slug: { $ifNull: ["$_customOpponentStrategySlug", null] },
    },
  ],
});

/**
 * Opponent-axis twin of ``applyOverridePipeline``: writes ``build`` onto
 * ``opponent.strategy`` / ``_customOpponentStrategySlug`` and merges
 * ``intentPatch`` into ``buildIntent.opponent``. Stage arrays concatenate,
 * so ``[...applyOverridePipeline(a, p), ...applyOpponentOverridePipeline(b, q)]``
 * is one atomic update.
 *
 * @param {BuildRef} build name already era-normalised for this game
 * @param {Record<string, unknown>} intentPatch merged verbatim (``$literal``)
 * @returns {Array<Record<string, any>>}
 */
function applyOpponentOverridePipeline(build, intentPatch) {
  const customSlug = build.source === "custom" && typeof build.slug === "string"
    ? build.slug
    : null;
  return [{
    $set: {
      _schemaVersion: expectedVersion(COLLECTIONS.GAMES),
      "opponent.strategy": { $literal: build.name },
      _customOpponentStrategySlug: customSlug ? { $literal: customSlug } : "$$REMOVE",
      buildIntent: {
        $mergeObjects: [
          { $ifNull: ["$buildIntent", {}] },
          {
            opponent: {
              $mergeObjects: [
                { $ifNull: ["$buildIntent.opponent", {}] },
                {
                  $literal: {
                    ...intentPatch,
                    status: "confirmed",
                    applied: true,
                    build: { ...build },
                  },
                },
                { detected: CAPTURE_OPP_DETECTED_EXPR },
              ],
            },
          },
        ],
      },
    },
  }];
}

/**
 * Opponent-axis twin of ``clearOverridePipeline``: restores the detector's
 * opponent label exactly (unset when it had none) and merges
 * ``intentPatch`` into ``buildIntent.opponent``.
 *
 * @param {Record<string, unknown>} intentPatch merged verbatim (``$literal``)
 * @returns {Array<Record<string, any>>}
 */
function clearOpponentOverridePipeline(intentPatch) {
  const restore = (/** @type {string} */ field, /** @type {string} */ current) => ({
    $cond: [
      OPP_OVERRIDE_ACTIVE_EXPR,
      {
        $cond: [
          { $eq: [{ $type: field }, "string"] },
          field,
          "$$REMOVE",
        ],
      },
      current,
    ],
  });
  return [{
    $set: {
      _schemaVersion: expectedVersion(COLLECTIONS.GAMES),
      "opponent.strategy": restore("$buildIntent.opponent.detected.name", "$opponent.strategy"),
      _customOpponentStrategySlug: restore(
        "$buildIntent.opponent.detected.slug",
        "$_customOpponentStrategySlug",
      ),
      buildIntent: {
        $mergeObjects: [
          { $ifNull: ["$buildIntent", {}] },
          {
            opponent: {
              $mergeObjects: [
                { $ifNull: ["$buildIntent.opponent", {}] },
                { $literal: { ...intentPatch, applied: false, detected: null } },
              ],
            },
          },
        ],
      },
    },
  }];
}

/**
 * Merge ``intentPatch`` into ``buildIntent.opponent`` without touching the
 * opponent label.
 *
 * @param {Record<string, unknown>} intentPatch merged verbatim (``$literal``)
 * @returns {Array<Record<string, any>>}
 */
function mergeOpponentIntentPipeline(intentPatch) {
  return [{
    $set: {
      _schemaVersion: expectedVersion(COLLECTIONS.GAMES),
      buildIntent: {
        $mergeObjects: [
          { $ifNull: ["$buildIntent", {}] },
          {
            opponent: {
              $mergeObjects: [
                { $ifNull: ["$buildIntent.opponent", {}] },
                { $literal: intentPatch },
              ],
            },
          },
        ],
      },
    },
  }];
}

/**
 * Opponent-axis twin of ``renameCustomOverrides`` for renamed
 * opponent-perspective custom builds. Served by the
 * ``{userId, _customOpponentStrategySlug, date}`` index.
 *
 * @param {import("mongodb").Collection} games
 * @param {string} userId
 * @param {string} slug
 * @param {string} newName
 * @returns {Promise<number>} rows renamed
 */
async function renameCustomOpponentOverrides(games, userId, slug, newName) {
  const name = { $literal: newName };
  const res = await games.updateMany(
    {
      userId,
      _customOpponentStrategySlug: slug,
      "buildIntent.opponent.applied": true,
      "buildIntent.opponent.build.source": "custom",
      "buildIntent.opponent.build.slug": slug,
    },
    [{
      $set: {
        "opponent.strategy": name,
        "buildIntent.opponent.build.name": name,
        "buildIntent.opponent.detected.name": {
          $cond: [
            { $eq: ["$buildIntent.opponent.detected.slug", { $literal: slug }] },
            name,
            { $ifNull: ["$buildIntent.opponent.detected.name", null] },
          ],
        },
      },
    }],
  );
  return res.modifiedCount || 0;
}

module.exports = {
  applyOverridePipeline,
  clearOverridePipeline,
  mergeIntentPipeline,
  renameCustomOverrides,
  applyOpponentOverridePipeline,
  clearOpponentOverridePipeline,
  mergeOpponentIntentPipeline,
  renameCustomOpponentOverrides,
};
