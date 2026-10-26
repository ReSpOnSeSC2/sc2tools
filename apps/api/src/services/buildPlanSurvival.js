"use strict";

const { DETECTOR_BUILD_EXPR, DETECTOR_SLUG_EXPR } = require("./buildIntentShape");

/** @param {unknown} value */
const stringValue = value => ({ $cond: [{ $eq: [{ $type: value }, "string"] }, value, ""] });
const DECLARED_NAME = stringValue("$buildIntent.build.name");
const DECLARED_SLUG = stringValue("$buildIntent.build.slug");
const DETECTED_NAME = stringValue(DETECTOR_BUILD_EXPR);
const DETECTED_SLUG = stringValue(DETECTOR_SLUG_EXPR);
/** @param {unknown} name @param {unknown} slug */
const sameReference = (name, slug) => ({ $cond: [
  { $and: [{ $ne: [DECLARED_SLUG, ""] }, { $ne: [slug, ""] }] },
  { $eq: [DECLARED_SLUG, slug] }, { $eq: [DECLARED_NAME, name] },
] });

// A confirmed reference is the declared cohort. Performance still includes
// ordinary detected games; this predicate is used only inside the plan facet.
const PLAN_DECLARED_EXPR = Object.freeze({ $and: [
  { $eq: ["$buildIntent.status", "confirmed"] },
  { $eq: [{ $type: "$buildIntent.build" }, "object"] },
  { $ne: [DECLARED_NAME, ""] },
  // Too-short games can hold an unapplied confirmed answer while their
  // effective label still names another build. Never attribute that answer
  // to the different build whose performance cohort is being grouped.
  sameReference(stringValue("$myBuild"), stringValue("$_customBuildSlug")),
] });

// A stable custom identity wins over a mutable display name when both are
// recorded. Otherwise compare exact labels. Missing detection is explicitly
// "no different build recorded", not proof of successful execution/causality.
const PLAN_HELD_EXPR = Object.freeze({ $or: [
  { $and: [{ $eq: [DETECTED_NAME, ""] }, { $eq: [DETECTED_SLUG, ""] }] },
  sameReference(DETECTED_NAME, DETECTED_SLUG),
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
    { $group: { _id: "$_planLabel", count: { $sum: 1 },
      sampleGameIds: { $topN: { n: 20, sortBy: { date: -1, gameId: -1 }, output: "$gameId" } },
    } },
    { $sort: { count: -1, _id: 1 } }, { $limit: 5 },
    { $project: { _id: 0, name: "$_id", count: 1, sampleGameIds: 1 } },
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
/** Keep an owner-only example link within the existing bounded games query.
 * @param {unknown} raw */
function sampleIds(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {string[]} */ const ids = [];
  let encoded = 0;
  for (const value of raw.slice(0, 20)) {
    const id = typeof value === "string" ? value : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : "";
    if (!id || id.length > 200 || /[\u0000-\u001f\u007f]/u.test(id) || ids.includes(id)) continue;
    const size = encodeURIComponent(id).length + 7;
    if (size > 207 || encoded + size > 3000) continue;
    ids.push(id); encoded += size;
  }
  return ids;
}
/** @param {Array<Record<string,any>>|undefined} rows */
const labels = rows => (rows || []).filter(row => typeof row.name === "string" && row.name.length > 0 && row.name.length <= 200)
  .slice(0, 5).map(row => {
    const gameIds = sampleIds(row.sampleGameIds);
    return { name: row.name, count: number(row.count), sampleGameIds: gameIds, sampleLimit: 20, sampleTruncated: number(row.count) > gameIds.length };
  });

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
