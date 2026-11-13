"use strict";

const { ObjectId } = require("mongodb");
const { activeOverlayTokenMatch } = require("./overlayTokens");
const { validPlayerSlug, playerError } = require("../util/publicPlayerConfig");
const { gamesMatchStage } = require("../util/parseQuery");
const { sha256 } = require("../util/hash");
const { ALL_LADDER_MAPS, normalizeMapName } = require("../util/isLadderMap");
const { outcome } = require("./reportFacts");

const MIN_DELAY = 5, MAX_DELAY = 60, MINUTE_MS = 60_000;
const GAME_LIMIT = 30, TOKEN_LIMIT = 100;
const MAP_NAMES = new Map(ALL_LADDER_MAPS.map(name => [normalizeMapName(name), name]));
const OPTIONS = { maxTimeMS: 2000 };
const OWNER_FIELDS = { _id: 0, userId: 1, streamViewer: 1, streamSession: 1, streamReportPublicEpoch: 1,
  "publicProfile.enabled": 1, "publicProfile.revision": 1, "replaySharing.slug": 1 };
const AVAILABLE_OWNER = { _gdprMutation: { $exists: false } };
const DECIDED = ["Victory", "Defeat"];

/** @param {unknown} value */
const validId = value => typeof value === "string" && /^[a-f0-9]{24}$/.test(value);
/** @param {unknown} value */
const validDelay = value => typeof value === "number" && Number.isInteger(value) && value >= MIN_DELAY && value <= MAX_DELAY;
/** @param {unknown} value */
const revision = value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
/** @param {unknown} value */
const validRevision = value => typeof value === "number" && value === revision(value);
/** @param {unknown} value */
const dateMs = value => value instanceof Date ? value.getTime() : NaN;

/** @param {import("mongodb").Document} user */
const consentEpoch = user => user.streamReportPublicEpoch ?? null;

/** @param {unknown} raw */
function settingsInput(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid();
  const value = /** @type {Record<string,unknown>} */ (raw);
  if (Object.keys(value).some(key => !["tokenId", "delayMinutes", "revision"].includes(key))
    || (value.tokenId !== null && !validId(value.tokenId))
    || !validDelay(value.delayMinutes) || !validRevision(value.revision)) throw invalid();
  return /** @type {{tokenId:string|null,delayMinutes:number,revision:number}} */ (value);
}

function invalid() { return playerError(400, "invalid_stream_viewer", "Choose a Browser Source and a delay from 5 to 60 minutes."); }
function conflict() { return playerError(409, "stream_viewer_changed", "Viewer settings changed elsewhere. Refresh before saving."); }

/** @param {import("mongodb").Document} user */
function settingsOf(user) {
  const row = user.streamViewer || {};
  const slug = validPlayerSlug(user.replaySharing?.slug);
  return { eligible: Boolean(slug && user.publicProfile?.enabled === true), slug,
    tokenId: row.publicEpoch === consentEpoch(user) && validId(row.tokenId) ? String(row.tokenId) : null,
    delayMinutes: validDelay(row.delayMinutes) ? Number(row.delayMinutes) : MIN_DELAY, revision: revision(row.revision) };
}

/** @param {import("mongodb").Document} user @param {ReturnType<typeof settingsOf>} current */
function viewerSettingsMatch(user, current) {
  const rev = current.revision ? { "streamViewer.revision": current.revision }
    : { $or: [{ "streamViewer.revision": 0 }, { "streamViewer.revision": { $exists: false } }] };
  return { userId: user.userId, ...AVAILABLE_OWNER, ...rev };
}

/** @param {import("mongodb").Document} user @param {string|null} slug */
function consentMatch(user, slug) {
  return { "publicProfile.enabled": true, "publicProfile.revision": user.publicProfile?.revision ?? { $exists: false },
    "replaySharing.slug": slug, streamReportPublicEpoch: consentEpoch(user) };
}

/** @param {unknown} value @returns {"Protoss"|"Terran"|"Zerg"|"Random"|null} */
function opponentRace(value) {
  switch (typeof value === "string" ? value.trim().toLowerCase() : "") {
    case "p": case "protoss": return "Protoss";
    case "t": case "terran": return "Terran";
    case "z": case "zerg": return "Zerg";
    case "r": case "random": return "Random";
    default: return null;
  }
}

/** @param {import("mongodb").Document} row @param {number} start @param {number} end */
function completedInSession(row, start, end) {
  const began = typeof row.startedAt === "string" ? Date.parse(row.startedAt) : dateMs(row.startedAt);
  const duration = row.durationSec;
  return typeof duration === "number" && Number.isFinite(duration) && duration > 0
    && began >= start && began < end;
}

/** Explicit projection from recorded replay end timestamps.
 * @param {import("mongodb").Document} row @param {number} start @param {number} cutoff */
function publicGame(row, start, cutoff) {
  const end = dateMs(row.date), result = outcome(row);
  if (!result || end > cutoff || !completedInSession(row, start, end)) return null;
  return { result, opponentRace: opponentRace(row.opponent?.race), map: MAP_NAMES.get(normalizeMapName(row.map)) ?? null };
}

/** @typedef {NonNullable<ReturnType<typeof publicGame>>} PublicGame */
/** @typedef {{games:PublicGame[],wins:number,losses:number,delayMinutes:number}} ViewerPage */

class StreamViewerService {
  /** @param {Pick<import("../db/connect").DbContext,"users"|"overlayTokens"|"games">} db @param {()=>number} [now] */
  constructor(db, now = Date.now) {
    this.db = db; this.now = now;
  }

