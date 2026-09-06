"use strict";

const { randomUUID } = require("crypto");
const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");

const MAX_PLAYERS = 200;
const NUMERIC_ID = /^[1-9]\d{0,19}$/;
const TOON_ID = /^[1-9]\d?-S2-[1-9]\d?-\d{1,20}$/;
const PLATFORMS = ["twitch", "youtube"];

/** @param {number} status @param {string} code @param {string} message */
function channelError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

/** Accept channel pages only. Never turn a video, redirect, or lookalike host into a channel.
 * @param {string} platform @param {unknown} raw @returns {string|null}
 */
function normalizeChannelUrl(platform, raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string" || raw.length > 300) {
    throw channelError(400, "invalid_channel_url", `Enter a valid ${platform} channel URL.`);
  }
  let url;
  try { url = new URL(raw.trim()); } catch { url = null; }
  if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port) {
    throw channelError(400, "invalid_channel_url", `Enter a full ${platform} channel URL.`);
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  let path = url.pathname.replace(/\/+$/, "");
  if (platform === "twitch" && host === "twitch.tv" && /^\/[A-Za-z0-9_]{1,25}$/.test(path)) {
    const name = path.slice(1).toLowerCase();
    if (!["directory", "downloads", "jobs", "p", "settings", "videos", "search", "subscriptions", "inventory", "wallet", "login", "signup", "turbo"].includes(name)) {
      return `https://www.twitch.tv/${name}`;
    }
  }
  if (platform === "youtube" && ["youtube.com", "m.youtube.com"].includes(host)) {
    // Common channel tabs still identify the same channel, including older Pulse links.
    path = path.replace(/\/(?:featured|videos|shorts|streams|playlists|community|about)$/, "");
    const legacy = /^\/[A-Za-z0-9._-]{1,100}$/.test(path) && !["watch", "shorts", "live", "feed", "results", "playlist", "playlists", "gaming", "premium", "account", "subscriptions", "upload", "features", "embed", "redirect", "oops", "error", "logout", "signin", "channel", "user", "c", "about", "t", "reporthistory", "paid_memberships"].includes(path.slice(1).toLowerCase());
    if (legacy || /^\/channel\/UC[A-Za-z0-9_-]{22}$/.test(path) || /^\/(?:c|user)\/[A-Za-z0-9._-]{1,100}$/.test(path) || /^\/@[\p{L}\p{N}._%-]{1,100}$/u.test(path)) {
      return `https://www.youtube.com${path}`;
    }
  }
  throw channelError(400, "invalid_channel_url", `Use a ${platform} channel page URL, rather than a video or clip.`);
}

/** @param {any} raw @returns {Record<string,string|null>} */
function normalizeChannels(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some((key) => !PLATFORMS.includes(key))) {
    throw channelError(400, "invalid_channels", "Channels must contain only Twitch and YouTube URLs.");
  }
  return Object.fromEntries(PLATFORMS.map((platform) => [platform, normalizeChannelUrl(platform, raw[platform])]));
}

/** @param {any} raw @returns {{pulseCharacterId?:string,toonHandle?:string}} */
function normalizeIdentity(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw channelError(400, "invalid_player_identity", "A player identity is required.");
  /** @type {{pulseCharacterId?:string,toonHandle?:string}} */
  const out = {};
  if (raw.pulseCharacterId !== undefined && raw.pulseCharacterId !== null && raw.pulseCharacterId !== "") {
    const id = String(raw.pulseCharacterId).trim();
    if (!NUMERIC_ID.test(id)) throw channelError(400, "invalid_player_identity", "SC2Pulse character IDs must be positive numbers.");
    out.pulseCharacterId = id;
  }
  if (raw.toonHandle !== undefined && raw.toonHandle !== null && raw.toonHandle !== "") {
    const toon = String(raw.toonHandle).trim();
    if (!TOON_ID.test(toon)) throw channelError(400, "invalid_player_identity", "Use a complete Battle.net toon handle, for example 1-S2-1-12345.");
    out.toonHandle = toon;
  }
  if (!out.pulseCharacterId && !out.toonHandle) throw channelError(400, "invalid_player_identity", "Add a SC2Pulse character ID or Battle.net toon handle.");
  return out;
}

