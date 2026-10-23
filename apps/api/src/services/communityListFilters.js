"use strict";

const RACES = new Map([["p", "Protoss"], ["protoss", "Protoss"], ["t", "Terran"], ["terran", "Terran"], ["z", "Zerg"], ["zerg", "Zerg"]]);
const SKILLS = new Set(["bronze", "silver", "gold", "platinum", "diamond", "master", "grandmaster"]);

/** @param {unknown} value */
function raceName(value) {
  return typeof value === "string" ? RACES.get(value.trim().toLowerCase()) : undefined;
}

/**
 * Keep race/league predicates independent of the free-text $or so every
 * requested scope applies, including to controversial aggregation.
 * @param {{matchup?: string, race?: string, vsRace?: string, skill?: string, search?: string}} opts
 * @returns {Record<string, any>}
 */
function communityListFilter(opts) {
  const clauses = /** @type {Array<Record<string, any>>} */ ([{ removed: false }]);
  if (opts.matchup) clauses.push({ matchup: opts.matchup });
  const race = raceName(opts.race);
  const vsRace = raceName(opts.vsRace);
  const skill = typeof opts.skill === "string" ? opts.skill.trim().toLowerCase() : "";
  if (race) clauses.push({ "build.race": race });
  if (vsRace) clauses.push({ "build.vsRace": { $in: [vsRace, "Any"] } });
  if (SKILLS.has(skill)) clauses.push({ "build.skillLevel": skill });
  if (opts.search) {
    const escaped = String(opts.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escaped, "i");
    clauses.push({ $or: [{ title: re }, { description: re }, { authorName: re }] });
  }
  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

module.exports = { communityListFilter };