  /** @param {string} userId */
  async getSettings(userId) {
    const user = await this.db.users.findOne({ userId, ...AVAILABLE_OWNER }, { ...OPTIONS, projection: OWNER_FIELDS });
    if (!user) throw playerError(404, "user_not_found", "Account not found.");
    const current = settingsOf(user);
    return ownerSettings(current, await this.sources(userId, current.tokenId));
  }

  /** @param {string} userId @param {string|null} tokenId */
  async sources(userId, tokenId) {
    const active = activeOverlayTokenMatch(userId);
    const options = { ...OPTIONS, projection: { _id: 1, label: 1 } };
    const rows = await this.db.overlayTokens.find(active, options).sort({ createdAt: -1, _id: -1 }).limit(TOKEN_LIMIT).toArray();
    if (tokenId && !rows.some(row => String(row._id) === tokenId)) {
      const selected = await this.db.overlayTokens.findOne({ ...active, _id: new ObjectId(tokenId) }, options);
      if (selected) rows.push(selected);
    }
    return rows.map(row => ({ id: String(row._id),
      label: typeof row.label === "string" ? row.label.trim().slice(0, 80) || "Browser Source" : "Browser Source" }));
  }

  /** @param {string} userId @param {unknown} raw */
  async setSettings(userId, raw) {
    const input = settingsInput(raw);
    const user = await this.db.users.findOne({ userId, ...AVAILABLE_OWNER }, { ...OPTIONS, projection: OWNER_FIELDS });
    if (!user) throw playerError(404, "user_not_found", "Account not found.");
    const current = settingsOf(user);
    if (input.revision !== current.revision) throw conflict();
    if (input.tokenId && !current.eligible) {
      throw playerError(409, "public_profile_required", "Turn on your public player page before sharing a viewer page.");
    }
    const sources = await this.sources(userId, input.tokenId);
    if (input.tokenId && !sources.some(source => source.id === input.tokenId)) {
      throw playerError(404, "viewer_source_unavailable", "This Browser Source is no longer available.");
    }
    const next = { ...input, revision: current.revision + 1, publicEpoch: consentEpoch(user) };
    const admission = input.tokenId ? consentMatch(user, current.slug) : {};
    const saved = await this.db.users.findOneAndUpdate({ ...viewerSettingsMatch(user, current), ...admission },
      { $set: { streamViewer: next } }, { ...OPTIONS, projection: OWNER_FIELDS, returnDocument: "after" });
    if (!saved) throw conflict();
    return ownerSettings(settingsOf(saved), sources);
  }

  /** @param {string} userId @param {string} tokenId */
  async activeToken(userId, tokenId) {
    return this.db.overlayTokens.findOne({ ...activeOverlayTokenMatch(userId), _id: new ObjectId(tokenId) },
      { ...OPTIONS, projection: { _id: 0, token: 1 } });
  }

  /** @param {string} slug */
  async admit(slug) {
    const user = await this.db.users.findOne({ "replaySharing.slug": slug, "publicProfile.enabled": true, ...AVAILABLE_OWNER },
      { ...OPTIONS, projection: OWNER_FIELDS });
    if (!user || typeof user.userId !== "string") return null;
    const settings = settingsOf(user);
    if (!settings.eligible || !settings.tokenId) return null;
    const token = await this.activeToken(user.userId, settings.tokenId);
    if (typeof token?.token !== "string" || !token.token) return null;
    const start = user.streamSession?.viewerSource === sha256(token.token) ? dateMs(user.streamSession.startAt) : NaN;
    return { owner: user.userId, start, delay: settings.delayMinutes,
      key: JSON.stringify([user.userId, consentEpoch(user), settings.revision, settings.tokenId, settings.delayMinutes, start]) };
  }

  /** @param {unknown} slug @returns {Promise<ViewerPage|null>} */
  async read(slug) {
    if (typeof slug !== "string" || !validPlayerSlug(slug)) return null;
    const current = await this.admit(slug);
    if (!current) return null;
    // Read current visibility on every request so a hidden or deleted replay
    // cannot survive in a public cache.
    const value = await this.load(current, this.now());
    // Consent, session and the exact token can change during an awaited game read.
    if ((await this.admit(slug))?.key !== current.key) return null;
    return value;
  }

  /** @param {{owner:string,start:number,delay:number}} current @param {number} now @returns {Promise<ViewerPage>} */
  async load({ owner, start, delay }, now) {
    const cutoff = now - delay * MINUTE_MS;
    const rows = Number.isFinite(start) && start <= cutoff ? await this.db.games.find({
      ...gamesMatchStage(owner, { since: new Date(start), until: new Date(cutoff), gameSize: "1v1" }),
      result: { $in: DECIDED },
    }, { ...OPTIONS, projection: { _id: 0, date: 1, startedAt: 1, durationSec: 1, result: 1, "opponent.race": 1, map: 1 } })
      .sort({ date: -1, _id: -1 }).limit(GAME_LIMIT * 2).toArray() : [];
    const games = rows.map(row => publicGame(row, start, cutoff)).filter(game => game !== null).slice(0, GAME_LIMIT);
    const wins = games.filter(game => game.result === "win").length;
    return { games, wins, losses: games.length - wins, delayMinutes: delay };
  }
}

/** @param {ReturnType<typeof settingsOf>} current @param {Array<{id:string,label:string}>} sources */
function ownerSettings(current, sources) {
  const tokenId = current.eligible && sources.some(source => source.id === current.tokenId) ? current.tokenId : null;
  return { eligible: current.eligible, tokenId, delayMinutes: current.delayMinutes, revision: current.revision,
    href: tokenId ? `/p/${current.slug}/live` : null, sources };
}

module.exports = { StreamViewerService };
