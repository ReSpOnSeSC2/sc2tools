"use strict";

const crypto = require("crypto");
const { containsBlockedTerm } = require("./contentFilter");

const PLAYER_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{10}$/;
const PLAYER_UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SECTION_KEYS = ["showReplays", "showChannels", "showRecentForm", "showMmrHistory", "showSeasons", "showMaps"];
const RENAME_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
const RESERVED_BASES = new Set(["admin", "administrator", "api", "app", "auth", "builds", "community", "help", "login", "logout", "me", "moderator", "official", "players", "privacy", "reviews", "sc2tools", "settings", "status", "support", "system", "terms", "www"]);

/** Existing replay-sharing grammar; its unique users index owns this namespace.
 * @param {unknown} value @returns {string|null} */
function validPlayerSlug(value) {
  return typeof value === "string" && value.length <= 64 && PLAYER_SLUG_RE.test(value) ? value : null;
}

/** @param {string} slug */
function allowedPlayerSlug(slug) {
  const valid = validPlayerSlug(slug);
  const base = valid ? valid.slice(0, -11) : "";
  return Boolean(base && !RESERVED_BASES.has(base) && !containsBlockedTerm(base));
}

/** Automatic replay links use the same hygiene as manually chosen player links.
 * The random suffix is retained by the settings prefix editor.
 * @param {unknown} name @returns {string} */
function createPlayerSlug(name) {
  const base = (typeof name === "string" ? name : "").normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 53).replace(/-+$/g, "") || "player";
  const safeBase = RESERVED_BASES.has(base) || containsBlockedTerm(base) ? "player" : base;
  return `${safeBase}-${crypto.randomBytes(5).toString("hex")}`;
}

/** @param {any} user @param {boolean} [legacyPublic] */
function publicPlayerSettings(user, legacyPublic = false) {
  const stored = user?.publicProfile || {};
  const changed = safeIso(stored.slugChangedAt);
  /** @type {Record<string,any>} */
  const state = {
    enabled: stored.enabled === true,
    // Grandfather named publications only until the owner makes an explicit
    // privacy choice. Turning this toggle off must actually hide the profile.
    legacyPublic: legacyPublic && !Object.prototype.hasOwnProperty.call(user || {}, "publicProfile"),
    slug: validPlayerSlug(user?.replaySharing?.slug),
    updatedAt: safeIso(stored.updatedAt),
    renameAvailableAt: changed ? new Date(Date.parse(changed) + RENAME_COOLDOWN_MS).toISOString() : null,
    replaySharingEnabled: user?.replaySharing?.enabled === true,
    revision: Number.isSafeInteger(stored.revision) && stored.revision >= 0 ? stored.revision : 0,
  };
  for (const key of SECTION_KEYS) state[key] = stored[key] === true;
  return state;
}

/** @param {unknown} value @returns {string|null} */
function safeIso(value) {
  if (!(value instanceof Date) && typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** @param {number} status @param {string} code @param {string} message */
function playerError(status, code, message) { return Object.assign(new Error(message), { status, code }); }

module.exports = { PLAYER_SLUG_RE, PLAYER_UUID_RE, SECTION_KEYS, RENAME_COOLDOWN_MS, validPlayerSlug, allowedPlayerSlug, createPlayerSlug, publicPlayerSettings, safeIso, playerError };