/** @param {any} identity @returns {string[]} */
function identityKeys(identity) {
  return [identity.pulseCharacterId ? `pulse:${identity.pulseCharacterId}` : "", identity.toonHandle ? `toon:${identity.toonHandle}` : ""].filter(Boolean);
}

/** @param {any} raw */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw channelError(400, "invalid_player", "A player entry is required.");
  const displayName = typeof raw.displayName === "string" ? raw.displayName.trim() : "";
  if (!displayName || displayName.length > 80) throw channelError(400, "invalid_player_name", "Enter a player name of up to 80 characters.");
  const pulseCharacterIds = normalizeIdArray(raw.pulseCharacterIds, "pulseCharacterId");
  const toonHandles = normalizeIdArray(raw.toonHandles, "toonHandle");
  const proId = raw.proId === undefined || raw.proId === null || raw.proId === "" ? null : String(raw.proId).trim();
  if (proId && !NUMERIC_ID.test(proId)) throw channelError(400, "invalid_pro_id", "SC2Pulse pro IDs must be positive numbers.");
  if (!proId && !pulseCharacterIds.length && !toonHandles.length) throw channelError(400, "player_identity_required", "Add at least one stable player identity. Names alone cannot link players.");
  const keys = [...pulseCharacterIds.map((id) => `pulse:${id}`), ...toonHandles.map((id) => `toon:${id}`), ...(proId ? [`pro:${proId}`] : [])];
  return { displayName, pulseCharacterIds, toonHandles, proId, identityKeys: keys, channels: normalizeChannels(raw.channels), removed: raw.removed === true };
}

/** @param {any} raw @param {string} field @returns {string[]} */
function normalizeIdArray(raw, field) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 100) throw channelError(400, "invalid_player_identity", "Use at most 100 identities per player.");
  return [...new Set(raw.map((value) => /** @type {any} */ (normalizeIdentity({ [field]: value }))[field]))];
}

/** Shared public directory. Private ownership metadata never enters public DTOs. */
class PlayerChannelsService {
  /** @param {import('../db/connect').DbContext} db @param {{pulseLinks?:import('./pulseCharacterLinks').PulseCharacterLinkService,fetchImpl?:typeof fetch,seeds?:any[]}} [opts] */
  constructor(db, opts = {}) {
    this.db = db;
    this.col = db.playerChannels;
    this.pulseLinks = opts.pulseLinks || null;
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.seeds = opts.seeds === undefined ? loadSeeds() : opts.seeds;
    this.pulseSeeds = opts.seeds === undefined ? loadPulseSeeds() : [];
    /** @type {Promise<void>|null} */
    this.seedPromise = null;
    /** @type {Promise<any>|null} */
    this.importPromise = null;
    this.activeLinkReads = 0;
  }

  async ensureSeeds() {
    if (!this.seedPromise) {
      this.seedPromise = this.seedPulseSnapshot().then(() => this.importRows(this.seeds, "curated", true)).then(() => {}).catch((err) => { this.seedPromise = null; throw err; });
    }
    await this.seedPromise;
  }

  async seedPulseSnapshot() {
    // One Mongo round trip for the reviewed snapshot, rather than a write per player.
    // setOnInsert means an older deploy snapshot cannot replace newer imported URLs.
    const now = new Date();
    /** @type {any[]} */ const operations = [];
    for (const raw of this.pulseSeeds) {
      let entry;
      try { entry = normalizeEntry(raw); } catch { continue; }
      const doc = stampVersion({ ...entry, id: randomUUID(), revision: 1, source: "sc2pulse", createdAt: now, updatedAt: now, importedAt: now, sources: raw.sources || [] }, COLLECTIONS.PLAYER_CHANNELS);
      operations.push({ updateOne: { filter: { identityKeys: { $in: entry.identityKeys } }, update: { $setOnInsert: doc }, upsert: true } });
    }
    if (!operations.length) return;
    try { await this.col.bulkWrite(operations, { ordered: false }); } catch (err) {
      const errors = /** @type {any} */ (err)?.writeErrors;
      if (!Array.isArray(errors) || !errors.length || errors.some((item) => item.code !== 11000)) throw err;
    }
  }

