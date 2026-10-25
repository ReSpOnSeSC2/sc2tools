"use strict";

const { createHash } = require("crypto");

/** This registry also generates the web guide; command implementations stay server-side. */
const CHAT_COMMANDS = Object.freeze([
  { id: "opponent", aliases: ["opp"], description: "Current or last opponent and your history" },
  { id: "mmr", aliases: ["session"], description: "Current MMR and session record" },
  { id: "build", aliases: [], description: "Your current or last recorded build" },
  { id: "record", aliases: [], description: "Today's wins and losses by matchup (UTC)" },
  { id: "winrate", aliases: [], argument: "[matchup|race]", description: "30-day and current-season win rates, with sample sizes" },
  { id: "streak", aliases: [], description: "Current recorded win or loss streak" },
  { id: "lastgame", aliases: [], description: "The latest recorded game" },
  { id: "h2h", aliases: [], description: "Current or last opponent and the last three meetings" },
  { id: "peak", aliases: [], description: "Recorded current-season peak on your latest region" },
  { id: "oracle", aliases: [], description: "The top three prediction scorers" },
  { id: "uptime", aliases: [], description: "Time since the stream session was started" },
]);
const PLATFORMS = Object.freeze(["twitch", "kick", "youtube", "tiktok", "nightbot"]);
const VARIABLES = Object.freeze(["user", "mmr", "record", "opponent", "streak"]);
const RESERVED = new Set(["rank", "level", "xp", "commands", "help", "win", "w", "loss", "lose", "l", "vote", "so", "1", "2", "3"]);
const MAX_CUSTOM_COMMANDS = 25;
const VIEWER_COOLDOWN_MS = 5000;
const triggerPattern = /^[a-z][a-z0-9_]{0,23}$/;

/** Strip markup and control characters before clipping every outgoing line.
 * @param {unknown} value */
function plainText(value) {
  return String(value ?? "").replace(/<[^>]*>/g, "").replace(/[<>\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
}

/** @param {string} message @returns {never} */
function invalid(message) { throw Object.assign(new Error(message), { code: "invalid_chat_commands", status: 400 }); }

/** @typedef {{trigger:string, enabled:boolean, cooldownSec:number, platforms:string[], answerOnStream:boolean}} CommandOptions */
/** @typedef {CommandOptions & {response:string}} CustomCommand */
/** @typedef {{builtins:Array<CommandOptions & {id:string}>, custom:CustomCommand[]}} ChatCommandPreferences */

/** Strict writes reject malformed settings. Reads safely normalize older documents.
 * @param {unknown} raw @param {boolean} [strict] @returns {ChatCommandPreferences} */
function sanitizeChatCommands(raw, strict = false) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? /** @type {Record<string, any>} */ (raw) : {};
  /** @type {ChatCommandPreferences} */
  const result = { builtins: [], custom: [] };
  if (strict && (Object.keys(source).some(key => !["builtins", "custom"].includes(key)) ||
    (source.builtins !== undefined && !Array.isArray(source.builtins)) ||
    (source.custom !== undefined && !Array.isArray(source.custom)))) invalid("Use builtin and custom command lists.");
  const rows = Array.isArray(source.builtins) ? source.builtins : [];
  const custom = Array.isArray(source.custom) ? source.custom : [];
  if (strict && (rows.length > CHAT_COMMANDS.length || custom.length > MAX_CUSTOM_COMMANDS)) invalid("Save at most 25 custom commands.");
  const used = new Set([...RESERVED, ...CHAT_COMMANDS.flatMap(command => [command.id, ...command.aliases])]);
  const ids = new Set();
  /** @param {Record<string, any>} row @param {string} fallback @returns {CommandOptions|null} */
  const options = (row, fallback) => {
    const trigger = typeof row.trigger === "string" ? row.trigger.replace(/^!/, "").toLowerCase().trim() : fallback;
    const cooldownSec = row.cooldownSec ?? 15;
    const platforms = row.platforms ?? [...PLATFORMS];
    if (!triggerPattern.test(trigger) || (trigger !== fallback && used.has(trigger)) ||
      typeof cooldownSec !== "number" || !Number.isInteger(cooldownSec) || cooldownSec < 5 || cooldownSec > 3600 ||
      !Array.isArray(platforms) || platforms.length > PLATFORMS.length || platforms.some(platform => !PLATFORMS.includes(platform)) ||
      (row.enabled !== undefined && typeof row.enabled !== "boolean") ||
      (row.answerOnStream !== undefined && typeof row.answerOnStream !== "boolean")) {
      if (strict) invalid("Use unique command names, valid platforms and a cooldown from 5 to 3600 seconds.");
      return null;
    }
    used.add(trigger);
    return { trigger, enabled: row.enabled !== false, cooldownSec, platforms: [...new Set(platforms)], answerOnStream: row.answerOnStream !== false };
  };
  for (const row of rows.slice(0, CHAT_COMMANDS.length)) {
    if (!row || typeof row !== "object" || Array.isArray(row) || !CHAT_COMMANDS.some(command => command.id === row.id) || ids.has(row.id)) {
      if (strict) invalid("Each builtin command can be configured once.");
      continue;
    }
    ids.add(row.id);
    const value = options(row, row.id);
    if (value) result.builtins.push({ id: row.id, ...value });
  }
  for (const row of custom.slice(0, MAX_CUSTOM_COMMANDS)) {
    if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.response !== "string" ||
      !row.response.trim() || row.response.length > 1000 || row.response !== plainText(row.response) ||
      [...row.response.matchAll(/\{([^{}]*)\}/g)].some(match => !VARIABLES.includes(match[1])) ||
      /[{}]/.test(row.response.replace(/\{(?:user|mmr|record|opponent|streak)\}/g, ""))) {
      if (strict) invalid("Use plain text and only {user}, {mmr}, {record}, {opponent} or {streak}.");
      continue;
    }
    const value = options(row, "");
    if (value) result.custom.push({ ...value, response: row.response });
  }
  return result;
}

