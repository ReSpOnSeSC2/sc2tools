"use strict";

const { DETECTOR_BUILD_EXPR, DETECTOR_SLUG_EXPR } = require("./buildIntentShape");

/** @param {unknown} value */
const stringValue = value => ({ $cond: [{ $eq: [{ $type: value }, "string"] }, value, ""] });
const DECLARED_NAME = stringValue("$buildIntent.build.name");
const DECLARED_SLUG = stringValue("$buildIntent.build.slug");
const DETECTED_NAME = stringValue(DETECTOR_BUILD_EXPR);
const DETECTED_SLUG = stringValue(DETECTOR_SLUG_EXPR);

// A confirmed reference is the declared cohort. Performance still includes
// ordinary detected games; this predicate is used only inside the plan facet.
const PLAN_DECLARED_EXPR = Object.freeze({ $and: [
  { $eq: ["$buildIntent.status", "confirmed"] },
  { $eq: [{ $type: "$buildIntent.build" }, "object"] },
  { $ne: [DECLARED_NAME, ""] },
] });

// A stable custom identity wins over a mutable display name when both are
// recorded. Otherwise compare exact labels. Missing detection is explicitly
// "no different build recorded", not proof of successful execution/causality.
const PLAN_HELD_EXPR = Object.freeze({ $cond: [
  { $and: [{ $ne: [DECLARED_SLUG, ""] }, { $ne: [DETECTED_SLUG, ""] }] },
  { $eq: [DECLARED_SLUG, DETECTED_SLUG] },
  { $or: [
    { $and: [{ $eq: [DETECTED_NAME, ""] }, { $eq: [DETECTED_SLUG, ""] }] },
    { $eq: [DECLARED_NAME, DETECTED_NAME] },
  ] },
] });

/** Add to an existing grouped slim aggregation; no extra read or log hydration. */
function planGroupFields() {
  return {
    planDeclared: { $sum: { $cond: [PLAN_DECLARED_EXPR, 1, 0] } },
    planHeld: { $sum: { $cond: [{ $and: [PLAN_DECLARED_EXPR, PLAN_HELD_EXPR] }, 1, 0] } },
  };
}

/** @param {unknown} field */
function rankedLabels(field) {
  return [
    { $match: { _planHeld: false } },
    { $set: { _planLabel: stringValue(field) } },
    { $match: { _planLabel: { $ne: "" } } },
    { $group: { _id: "$_planLabel", count: { $sum: 1 } } },
    { $sort: { count: -1, _id: 1 } }, { $limit: 5 },
    { $project: { _id: 0, name: "$_id", count: 1 } },
  ];
}

/** Spread into an existing $facet. Mongo does not permit nested $facet stages.
 * Each branch reuses the same already-owner/visibility-scoped input stream.
 * @param {string} bucket existing normalized win/loss field */
function planFacets(bucket) {
  const prefix = [{ $match: { $expr: PLAN_DECLARED_EXPR } }, { $set: { _planHeld: PLAN_HELD_EXPR } }];
  const won = { $eq: [bucket, "win"] }, lost = { $eq: [bucket, "loss"] };
  /** @param {unknown} condition */
  const count = condition => ({ $sum: { $cond: [condition, 1, 0] } });
  const duration = { $and: [{ $isNumber: "$durationSec" }, { $gte: ["$durationSec", 0] }, { $lt: ["$durationSec", Infinity] }] };
  return {
    planTotals: [...prefix, { $group: { _id: null, declared: { $sum: 1 },
      held: count("$_planHeld"), knockedOff: count({ $not: ["$_planHeld"] }),
      heldWins: count({ $and: ["$_planHeld", won] }), heldLosses: count({ $and: ["$_planHeld", lost] }),
      knockedOffWins: count({ $and: [{ $not: ["$_planHeld"] }, won] }),
      knockedOffLosses: count({ $and: [{ $not: ["$_planHeld"] }, lost] }),
    } }],
    planKnockedInto: [...prefix, ...rankedLabels(DETECTOR_BUILD_EXPR)],
    planKnockedBy: [...prefix, ...rankedLabels("$opponent.strategy")],
    planDuration: [...prefix, { $match: { _planHeld: false } }, { $group: { _id: null,
      // Same Mongo7 approximate percentile pattern as existing personal
      // benchmarks; bounded accumulator, never an unbounded $push of games.
      median: { $percentile: { input: { $cond: [duration, "$durationSec", null] }, p: [0.5], method: "approximate" } },
      n: count(duration),
    } }],
  };
}

/** @param {unknown} value */
const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
/** @param {unknown} wins @param {unknown} losses */
const winRate = (wins, losses) => number(wins) + number(losses) ? number(wins) / (number(wins) + number(losses)) : null;
/** @param {Array<Record<string,any>>|undefined} rows */
const labels = rows => (rows || []).filter(row => typeof row.name === "string" && row.name.length > 0 && row.name.length <= 200)
  .slice(0, 5).map(row => ({ name: row.name, count: number(row.count) }));

/** @param {Record<string,any>|null|undefined} doc */
function finishPlan(doc) {
  const totals = doc?.planTotals?.[0] || {}, duration = doc?.planDuration?.[0] || {};
  const declared = number(totals.declared), held = number(totals.held);
  return { declared, held, knockedOff: number(totals.knockedOff), heldRate: declared ? held / declared : null,
    heldWR: winRate(totals.heldWins, totals.heldLosses), knockedOffWR: winRate(totals.knockedOffWins, totals.knockedOffLosses),
    heldDecided: number(totals.heldWins) + number(totals.heldLosses),
    knockedOffDecided: number(totals.knockedOffWins) + number(totals.knockedOffLosses),
    knockedInto: labels(doc?.planKnockedInto), knockedBy: labels(doc?.planKnockedBy),
    medianKnockedOffDurationSec: typeof duration.median?.[0] === "number" && Number.isFinite(duration.median[0]) ? duration.median[0] : null,
    durationSamples: number(duration.n), durationEstimated: true,
  };
}

/** Small samples stay unadvertised on list/card surfaces. @param {Record<string,any>} row */
function planHeldRate(row) {
  return number(row.planDeclared) >= 5 ? number(row.planHeld) / number(row.planDeclared) : null;
}

module.exports = { PLAN_DECLARED_EXPR, PLAN_HELD_EXPR, planGroupFields, planFacets, finishPlan, planHeldRate };