  /** Resolve stable aliases using the existing public Pulse caches. No tenant opponent/name query.
   * @param {any[]} players @returns {Promise<string[][]>}
   */
  async expandIdentities(players) {
    const toons = players.map((p) => p.toonHandle).filter(Boolean);
    const accounts = toons.length ? await this.db.pulseAccounts.find({ toonHandle: { $in: toons } }, { projection: { toonHandle: 1, pulseCharacterId: 1 } }).toArray() : [];
    const cachedToons = toons.length ? await this.db.pulseCharacterLinks.find({ toonHandle: { $in: toons } }, { projection: { toonHandle: 1, pulseCharacterId: 1 } }).toArray() : [];
    const byToon = new Map([...cachedToons, ...accounts].map((row) => [row.toonHandle, row.pulseCharacterId]));
    const ids = [...new Set(players.flatMap((p) => [p.pulseCharacterId, byToon.get(p.toonHandle)]).filter((id) => typeof id === "string" && NUMERIC_ID.test(id)))];
    // getLinks is already bounded, persistent and stale-while-error; one batch for a UI page.
    const links = await this.readLinks(ids);
    const linkedAccounts = [...new Set([...links.values()].map((link) => link.accountId).filter(Boolean))];
    // Account aliases find entries saved for a sibling character, without exposing BattleTags.
    const siblings = ids.length ? await this.db.pulseCharacterLinks.find({ $or: [{ accountId: { $in: linkedAccounts } }, { pulseCharacterId: { $in: ids } }] }, { projection: { pulseCharacterId: 1, accountId: 1, proId: 1, toonHandle: 1 } }).limit(10000).toArray() : [];
    return players.map((player) => {
      if (player.toonHandle && player.pulseCharacterId && byToon.has(player.toonHandle) && byToon.get(player.toonHandle) !== player.pulseCharacterId) return [];
      const keys = new Set(identityKeys(player));
      for (const cid of [player.pulseCharacterId, byToon.get(player.toonHandle)]) {
        if (!cid) continue;
        keys.add(`pulse:${cid}`);
        const ownToon = siblings.find((row) => row.pulseCharacterId === cid)?.toonHandle;
        if (player.toonHandle && player.pulseCharacterId === cid && ownToon && ownToon !== player.toonHandle) return [];
        if (ownToon) keys.add(`toon:${ownToon}`);
        const link = links.get(cid);
        if (link?.proId) keys.add(`pro:${link.proId}`);
        if (link?.accountId) {
          for (const sibling of siblings) {
            if (sibling.accountId !== link.accountId) continue;
            keys.add(`pulse:${sibling.pulseCharacterId}`);
            if (sibling.toonHandle) keys.add(`toon:${sibling.toonHandle}`);
            if (sibling.proId) keys.add(`pro:${sibling.proId}`);
          }
        }
      }
      return [...keys];
    });
  }

  /** Bound upstream work without rejecting cheap cached/public-directory reads.
   * @param {string[]} ids @returns {Promise<Map<string,any>>}
   */
  async readLinks(ids) {
    if (!ids.length) return new Map();
    if (this.pulseLinks && this.activeLinkReads < 2) {
      this.activeLinkReads++;
      try { return (await this.pulseLinks.getLinks(ids, { includeIdentity: true })).links; } finally { this.activeLinkReads--; }
    }
    const cached = await this.db.pulseCharacterLinks.find({ pulseCharacterId: { $in: ids } }, { projection: { pulseCharacterId: 1, accountId: 1, proId: 1, proNickname: 1 } }).toArray();
    return new Map(cached.map((row) => [row.pulseCharacterId, row]));
  }

