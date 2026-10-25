"use strict";
const rules = require("../config/gameMomentRules.json");
const KINDS = rules.kinds.map(rule => rule.id);
/** @param {unknown} raw @returns {Record<string,any>} */
function record(raw) { return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}; }
/** @param {string} message @returns {never} */
function invalid(message) { throw Object.assign(new Error(message), { code: "invalid_game_moments", status: 400 }); }
/** Shared closed shape. Catalog predicates are injected to avoid a sanitizer
 * cycle with multichatAppearance's existing preset/sound allowlists.
 * @param {unknown} raw
 * @param {{preset?:(value:unknown)=>boolean,sound?:(value:unknown)=>boolean,strict?:boolean}} [options]
 */
function sanitizeGameMoments(raw, options = {}) {
  const source = record(raw), input = record(source.moments);
  if (options.strict && (!raw || Array.isArray(raw) || typeof raw !== "object"
    || Object.keys(source).some(key => !["mmrStep", "botPost", "moments"].includes(key))
    || (source.mmrStep !== undefined && !rules.mmrSteps.includes(source.mmrStep))
    || (source.botPost !== undefined && typeof source.botPost !== "boolean")
    || (source.moments !== undefined && source.moments !== input)
    || Object.keys(input).some(key => !KINDS.includes(key)))) invalid("Use only known game moments and a 100 or 250 MMR step.");
  /** @type {Record<string,{enabled:boolean,preset:string,sound:string}>} */
  const moments = {};
  for (const rule of rules.kinds) {
    const row = record(input[rule.id]);
    const validPreset = row.preset === "shuffle" || options.preset?.(row.preset) === true;
    const validSound = row.sound === "none" || options.sound?.(row.sound) === true;
    if (options.strict && input[rule.id] !== undefined && (input[rule.id] !== row
      || Object.keys(row).some(key => !["enabled", "preset", "sound"].includes(key))
      || (row.enabled !== undefined && typeof row.enabled !== "boolean")
      || (row.preset !== undefined && !validPreset) || (row.sound !== undefined && !validSound))) invalid("Use a known preset/sound and a boolean moment toggle.");
    moments[rule.id] = { enabled: row.enabled === true, preset: validPreset ? row.preset : rule.preset, sound: validSound ? row.sound : "none" };
  }
  return { mmrStep: rules.mmrSteps.includes(source.mmrStep) ? source.mmrStep : 100, botPost: source.botPost === true, moments };
}
module.exports = { KINDS, sanitizeGameMoments };
