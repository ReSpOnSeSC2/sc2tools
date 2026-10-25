"use strict";

// Same case-insensitive first-letter semantics as gamesMatchStage's race filter.
// Non-string legacy values never count as a race or break the aggregation.
const initial = { $toUpper: { $substrCP: [
  { $cond: [{ $eq: [{ $type: "$opponent.race" }, "string"] }, "$opponent.race", ""] }, 0, 1,
] } };
const OPPONENT_RACE_GROUP = Object.fromEntries(["P", "T", "Z"].map(race => [
  `_opp${race}`, { $sum: { $cond: [{ $eq: [initial, race] }, 1, 0] } },
]));
const OPPONENT_RACE_PROJECT = { P: "$_oppP", T: "$_oppT", Z: "$_oppZ" };
module.exports = { OPPONENT_RACE_GROUP, OPPONENT_RACE_PROJECT };
