"use strict";

const rules = require("../config/adminTrendViews.json");
const { sanitizeViewFilters } = require("./analyzerViews");
const { hmac } = require("./hash");

const PLAYER_REF = new RegExp(rules.playerRefPattern);
const plain = (/** @type {unknown} */ value) => value !== null && typeof value === "object" && !Array.isArray(value);
const mmr = (/** @type {unknown} */ value) => typeof value === "string" && (value === "" || /^\d{1,5}$/.test(value) && Number(value) <= 10000);

/** Shared links identify a roster entry without carrying the private handle.
 * @param {Buffer} pepper @param {string} playerId */
function rosterRef(pepper, playerId) {
  return `p_${Buffer.from(hmac(pepper, `admin-trends-roster-v1\0${playerId}`), "hex").subarray(0, 16).toString("base64url")}`;
}

/** @param {any} population */
function trendPopulation(population) {
  if (!plain(population) || !Array.isArray(population.excludedRaces)
    || !population.excludedRaces.every((/** @type {unknown} */ race) => typeof race === "string" && rules.raceCodes.includes(race))
    || !["all", "include"].includes(population.selection) || !Array.isArray(population.playerIds)
    || population.playerIds.length > rules.maxSavedPlayers
    || !population.playerIds.every((/** @type {unknown} */ id) => typeof id === "string" && PLAYER_REF.test(id))
    || typeof population.includeUnrated !== "boolean" || !mmr(population.mmrMin) || !mmr(population.mmrMax)
    || population.mmrMin !== "" && population.mmrMax !== "" && Number(population.mmrMin) > Number(population.mmrMax)) return null;
  return {
    excludedRaces: [...new Set(/** @type {string[]} */ (population.excludedRaces))].sort(),
    selection: population.selection,
    playerIds: [...new Set(/** @type {string[]} */ (population.playerIds))].sort(),
    mmrMin: population.mmrMin, mmrMax: population.mmrMax, includeUnrated: population.includeUnrated,
  };
}

/** @param {any} row */
function trendView(row) {
  if (!plain(row) || typeof row.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(row.id)
    || typeof row.name !== "string" || !row.name.trim() || row.name.length > rules.maxName || /[\u0000-\u001f\u007f]/.test(row.name)
    || !plain(row.filters) || Object.hasOwn(row.filters, "accounts")) return null;
  const population = trendPopulation(row.population);
  if (!population) return null;
  try { return { id: row.id, name: row.name.trim(), filters: sanitizeViewFilters(row.filters), population }; }
  catch { return null; }
}

/** @param {any} raw @param {boolean} [strict] */
function sanitizeAdminTrendViews(raw, strict = false) {
  const invalid = () => Object.assign(new Error("Use up to 20 uniquely named views with valid filters and player references."), {
    status: 400, code: "invalid_admin_trend_views",
  });
  const validRevision = Number.isSafeInteger(raw?.revision) && raw.revision >= 0 && raw.revision < Number.MAX_SAFE_INTEGER;
  if (strict && (!validRevision || !Array.isArray(raw.views) || raw.views.length > rules.maxViews)) throw invalid();
  const views = [], ids = new Set(), names = new Set();
  for (const entry of (Array.isArray(raw?.views) ? raw.views : []).slice(0, rules.maxViews)) {
    const view = trendView(entry);
    if (!view || ids.has(view.id) || names.has(view.name.toLowerCase())) {
      if (strict) throw invalid();
      continue;
    }
    views.push(view); ids.add(view.id); names.add(view.name.toLowerCase());
  }
  return { revision: validRevision ? raw.revision : 0, views };
}

module.exports = { ADMIN_TREND_VIEWS: rules.preferenceType, PLAYER_REF, rosterRef, sanitizeAdminTrendViews };