  /** @param {any[]} raw @returns {Promise<{players:any[]}>} */
  async resolve(raw) {
    if (!Array.isArray(raw) || raw.length > MAX_PLAYERS) throw channelError(400, "invalid_players", `Resolve at most ${MAX_PLAYERS} players at a time.`);
    const players = raw.map(normalizeIdentity);
    if (!players.length) return { players: [] };
    await this.ensureSeeds();
    const directKeys = [...new Set(players.flatMap(identityKeys))];
    const directEntries = await this.col.find({ identityKeys: { $in: directKeys } }).toArray();
    // Known direct aliases (including reviewed curated toons) need no upstream call.
    const unresolved = players.map((player, index) => ({ player, index })).filter(({ player }) => !directEntries.some((entry) => identityKeys(player).some((key) => entry.identityKeys.includes(key))) || (player.toonHandle && player.pulseCharacterId));
    const keySets = players.map(identityKeys);
    const expanded = await this.expandIdentities(unresolved.map(({ player }) => player));
    unresolved.forEach(({ index }, i) => { keySets[index] = expanded[i]; });
    const entries = unresolved.length ? await this.col.find({ identityKeys: { $in: [...new Set(keySets.flat())] } }).toArray() : directEntries;
    return { players: players.map((player, index) => {
      const hits = entries.filter((entry) => {
        const keys = entry.source === "self" ? entry.approvedIdentityKeys || [] : entry.identityKeys;
        return keys.some((/** @type {string} */ key) => keySets[index].includes(key));
      });
      // Explicit character/toon entries win over broader upstream account/pro aliases.
      const direct = hits.filter((entry) => entry.identityKeys.some((/** @type {string} */ key) => identityKeys(player).includes(key)));
      const candidates = direct.length ? direct : hits;
      // Conflicting aliases fail closed rather than advertising the wrong person's channel.
      const entry = candidates.length === 1 ? candidates[0] : null;
      return { ...player, channels: entry && !entry.removed ? publicChannels(entry.channels) : {}, ...(entry ? { id: entry.id, displayName: entry.source === "self" ? entry.approvedDisplayName || entry.displayName : entry.displayName } : {}) };
    }) };
  }

  /** @param {any[]} games @returns {Promise<{channelsByGameId:Record<string,any[]>}>} */
  async resolveForGames(games) {
    /** @type {Record<string,any[]>} */
    const channelsByGameId = Object.create(null);
    /** @type {any[]} */
    const participants = [];
    for (const game of games) {
      if (!game || typeof game.gameId !== "string") continue;
      channelsByGameId[game.gameId] = [];
      for (const perspective of ["me", "opponent"]) {
        const raw = perspective === "me" ? { toonHandle: game.myToonHandle, pulseCharacterId: game.myPulseCharacterId } : { toonHandle: game.opponent?.toonHandle || (TOON_ID.test(game.opponent?.pulseId || "") ? game.opponent.pulseId : undefined), pulseCharacterId: game.opponent?.pulseCharacterId };
        try { participants.push({ gameId: game.gameId, perspective, playerName: perspective === "me" ? game.myDisplayName || "Player" : game.opponent?.displayName || "Opponent", identity: normalizeIdentity(raw) }); } catch { /* Older games may not carry stable identity. */ }
      }
    }
    const unique = [...new Map(participants.map((participant) => [JSON.stringify(participant.identity), participant.identity])).entries()];
    /** @type {Map<string,any>} */ const resolved = new Map();
    for (let offset = 0; offset < unique.length; offset += MAX_PLAYERS) {
      const group = unique.slice(offset, offset + MAX_PLAYERS);
      const result = await this.resolve(group.map(([, identity]) => identity));
      result.players.forEach((entry, index) => { resolved.set(group[index][0], entry); });
    }
    for (const participant of participants) {
        const entry = resolved.get(JSON.stringify(participant.identity));
        if (!entry) continue;
        if (!Object.keys(entry.channels).length) continue;
        channelsByGameId[participant.gameId].push({ perspective: participant.perspective, playerName: entry.displayName || participant.playerName, channels: entry.channels });
    }
    return { channelsByGameId };
  }

