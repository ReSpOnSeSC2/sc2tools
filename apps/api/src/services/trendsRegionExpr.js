"use strict";

/**
 * Pure MongoDB aggregation-expression builders shared by the Trends
 * "player insight" pipelines (MMR progression + net-MMR-by-matchup).
 * No DB access, no ``deps`` — just expression fragments — so they
 * live in their own tiny module and both callers import them rather
 * than one reaching into the other.
 */

/**
 * Aggregation-pipeline mirror of ``regionFromToonHandle``: maps the
 * leading byte of a toon handle to a Blizzard region label. Used so
 * pairs only chain within the same region — a region switch can't
 * fake a thousand-MMR loss anymore.
 *
 * Games whose ``myToonHandle`` is missing or starts with an unknown
 * byte fall into "U" so they still chain among themselves (better
 * than dropping every pre-myToonHandle game).
 *
 * @param {string} field MongoDB field expression, e.g. ``"$myToonHandle"``.
 */
function regionFromToonHandleExpr(field) {
  return {
    $let: {
      vars: {
        head: { $substrCP: [{ $ifNull: [field, ""] }, 0, 1] },
      },
      in: {
        $switch: {
          branches: [
            { case: { $eq: ["$$head", "1"] }, then: "NA" },
            { case: { $eq: ["$$head", "2"] }, then: "EU" },
            { case: { $eq: ["$$head", "3"] }, then: "KR" },
            { case: { $eq: ["$$head", "5"] }, then: "CN" },
            { case: { $eq: ["$$head", "6"] }, then: "SEA" },
          ],
          default: "U",
        },
      },
    },
  };
}

/** Opponent race → single-letter bucket (P/T/Z/R/U) for grouping. */
function oppRaceSwitch() {
  return {
    $switch: {
      branches: [
        { case: oppRaceFirstChar("P"), then: "P" },
        { case: oppRaceFirstChar("T"), then: "T" },
        { case: oppRaceFirstChar("Z"), then: "Z" },
        { case: oppRaceFirstChar("R"), then: "R" },
      ],
      default: "U",
    },
  };
}

/** @param {string} letter Upper-case race initial the $expr tests for. */
function oppRaceFirstChar(letter) {
  return {
    $eq: [
      { $toUpper: { $substrCP: [{ $ifNull: ["$opponent.race", ""] }, 0, 1] } },
      letter,
    ],
  };
}

module.exports = {
  regionFromToonHandleExpr,
  oppRaceSwitch,
  oppRaceFirstChar,
};
