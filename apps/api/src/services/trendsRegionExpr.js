"use strict";

/**
 * Pure MongoDB aggregation-expression builders shared by the Trends
 * "player insight" pipelines (MMR progression + net-MMR-by-matchup).
 * No DB access, no ``deps`` — just expression fragments — so they
 * live in their own tiny module and both callers import them rather
 * than one reaching into the other.
 */

const { REGION_HANDLE_PREFIX } = require("../util/regionFromToonHandle");

/**
 * Aggregation-pipeline mirror of ``regionFromToonHandle``: maps the
 * region segment of a toon handle (everything before the first "-")
 * to a Blizzard region label. Used so pairs only chain within the
 * same region — a region switch can't fake a thousand-MMR loss
 * anymore.
 *
 * The whole segment is compared, not its first character: the Public
 * Test Realm's ``98-`` handles must land in their own "PTR" bucket
 * instead of a "9" that falls into "U", and a stray ``12-`` handle
 * must not pass for NA. Branches come from the same
 * ``REGION_HANDLE_PREFIX`` table as the JS helper so the two can't
 * disagree on a label.
 *
 * Games whose ``myToonHandle`` is missing, not a string or starts
 * with an unknown segment fall into "U" so they still chain among
 * themselves (better than dropping every pre-myToonHandle game).
 *
 * @param {string} field MongoDB field expression, e.g. ``"$myToonHandle"``.
 */
function regionFromToonHandleExpr(field) {
  return {
    $let: {
      vars: {
        head: {
          $arrayElemAt: [
            {
              $split: [
                { $cond: [{ $eq: [{ $type: field }, "string"] }, field, ""] },
                "-",
              ],
            },
            0,
          ],
        },
      },
      in: {
        $switch: {
          branches: Object.entries(REGION_HANDLE_PREFIX).map(
            ([label, prefix]) => ({
              case: { $eq: ["$$head", prefix] },
              then: label,
            }),
          ),
          default: "U",
        },
      },
    },
  };
}

/**
 * Race field → single-letter bucket (P/T/Z/R/U) for grouping.
 *
 * @param {string|Record<string, any>} field MongoDB field expression.
 */
function raceLetterExpr(field) {
  return {
    $switch: {
      branches: [
        { case: raceFirstChar(field, "P"), then: "P" },
        { case: raceFirstChar(field, "T"), then: "T" },
        { case: raceFirstChar(field, "Z"), then: "Z" },
        { case: raceFirstChar(field, "R"), then: "R" },
      ],
      default: "U",
    },
  };
}

/** Opponent race → single-letter bucket (P/T/Z/R/U) for grouping. */
function oppRaceSwitch() {
  return raceLetterExpr("$opponent.race");
}

/**
 * Prefer the replay-authored selected ladder race. ``myRace`` is the
 * race actually spawned in the replay, which differs on Random queue.
 * Older rows predate ``myLadderRace`` and safely fall back to it.
 */
function myLadderRaceExpr() {
  return raceLetterExpr({ $ifNull: ["$myLadderRace", "$myRace"] });
}

/** @param {string} letter Upper-case race initial the $expr tests for. */
function oppRaceFirstChar(letter) {
  return raceFirstChar("$opponent.race", letter);
}

/** @param {string|Record<string, any>} field @param {string} letter */
function raceFirstChar(field, letter) {
  return {
    $eq: [
      { $toUpper: { $substrCP: [{ $ifNull: [field, ""] }, 0, 1] } },
      letter,
    ],
  };
}

module.exports = {
  regionFromToonHandleExpr,
  raceLetterExpr,
  myLadderRaceExpr,
  oppRaceSwitch,
  oppRaceFirstChar,
};
