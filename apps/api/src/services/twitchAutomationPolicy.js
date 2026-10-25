"use strict";

const config = require("../config/twitchAutomation.json");
const PREF_TYPE = "twitchAutomation";
const fields = Object.keys(config.defaults);
/** @param {unknown} value @returns {Record<string,any>} */
const object = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
/** @param {string} message @returns {never} */
function invalid(message) { throw Object.assign(new Error(message), { status: 400, code: "invalid_twitch_automation" }); }
/** @param {unknown} value */
function plain(value) { return String(value ?? "").replace(/<[^>]*>/g, "").replace(/[<>\p{Cc}\u2028\u2029]/gu, " ").replace(/\s+/g, " ").trim(); }
/** Unicode-safe clipping; never split a surrogate pair. @param {string} value @param {number} max */
function clip(value, max) {
  const chars = Array.from(plain(value));
  return chars.length <= max ? chars.join("") : chars.slice(0, max - 1).join("").trimEnd() + "…";
}
/** @param {unknown} value */
function validTemplate(value) {
  return typeof value === "string" && value.trim().length > 0 && Array.from(value).length <= config.limits.templateChars
    && !/[<>\p{Cc}\u2028\u2029]/u.test(value)
    && !/[{}]/.test(value.replace(/\{(?:me|opp|oppRace|oppMmr)\}/g, ""));
}
/** Strict writes and safe legacy reads. Both opt-ins require explicit true.
 * @param {unknown} raw @param {boolean} [strict] */
function sanitizeTwitchAutomation(raw, strict = false) {
  const source = /** @type {Record<string,any>} */ (object(raw));
  if (strict && (!raw || Array.isArray(raw) || typeof raw !== "object" || Object.keys(source).some(key => !fields.includes(key)))) invalid("Use supported Twitch automation settings.");
  for (const key of ["predictionsEnabled", "markersEnabled"]) {
    if (strict && source[key] !== undefined && typeof source[key] !== "boolean") invalid("Automation toggles must be true or false.");
  }
  const windowValid = Number.isInteger(source.windowSec) && source.windowSec >= config.limits.windowMinSec && source.windowSec <= config.limits.windowMaxSec;
  if (strict && source.windowSec !== undefined && !windowValid) invalid("Choose a whole-number prediction window from 30 to 300 seconds.");
  if (strict && source.titleTemplate !== undefined && !validTemplate(source.titleTemplate)) invalid("Use a plain title template with only {me}, {opp}, {oppRace} and {oppMmr}.");
  return { predictionsEnabled: source.predictionsEnabled === true, markersEnabled: source.markersEnabled === true,
    windowSec: windowValid ? source.windowSec : config.defaults.windowSec,
    titleTemplate: validTemplate(source.titleTemplate) ? plain(source.titleTemplate) : config.defaults.titleTemplate };
}
/** @param {unknown} value */
function race(value) {
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (/** @type {Record<string,string>} */ ({ p: "P", protoss: "P", t: "T", terran: "T", z: "Z", zerg: "Z", r: "R", random: "R" }))[key] || "?";
}
/** @param {string} template @param {{me?:unknown,opp?:unknown,oppRace?:unknown,oppMmr?:unknown}} context */
function predictionTitle(template, context) {
  /** @type {Record<string,string>} */
  const values = { me: plain(context.me) || "You", opp: plain(context.opp) || "Opponent", oppRace: race(context.oppRace),
    oppMmr: typeof context.oppMmr === "number" && Number.isFinite(context.oppMmr) && context.oppMmr > 0 ? String(Math.round(context.oppMmr)) : "?" };
  const safe = validTemplate(template) ? template : config.defaults.titleTemplate;
  return clip(safe.replace(/\{(me|opp|oppRace|oppMmr)\}/g, (_match, key) => values[key]), config.limits.predictionTitleChars);
}
/** @param {{opp?:unknown,myRace?:unknown,oppRace?:unknown,map?:unknown}} context */
function markerDescription(context) {
  return clip(`vs ${plain(context.opp) || "Opponent"} · ${race(context.myRace)}v${race(context.oppRace)} · ${plain(context.map) || "Map unavailable"}`, config.limits.markerChars);
}

/** The current desktop client has no ranked queue evidence. Raw agent boolean
 * fields, Pulse ratings and replay history never establish this fact. The
 * separate argument is reserved for evidence validated by a server adapter;
 * current production wiring must supply null, with an honest unavailable state.
 * @param {Record<string,any>} envelope @param {{source:string,receivedAt:number}} source
 * @param {number} now @param {{ranked1v1:boolean,source:'verified-live-queue'}|null} [queueEvidence] */
function eligibility(envelope, source, now, queueEvidence = null) {
  if (source.source !== "device") return { marker: false, prediction: false, reason: "trusted_device_required" };
  if (envelope.synthetic || envelope.isTest || envelope.isReplay !== false || envelope.isObserver === true || envelope.sourceObserver === true) return { marker: false, prediction: false, reason: "not_a_live_player_game" };
  if (typeof envelope.gameKey !== "string" || !envelope.gameKey || envelope.gameKey.length > 120 || /[\p{Cc}]/u.test(envelope.gameKey)) return { marker: false, prediction: false, reason: "game_key_unavailable" };
  if (!Number.isFinite(source.receivedAt) || now - source.receivedAt < 0 || now - source.receivedAt > config.limits.loadingFreshMs) return { marker: false, prediction: false, reason: "stale_loading" };
  // Native lifecycle timestamps are epoch seconds. Normalize milliseconds for
  // diagnostics too; a newly received buffered old event is still stale.
  const captured = typeof envelope.capturedAt === "number" && Number.isFinite(envelope.capturedAt)
    ? envelope.capturedAt < 1e12 ? envelope.capturedAt * 1000 : envelope.capturedAt : NaN;
  if (!Number.isFinite(captured) || now - captured < -5000 || now - captured > config.limits.loadingFreshMs) return { marker: false, prediction: false, reason: "stale_loading" };
  const players = Array.isArray(envelope.players) ? envelope.players : [];
  const humans = players.filter(player => player && player.type === "user" && typeof player.name === "string" && player.name.trim());
  if (players.length !== 2 || humans.length !== 2 || !envelope.user || !envelope.opponent) return { marker: false, prediction: false, reason: "live_1v1_required" };
  const names = humans.map(player => plain(player.name).toLowerCase());
  if (names[0] === names[1] || !names.includes(plain(envelope.user.name).toLowerCase()) || !names.includes(plain(envelope.opponent.name).toLowerCase()) || plain(envelope.user.name).toLowerCase() === plain(envelope.opponent.name).toLowerCase()) return { marker: false, prediction: false, reason: "local_player_unresolved" };
  const loading = envelope.phase === "match_loading", started = envelope.phase === "match_started";
  if (!loading && !started) return { marker: false, prediction: false, reason: "start_phase_required" };
  const ranked = queueEvidence?.source === "verified-live-queue" && queueEvidence.ranked1v1 === true;
  return { marker: started, prediction: loading && ranked, reason: loading ? ranked ? null : "ranked_status_unavailable" : null };
}

module.exports = { PREF_TYPE, config, sanitizeTwitchAutomation, predictionTitle, markerDescription, eligibility, plain, clip };
