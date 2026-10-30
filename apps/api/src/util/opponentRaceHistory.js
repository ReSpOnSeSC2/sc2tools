"use strict";

const OPPONENT_RACES = ["P", "T", "Z", "R"];
// Canonicalize before $addToSet so legacy spellings and malformed values
// cannot grow the per-account history beyond four races plus null.
const OPPONENT_RACE_LETTER = {
  $let: {
    vars: {
      letter: { $toUpper: { $substrCP: [
        { $trim: { input: { $cond: [
          { $eq: [{ $type: "$opponent.race" }, "string"] }, "$opponent.race", "",
        ] } } }, 0, 1,
      ] } },
    },
    in: { $cond: [{ $in: ["$$letter", OPPONENT_RACES] }, "$$letter", null] },
  },
};

module.exports = { OPPONENT_RACES, OPPONENT_RACE_LETTER };
