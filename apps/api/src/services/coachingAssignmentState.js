"use strict";

const ASSIGNMENT_STATES = Object.freeze(["active", "upcoming", "ended", "cancelled"]);
/** Stored UTC boundaries only; progress/targets cannot change list membership.
 * @param {string|undefined} state @param {Date} now */
function assignmentStateMatch(state, now) {
  if (state === "cancelled") return { status: "cancelled" };
  if (state === "upcoming") return { status: "active", "requirement.startsAt": { $gt: now } };
  if (state === "ended") return { status: "active", "requirement.endsAt": { $lte: now } };
  if (state === "active") return { status: "active", "requirement.startsAt": { $lte: now }, "requirement.endsAt": { $gt: now } };
  return {};
}

/** Counts always use the same accepted relationship/grant scope as the page.
 * No assignment progress or game query is performed for these totals.
 * @param {import('mongodb').Collection} collection
 * @param {Record<string,any>} scope @param {Date} now */
async function assignmentStateCounts(collection, scope, now) {
  const states = ["all", ...ASSIGNMENT_STATES];
  const values = await Promise.all(states.map(state => collection.countDocuments({ ...scope, ...assignmentStateMatch(state, now) })));
  return Object.fromEntries(states.map((state, index) => [state, values[index]]));
}

module.exports = { ASSIGNMENT_STATES, assignmentStateMatch, assignmentStateCounts };