  /** @param {any} [opts] */
  async list(opts = {}) {
    await this.ensureSeeds();
    const limit = Math.min(100, Math.max(1, Math.floor(Number(opts.limit) || 25)));
    const page = Math.max(0, Math.min(10000, Math.floor(Number(opts.page) || 0)));
    /** @type {any} */ const filter = opts.includeRemoved === true ? {} : { removed: { $ne: true } };
    if (opts.pendingOnly === true) filter.pending = true;
    if (typeof opts.search === "string" && opts.search.trim()) {
      const term = opts.search.trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = ["displayName", "pulseCharacterIds", "toonHandles", "proId", "channels.twitch", "channels.youtube", "pendingChannels.twitch", "pendingChannels.youtube"].map((field) => ({ [field]: { $regex: term, $options: "i" } }));
    }
    const [entries, total] = await Promise.all([this.col.find(filter).sort({ displayName: 1, id: 1 }).skip(page * limit).limit(limit).toArray(), this.col.countDocuments(filter)]);
    return { entries: entries.map((entry) => managementEntry(entry, true)), total, page, limit };
  }

  /** @param {any} raw @param {string} adminUserId @param {string} [id] */
  async saveAdmin(raw, adminUserId, id) {
    await this.ensureSeeds();
    const next = normalizeEntry(raw);
    const old = id ? await this.col.findOne({ id }) : null;
    if (id && !old) throw channelError(404, "player_not_found", "Player entry was not found.");
    if (old && raw.revision !== undefined && raw.revision !== (old.revision || 0)) throw channelError(409, "player_channels_changed", "This player entry changed. Refresh it before approving or saving.");
    const entryId = id || randomUUID();
    const expanded = (await this.expandIdentities([
      ...next.pulseCharacterIds.map((pulseCharacterId) => ({ pulseCharacterId })),
      ...next.toonHandles.map((toonHandle) => ({ toonHandle })),
    ])).flat();
    next.identityKeys = [...new Set([...next.identityKeys, ...expanded])];
    await this.assertAvailable(next.identityKeys, entryId);
    const now = new Date();
    const preserveOwner = old?.source === "self" && old.ownerUserId;
    const doc = stampVersion({ ...next, id: entryId, revision: (old?.revision || 0) + 1, source: preserveOwner ? "self" : "admin", ...(preserveOwner ? { ownerUserId: old.ownerUserId, approvedIdentityKeys: next.identityKeys, approvedDisplayName: next.displayName } : {}), pending: false, approvedAt: now, reviewedBy: adminUserId, updatedAt: now, updatedBy: adminUserId, createdAt: old?.createdAt || now }, COLLECTIONS.PLAYER_CHANNELS);
    try {
      const result = await this.col.updateOne({ id: entryId, ...(old ? revisionMatch(old) : {}) }, { $set: doc, $unset: { pendingChannels: "", ...(!preserveOwner ? { ownerUserId: "" } : {}) } }, { upsert: !old });
      if (old && !result.matchedCount) throw channelError(409, "player_channels_changed", "This player entry changed. Refresh it before approving or saving.");
    } catch (err) { throw duplicateConflict(err); }
    return { entry: managementEntry(doc, true) };
  }

  /** @param {string} id @param {string} adminUserId */
  async removeAdmin(id, adminUserId) {
    // A durable tombstone keeps upstream and curated imports from resurrecting removed links.
    const result = await this.col.updateOne({ id }, { $set: { removed: true, pending: false, channels: { twitch: null, youtube: null }, source: "admin", updatedAt: new Date(), updatedBy: adminUserId }, $inc: { revision: 1 }, $unset: { ownerUserId: "", pendingChannels: "" } });
    if (!result.matchedCount) throw channelError(404, "player_not_found", "Player entry was not found.");
    return { ok: true };
  }

  /** @param {string[]} keys @param {string} [exceptId] */
  async assertAvailable(keys, exceptId) {
    const conflict = await this.col.findOne({ identityKeys: { $in: keys }, ...(exceptId ? { id: { $ne: exceptId } } : {}) }, { projection: { id: 1 } });
    if (conflict) throw channelError(409, "player_identity_conflict", "An entry already uses this player identity. Edit that entry instead.");
  }

