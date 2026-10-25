"use strict";
const { applyPolicy } = require("./presetPolicy");
const catalog = require("../config/presetCatalog.json");
/** Preserve released naming on the 8-worker patch, independent of policy IDs.
 * @param {string} name @param {any} game */
function displayName(name, game) {
  if (typeof game.gameVersion !== "string" || !game.gameVersion.startsWith("5.0.16")) return name;
  return catalog.definitions.find((entry) => entry.name === name)?.eightWorkerName || name;
}
/** Complete raw evidence only; string build logs lose real-unit/subtype facts.
 * @param {any} policy @param {any} game @param {"you"|"opponent"} axis */
function policyLabelForGame(policy, game, axis) {
  const evidence = game.presetEvidence;
  if (!evidence || evidence.schemaVersion !== 1 || evidence.evaluatorVersion !== 1) return null;
  const value = evidence[axis];
  if (!value || value.custom || !value.complete || typeof value.baseline !== "string" || !Array.isArray(value.events)) return null;
  const race = axis === "you" ? game.myRace : game.opponent?.race;
  const partner = axis === "you" ? game.opponent?.race : game.myRace;
  if (!["Protoss", "Terran", "Zerg"].includes(race)) return null;
  // Too-short returns happen before the released tree and remain unchanged.
  if (Number.isFinite(game.durationSec) && game.durationSec < 45) return null;
  return displayName(applyPolicy(policy, value.baseline, race, partner || null, value.events, game, axis), game);
}
module.exports = { policyLabelForGame, displayName };