/** @param {ChatCommandPreferences} prefs */
function configuredCommands(prefs) {
  return CHAT_COMMANDS.map(command => ({ ...command, trigger: command.id, enabled: true, cooldownSec: 15,
    platforms: [...PLATFORMS], answerOnStream: true, ...prefs.builtins.find(row => row.id === command.id) }));
}

/** One bounded cooldown ledger is shared by all reply transports in this process.
 * Call before composition so concurrent requests cannot both win. */
class CommandCooldowns {
  /** @param {()=>number} [now] */
  constructor(now = Date.now) { this.now = now; /** @type {Map<string,number>} */ this.entries = new Map(); }
  /** @param {string} owner @param {string} command @param {number} seconds @param {string} platform @param {string} viewer */
  claim(owner, command, seconds, platform, viewer) {
    const now = this.now();
    for (const [key, until] of this.entries) if (until <= now) this.entries.delete(key);
    const commandKey = `command:${owner}:${command}`;
    const viewerKey = `viewer:${owner}:${createHash("sha256").update(`${platform}:${viewer.toLowerCase()}`).digest("base64url")}`;
    if ((this.entries.get(commandKey) ?? 0) > now || (viewer && (this.entries.get(viewerKey) ?? 0) > now)) return false;
    // Capacity refusal avoids evicting live cooldowns and opening a spam path.
    if (this.entries.size + (viewer ? 2 : 1) > 4096) return false;
    this.entries.set(commandKey, now + seconds * 1000);
    if (viewer) this.entries.set(viewerKey, now + VIEWER_COOLDOWN_MS);
    return true;
  }
}

module.exports = { CHAT_COMMANDS, PLATFORMS, VARIABLES, RESERVED, MAX_CUSTOM_COMMANDS, VIEWER_COOLDOWN_MS,
  plainText, sanitizeChatCommands, configuredCommands, CommandCooldowns };