  /** @param {string} userId */
  async savedIdentities(userId) {
    const user = await this.db.users.findOne({ userId }, { projection: { pulseIds: 1, pulseId: 1, displayName: 1 } });
    const values = Array.isArray(user?.pulseIds) ? user.pulseIds : [user?.pulseId];
    /** @type {any[]} */ const identities = [];
    for (const value of [...new Set(values)]) {
      try { identities.push(normalizeIdentity(TOON_ID.test(value || "") ? { toonHandle: value } : { pulseCharacterId: value })); } catch { /* Legacy profile values are not public identity keys. */ }
    }
    return { identities, displayName: user?.displayName || "Player" };
  }

  /** @param {string} userId */
  async getSelf(userId) {
    await this.ensureSeeds();
    const { identities } = await this.savedIdentities(userId);
    const keySets = await this.expandIdentities(identities);
    const keys = keySets.flat();
    const rows = await this.col.find({ $or: [{ ownerUserId: userId }, { identityKeys: { $in: keys } }] }).toArray();
    const matchedIdentities = identities.map((identity, index) => {
      const matches = rows.filter((row) => row.identityKeys.some((/** @type {string} */ key) => keySets[index].includes(key)));
      return { ...identity, ...(matches.length === 1 ? { entryId: matches[0].id } : {}) };
    });
    return { entries: rows.map((entry) => managementEntry(entry, entry.source === "self" && entry.ownerUserId === userId)), identities: matchedIdentities, canConnect: identities.length > 0 };
  }

  /** @param {string} userId @param {any} raw */
  async saveSelf(userId, raw) {
    await this.ensureSeeds();
    const saved = await this.savedIdentities(userId);
    const channels = normalizeChannels(raw?.channels);
    if (typeof raw?.id === "string" && !channels.twitch && !channels.youtube) {
      const result = await this.col.updateOne({ id: raw.id, ownerUserId: userId, source: "self" }, { $set: { channels, pending: false, removed: true, updatedAt: new Date() }, $inc: { revision: 1 }, $unset: { pendingChannels: "" } });
      if (!result.matchedCount) throw channelError(404, "player_not_found", "Your connected player entry was not found.");
      return this.getSelf(userId);
    }
    if (!saved.identities.length) throw channelError(400, "profile_identity_required", "Add your SC2Pulse profile or Battle.net toon handle in your profile first.");
    const selected = raw?.identities === undefined ? saved.identities : raw.identities;
    if (!Array.isArray(selected) || !selected.length || selected.length > 20) throw channelError(400, "invalid_player_identity", "Select one or more of your saved player identities.");
    const identities = selected.map(normalizeIdentity);
    const allowed = new Set(saved.identities.flatMap(identityKeys));
    if (identities.flatMap(identityKeys).some((key) => !allowed.has(key))) throw channelError(403, "profile_identity_required", "Channels can only be connected to your saved player identities.");
    const expanded = [...new Set((await this.expandIdentities(identities)).flat())];
    const matches = await this.col.find({ identityKeys: { $in: expanded } }).toArray();
    if (matches.some((entry) => entry.ownerUserId !== userId || entry.source !== "self")) throw channelError(409, "player_channels_managed", "This player is already managed in the shared directory. An administrator can update its channels.");
    if (matches.length > 1) throw channelError(409, "player_identity_conflict", "These identities belong to separate directory entries. Select one player at a time.");
    const old = matches[0];
    const pulseCharacterIds = [...new Set([...(old?.pulseCharacterIds || []), ...identities.map((p) => p.pulseCharacterId).filter(Boolean)])];
    const toonHandles = [...new Set([...(old?.toonHandles || []), ...identities.map((p) => p.toonHandle).filter(Boolean)])];
    const entry = normalizeEntry({ displayName: raw?.displayName || old?.displayName || saved.displayName, pulseCharacterIds, toonHandles, channels, removed: !channels.twitch && !channels.youtube });
    const now = new Date();
    const withdrawn = !channels.twitch && !channels.youtube;
    const doc = stampVersion({ ...entry, revision: (old?.revision || 0) + 1, channels: withdrawn ? channels : old?.channels || {}, approvedIdentityKeys: old?.approvedIdentityKeys || [], pendingChannels: withdrawn ? null : channels, pending: !withdrawn, identityKeys: [...new Set([...(old?.identityKeys || []), ...entry.identityKeys, ...expanded])], id: old?.id || randomUUID(), source: "self", ownerUserId: userId, createdAt: old?.createdAt || now, updatedAt: now }, COLLECTIONS.PLAYER_CHANNELS);
    try {
      if (old) {
        const result = await this.col.updateOne({ id: old.id, ownerUserId: userId, source: "self", ...revisionMatch(old) }, { $set: doc });
        if (!result.matchedCount) throw channelError(409, "player_channels_managed", "This player entry changed. Refresh before saving again.");
      } else await this.col.insertOne(doc);
    } catch (err) { throw duplicateConflict(err); }
    return this.getSelf(userId);
  }

