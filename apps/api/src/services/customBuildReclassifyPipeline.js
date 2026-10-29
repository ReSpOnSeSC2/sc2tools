"use strict";

const { COLLECTIONS } = require("../config/constants");
const { expectedVersion } = require("../db/schemaVersioning");
const {
  OPP_OVERRIDE_SLUG_EXPR,
  OVERRIDE_SLUG_EXPR,
  intentDetectedOnOverride,
  unlessOppOverride,
  unlessOverride,
} = require("./buildIntentGuards");

const RECLASSIFY_LEASE_MS = 60 * 1000;

/** Convert legacy single-object staging into the current marker-array shape. */
function reclassifyMarkersExpression() {
  return {
    $cond: [
      { $isArray: "$_customBuildReclassify" },
      "$_customBuildReclassify",
      {
        $cond: [
          { $eq: [{ $type: "$_customBuildReclassify" }, "object"] },
          ["$_customBuildReclassify"],
          [],
        ],
      },
    ],
  };
}

/** @param {string} runId @param {"you"|"opponent"} [perspective] */
function reclassifyDecisionExpression(runId, perspective) {
  const condition = { $eq: ["$$marker.runId", runId] };
  const scopedCondition = perspective
    ? {
      $and: [
        condition,
        { $eq: [{ $ifNull: ["$$marker.perspective", "you"] }, perspective] },
      ],
    }
    : condition;
  return {
    $arrayElemAt: [
      {
        $filter: {
          input: reclassifyMarkersExpression(),
          as: "marker",
          cond: scopedCondition,
        },
      },
      0,
    ],
  };
}

/** @param {string} runId */
function remainingReclassifyMarkersExpression(runId) {
  return {
    $filter: {
      input: reclassifyMarkersExpression(),
      as: "marker",
      cond: { $ne: ["$$marker.runId", runId] },
    },
  };
}

/** Successful sequences retire older/equal verdicts, including crash residue.
 * @param {number} sequence */
function newerReclassifyMarkersExpression(sequence) {
  return {
    $filter: {
      input: reclassifyMarkersExpression(),
      as: "marker",
      cond: {
        $gt: [
          { $ifNull: ["$$marker.sequence", 0] },
          Math.max(0, Number(sequence) || 0),
        ],
      },
    },
  };
}

/** @param {string} runId @param {number} sequence
 * @param {"you"|"opponent"} perspective @param {any} currentValue
 * @param {any} desiredValue @param {any} [clearedValue] */
function sideValue(runId, sequence, perspective, currentValue, desiredValue, clearedValue = "$$REMOVE") {
  return {
    $let: {
      vars: { decision: reclassifyDecisionExpression(runId, perspective) },
      in: {
        $cond: [
          {
            $and: [
              { $eq: [{ $type: "$$decision" }, "object"] },
              {
                $gte: [
                  { $ifNull: ["$$decision.sequence", sequence] },
                  { $ifNull: ["$_customBuildClassificationSequence", 0] },
                ],
              },
            ],
          },
          {
            $cond: [
              { $eq: ["$$decision.action", "set"] },
              desiredValue,
              clearedValue,
            ],
          },
          currentValue,
        ],
      },
    },
  };
}

/** @param {string} runId @param {number} sequence */
function detectedIntent(runId, sequence) {
  return intentDetectedOnOverride({
    you: sideValue(runId, sequence, "you", "$buildIntent.detected", {
      name: { $ifNull: ["$$decision.desiredBuild", null] },
      slug: { $ifNull: ["$$decision.desiredSlug", null] },
    }, { name: null, slug: null }),
    opponent: sideValue(runId, sequence, "opponent", "$buildIntent.opponent.detected", {
      name: { $ifNull: ["$$decision.desiredBuild", null] },
      slug: { $ifNull: ["$$decision.desiredSlug", null] },
    }, { name: null, slug: null }),
  });
}

/** @param {string} runId @param {number} sequence */
function classificationSequence(runId, sequence) {
  return {
    $let: {
      vars: { decision: reclassifyDecisionExpression(runId) },
      in: {
        $cond: [
          {
            $and: [
              { $eq: [{ $type: "$$decision" }, "object"] },
              {
                $gte: [
                  { $ifNull: ["$$decision.sequence", sequence] },
                  { $ifNull: ["$_customBuildClassificationSequence", 0] },
                ],
              },
            ],
          },
          { $ifNull: ["$$decision.sequence", sequence] },
          "$_customBuildClassificationSequence",
        ],
      },
    },
  };
}

/** @param {any} remaining */
function retainMarkers(remaining) {
  return {
    $let: {
      vars: { remaining },
      in: {
        $cond: [
          { $gt: [{ $size: "$$remaining" }, 0] },
          "$$remaining",
          "$$REMOVE",
        ],
      },
    },
  };
}

/** The original whole-EOF projection. Declared overrides stay authoritative;
 * only detected labels, provenance, sequence and private staging are changed.
 * @param {string} runId @param {number} sequence */
function commitReclassifyRunPipeline(runId, sequence) {
  const safeSequence = Math.max(0, Number(sequence) || 0);
  return [{
    $set: {
      _schemaVersion: expectedVersion(COLLECTIONS.GAMES),
      myBuild: unlessOverride(
        "$buildIntent.build.name",
        sideValue(runId, safeSequence, "you", "$myBuild", "$$decision.desiredBuild"),
      ),
      _customBuildSlug: unlessOverride(
        OVERRIDE_SLUG_EXPR,
        sideValue(runId, safeSequence, "you", "$_customBuildSlug", "$$decision.desiredSlug"),
      ),
      buildIntent: detectedIntent(runId, safeSequence),
      "opponent.strategy": unlessOppOverride(
        "$buildIntent.opponent.build.name",
        sideValue(runId, safeSequence, "opponent", "$opponent.strategy", "$$decision.desiredBuild"),
      ),
      _customOpponentStrategySlug: unlessOppOverride(
        OPP_OVERRIDE_SLUG_EXPR,
        sideValue(runId, safeSequence, "opponent", "$_customOpponentStrategySlug", "$$decision.desiredSlug"),
      ),
      _customBuildClassificationSequence: classificationSequence(runId, safeSequence),
      _customBuildReclassify: retainMarkers(newerReclassifyMarkersExpression(safeSequence)),
    },
  }];
}

/** Failed/aborted work removes only its own private marker.
 * @param {string} runId */
function removeReclassifyRunPipeline(runId) {
  return [{
    $set: {
      _customBuildReclassify: retainMarkers(remainingReclassifyMarkersExpression(runId)),
    },
  }];
}

module.exports = { commitReclassifyRunPipeline, removeReclassifyRunPipeline, RECLASSIFY_LEASE_MS };
