"use strict";

/**
 * Pure Mongo expression builders shared by the coaching services: the
 * qualifying 1v1 clause, a game's start time, and the normalized result
 * and race letters the coaching aggregations group by.
 */

function assignmentGameStartExpression() {
  const exactStart = {
    $convert: { input: "$startedAt", to: "date", onError: null, onNull: null },
  };
  const end = {
    $convert: { input: "$date", to: "date", onError: null, onNull: null },
  };
  const duration = {
    $convert: { input: "$durationSec", to: "int", onError: null, onNull: null },
  };
  return {
    $ifNull: [
      exactStart,
      {
        $cond: [
          {
            $and: [
              { $ne: [end, null] },
              { $ne: [duration, null] },
              { $gte: [duration, 0] },
              { $lte: [duration, 86_400] },
            ],
          },
          { $dateSubtract: { startDate: end, unit: "second", amount: duration } },
          end,
        ],
      },
    ],
  };
}

function oneVsOneGameClause() {
  return {
    $or: [
      { matchFormat: "1v1" },
      { matchFormat: { $exists: false }, playerCount: 2 },
    ],
  };
}

/** @returns {Record<string, any>} */
function coachingResultExpr() {
  return {
    $switch: {
      branches: [
        {
          case: {
            $in: [
              { $toLower: { $ifNull: ["$result", ""] } },
              ["victory", "win"],
            ],
          },
          then: "win",
        },
        {
          case: {
            $in: [
              { $toLower: { $ifNull: ["$result", ""] } },
              ["defeat", "loss"],
            ],
          },
          then: "loss",
        },
      ],
      default: "other",
    },
  };
}

/** @param {string} field @returns {Record<string, any>} */
function coachingRaceExpr(field) {
  const firstLetter = {
    $toUpper: {
      $substrCP: [
        {
          $convert: {
            input: field,
            to: "string",
            onError: "",
            onNull: "",
          },
        },
        0,
        1,
      ],
    },
  };
  return {
    $switch: {
      branches: [
        { case: { $eq: [firstLetter, "P"] }, then: "P" },
        { case: { $eq: [firstLetter, "T"] }, then: "T" },
        { case: { $eq: [firstLetter, "Z"] }, then: "Z" },
      ],
      default: "U",
    },
  };
}

module.exports = {
  assignmentGameStartExpression,
  oneVsOneGameClause,
  coachingResultExpr,
  coachingRaceExpr,
};