  /** Import public source rows while preserving all local edits and removals.
   * @param {any[]} rows @param {string} source @param {boolean} [seedOnly]
   */
  async importRows(rows, source, seedOnly = false) {
    let imported = 0; let updated = 0; let skipped = 0;
    for (const raw of rows) {
      let entry;
      try { entry = normalizeEntry(raw); } catch { skipped++; continue; }
      const matches = await this.col.find({ identityKeys: { $in: entry.identityKeys } }).toArray();
      const old = matches[0];
      const protectedEntry = old && (old.removed || old.source === "admin" || old.source === "self" || (seedOnly && old.source === "curated"));
      if (matches.length > 1 || protectedEntry) { skipped++; continue; }
      const now = new Date();
      // Curated fills known missing channels while retaining Pulse's existing Twitch data.
      const channels = old ? { ...old.channels } : {};
      const curatedPlatforms = old?.curatedPlatforms || (old?.source === "curated" ? ["youtube"] : []);
      for (const platform of PLATFORMS) if (entry.channels[platform] && !(source !== "curated" && curatedPlatforms.includes(platform) && channels[platform])) channels[platform] = entry.channels[platform];
      const mergedSource = old?.source === "curated" ? "curated" : source;
      const doc = stampVersion({ ...entry, revision: (old?.revision || 0) + 1, pulseCharacterIds: [...new Set([...(old?.pulseCharacterIds || []), ...entry.pulseCharacterIds])], toonHandles: [...new Set([...(old?.toonHandles || []), ...entry.toonHandles])], identityKeys: [...new Set([...(old?.identityKeys || []), ...entry.identityKeys])], channels, curatedPlatforms: source === "curated" ? ["youtube"] : curatedPlatforms, id: old?.id || randomUUID(), source: mergedSource, createdAt: old?.createdAt || now, updatedAt: now, importedAt: now, sources: Array.isArray(raw.sources) ? raw.sources.filter((/** @type {any} */ url) => typeof url === "string").slice(0, 10) : [] }, COLLECTIONS.PLAYER_CHANNELS);
      try {
        if (old) {
          const result = await this.col.updateOne({ id: old.id, source: old.source, removed: { $ne: true }, ...revisionMatch(old) }, { $set: doc });
          if (result.matchedCount) updated++; else skipped++;
        } else { await this.col.insertOne(doc); imported++; }
      } catch (err) { if (/** @type {any} */ (err)?.code === 11000) skipped++; else throw err; }
    }
    return { imported, updated, skipped, total: rows.length };
  }

  async importPulse() {
    await this.ensureSeeds();
    if (!this.importPromise) this.importPromise = this.fetchAndImportPulse().finally(() => { this.importPromise = null; });
    return this.importPromise;
  }

  async fetchAndImportPulse() {
    const roster = await this.fetchPulseArray("/revealed/players");
    const ids = roster.map((row) => String(row?.id || "")).filter((id) => NUMERIC_ID.test(id));
    if (!ids.length || ids.length > 10000) throw channelError(502, "pulse_import_unavailable", "SC2Pulse returned an unexpected player directory.");
    /** @type {any[]} */ const payload = [];
    // Four bounded workers, batch 100; do not fan out one request per player.
    for (let offset = 0; offset < ids.length; offset += 400) {
      const batches = [];
      for (let start = offset; start < Math.min(offset + 400, ids.length); start += 100) batches.push(this.fetchPulseArray(`/revealed/player/${ids.slice(start, start + 100).join(",")}/full`));
      const results = await Promise.all(batches);
      payload.push(...results.flat());
    }
    // Finish the remote read before any writes, so upstream errors preserve the directory.
    const rows = payload.map(pulseImportEntry).filter(Boolean);
    return this.importRows(rows, "sc2pulse");
  }

  /** @param {string} path @returns {Promise<any[]>} */
  async fetchPulseArray(path) {
    try {
      const response = await this.fetchImpl(`https://sc2pulse.nephest.com/sc2/api${path}`, { headers: { Accept: "application/json", "User-Agent": "SC2Tools player channel directory (+https://sc2tools.com)" }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error("pulse_unavailable");
      const payload = await response.json();
      if (!Array.isArray(payload)) throw new Error("unexpected_pulse_response");
      return payload;
    } catch {
      throw channelError(502, "pulse_import_unavailable", "SC2Pulse is unavailable. Your existing directory has been preserved.");
    }
  }
}

/** @param {any} raw */
function pulseImportEntry(raw) {
  const pro = raw?.proPlayer || raw;
  if (!pro?.id || !pro?.nickname) return null;
  /** @type {Record<string,string|null>} */ const channels = {};
  for (const link of Array.isArray(raw.links) ? raw.links : []) {
    const platform = String(link.type || "").toLowerCase();
    if (!PLATFORMS.includes(platform)) continue;
    try { channels[platform] = normalizeChannelUrl(platform, link.url); } catch { /* Upstream invalid URLs are never published. */ }
  }
  if (!channels.twitch && !channels.youtube) return null;
  return { displayName: pro.nickname, proId: String(pro.id), channels, sources: ["https://sc2pulse.nephest.com/"] };
}

/** @param {any} channels @returns {Record<string,string>} */
function publicChannels(channels) {
  return Object.fromEntries(PLATFORMS.filter((key) => typeof channels?.[key] === "string" && channels[key]).map((key) => [key, channels[key]]));
}

/** @param {any} entry @param {boolean} editable */
function managementEntry(entry, editable) {
  return { id: entry.id, revision: entry.revision || 0, displayName: entry.displayName, pulseCharacterIds: entry.pulseCharacterIds || [], toonHandles: entry.toonHandles || [], proId: entry.proId || null, channels: editable && entry.pending && entry.pendingChannels ? entry.pendingChannels : entry.channels || {}, approvedChannels: entry.channels || {}, pending: entry.pending === true, source: entry.source, removed: entry.removed === true, updatedAt: entry.updatedAt, editable };
}

/** @param {any} entry */
function revisionMatch(entry) {
  return { revision: typeof entry.revision === "number" ? entry.revision : { $exists: false } };
}

/** @param {unknown} err */
function duplicateConflict(err) {
  return /** @type {any} */ (err)?.code === 11000 ? channelError(409, "player_identity_conflict", "Another entry already uses this player identity. Refresh the directory.") : err;
}

function loadSeeds() {
  // Only reviewed, attributed real-world seed data is shipped in this file.
  try { return require("../../data/player-channel-seeds.json").entries || []; } catch (err) { if (/** @type {any} */ (err)?.code === "MODULE_NOT_FOUND") return []; throw err; }
}

function loadPulseSeeds() {
  try { return require("../../data/player-channel-pulse-seeds.json").entries || []; } catch (err) { if (/** @type {any} */ (err)?.code === "MODULE_NOT_FOUND") return []; throw err; }
}

module.exports = { PlayerChannelsService, normalizeChannelUrl, normalizeChannels, normalizeIdentity, pulseImportEntry, MAX_PLAYERS };
