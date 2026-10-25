"use strict";
const { createHash } = require("crypto");
const { gamesMatchStage, resultBucket } = require("../util/parseQuery");
const { sanitizeRivals, MAX_RIVALS } = require("../util/rivalsPreferences");
const { OPP_INTENT_LABEL_PROJECTION } = require("./buildIntentShape");
const { summarizeOpponentTendencies } = require("./scouting/opponentTendencies");

const MAX_IDS = 500, MAX_RECENT = 2000, SAMPLE_SIZE = 20, CACHE_MS = 60000, CACHE_SIZE = 256, MAX_ACTIVE = 4;
const invalid = () => Object.assign(new Error("Choose at most 50 rivals and 500 recorded accounts."), { status: 400, code: "invalid_rivals_summary" });
/** @param {any} raw @returns {Array<{key:string,pulseIds:string[],primaryPulseId:string}>} */
function parseRivalGroups(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_RIVALS) throw invalid();
  const ids = new Set(), keys = new Set();
  return raw.map(group => {
    if (!group || typeof group !== "object" || Object.keys(group).some(key => !["key", "pulseIds", "primaryPulseId"].includes(key)) || typeof group.key !== "string" || group.key.length > 320 || !group.key.length || /[\u0000-\u001f\u007f]/u.test(group.key) || keys.has(group.key) || !Array.isArray(group.pulseIds) || !group.pulseIds.length || (group.primaryPulseId !== undefined && !group.pulseIds.includes(group.primaryPulseId))) throw invalid();
    keys.add(group.key);
    for (const id of group.pulseIds) {
      if (typeof id !== "string" || !id.length || id.length > 160 || /[\u0000-\u001f\u007f]/u.test(id) || ids.has(id)) throw invalid();
      ids.add(id); if (ids.size > MAX_IDS) throw invalid();
    }
    return { key: group.key, pulseIds: group.pulseIds.slice().sort(), primaryPulseId: group.primaryPulseId || group.pulseIds[0] };
  }).sort((a,b) => a.key.localeCompare(b.key));
}

/** @param {any[]} rows newest first @param {number} total */
function summarizeRival(rows, total) {
  const first = resultBucket(rows[0]?.result);
  let count = 0;
  if (first) for (const row of rows) { if (resultBucket(row.result) !== first) break; count++; }
  const opening = summarizeOpponentTendencies(rows).favOpening || null;
  return { sampleGames: rows.length, matchingGames: total, lastMeeting: rows[0]?.date || null,
    streak: first ? { kind: first, count, atLeast: count === rows.length && total > rows.length } : null, usualOpener: opening };
}

class RivalsService {
  /** @param {{games:import('mongodb').Collection,opponents:import('mongodb').Collection,pulseCharacterLinks?:import('mongodb').Collection}} db
   * @param {{users:{getPreferences(userId:string,type:string):Promise<any>},pulse?:import('./rivalsPulse').RivalsPulseService,channels?:import('./playerChannels').PlayerChannelsService,viewers?:import('./multichatViewers').MultichatViewersService,identities?:import('./playerIdentities').PlayerIdentitiesService,now?:()=>number}} deps */
  constructor(db, deps) {
    this.db = db; this.deps = deps; this.now = deps.now || (() => Date.now());
    /** @type {Map<string,{at:number,value:any,owner:string}>} */ this.cache = new Map();
    /** @type {Map<string,{owner:string,valid:boolean,promise:Promise<any>}>} */ this.inflight = new Map();
  }
  /** One bounded slim-game facet, with optional metadata for at most 50 stored
   * stars. Client identity bundles are ownership-checked in one batch before
   * any public provider work. No replay detail or private integration reads.
   * @param {string} userId @param {any} raw @param {import('../util/parseQuery').GlobalFilters} filters */
  async summary(userId, raw, filters = {}) {
    const groups = parseRivalGroups(raw);
    const prefs = sanitizeRivals(await this.deps.users.getPreferences(userId, "rivals"));
    if (groups.some(group => !prefs.keys.includes(group.key))) throw invalid();
    const ids = groups.flatMap(group => group.pulseIds);
    const owned = ids.length ? await this.db.opponents.find({ userId, pulseId: { $in: ids } }, { projection: { _id: 0, pulseId: 1, pulseCharacterId: 1, toonHandle: 1 } }).limit(MAX_IDS).toArray() : [];
    const byId = new Map(owned.map(row => [row.pulseId, row]));
    if (ids.some(id => !byId.has(id))) throw invalid();
    const key = createHash("sha256").update(JSON.stringify([userId, filters, groups])).digest("hex");
    let hit = this.cache.get(key), value;
    if (hit && this.now() - hit.at < CACHE_MS) { this.cache.delete(key); this.cache.set(key, hit); value = hit.value; }
    else if (this.inflight.has(key)) {
      const flight = this.inflight.get(key);
      value = await flight?.promise;
      if (!flight?.valid) throw Object.assign(new Error("Rival details changed. Try again."), { status: 503, code: "rivals_changed" });
    }
    else {
      if (this.inflight.size >= MAX_ACTIVE) throw Object.assign(new Error("Rival summaries are busy. Try again shortly."), { status: 503, code: "rivals_busy" });
      const flight = { owner: userId, valid: true, promise: /** @type {Promise<any>} */ (Promise.resolve(null)) };
      const job = this.aggregate(userId, groups, filters).then(result => {
        if (!flight.valid) throw Object.assign(new Error("Rival details changed. Try again."), { status: 503, code: "rivals_changed" });
        this.cache.delete(key); this.cache.set(key, { at: this.now(), value: result, owner: userId });
        while (this.cache.size > CACHE_SIZE) { const oldest = this.cache.keys().next().value; if (oldest !== undefined) this.cache.delete(oldest); }
        return result;
      }).finally(() => { this.inflight.delete(key); });
      flight.promise = job; this.inflight.set(key, flight); value = await job;
    }
    const primaries = groups.map(group => byId.get(group.primaryPulseId));
    const pulseIds = primaries.map(row => row?.pulseCharacterId).filter(id => typeof id === "string");
    const pulse = this.deps.pulse ? await this.deps.pulse.batch(pulseIds) : {};
    const identities = primaries.map(row => row?.pulseCharacterId ? { pulseCharacterId: row.pulseCharacterId, ...(row.toonHandle ? { toonHandle: row.toonHandle } : {}) } : row?.toonHandle ? { toonHandle: row.toonHandle } : null);
    const valid = identities.filter(Boolean);
    const resolved = this.deps.channels && valid.length ? (await this.deps.channels.resolve(valid, { cachedOnly: true })).players : [];
    let resolvedIndex = 0;
    return { ...value, rivals: groups.map((group,index) => {
      const channels = identities[index] ? resolved[resolvedIndex++]?.channels || {} : {};
      const live = ["twitch", "youtube"].flatMap(platform => {
        const url = channels[platform];
        if (!url || !this.deps.viewers) return [];
        const channel = platform === "twitch" ? new URL(url).pathname.slice(1) : url;
        const observation = this.deps.viewers.peekPublicLive(/** @type {'twitch'|'youtube'} */ (platform), channel);
        return observation?.live ? [{ platform, url, observedAt: observation.observedAt }] : [];
      });
      return { key: group.key, ...(value.rivals[group.key] || summarizeRival([],0)), pulse: pulse[primaries[index]?.pulseCharacterId] || null, live };
    }) };
  }
  /** Generation fence stays attached to the admitted job until it settles,
   * so repeated hides cannot bypass the four-job cap or republish old rows.
   * @param {string} userId */
  invalidateForUser(userId) {
    for (const [key, entry] of this.cache) if (entry.owner === userId) this.cache.delete(key);
    for (const entry of this.inflight.values()) if (entry.owner === userId) entry.valid = false;
  }
  /** Cheap private header/overlay identity lookup. Cached public aliases only;
   * a dossier star must not request all of the owner's Pulse links.
   * @param {string} userId @param {string} pulseId */
  async identityKeys(userId, pulseId) {
    const row = await this.db.opponents.findOne({ userId, pulseId }, { projection: { _id: 0, pulseId: 1, pulseCharacterId: 1, toonHandle: 1 } });
    return row ? { keys: await this.keysForIdentity(row) } : null;
  }
  /** @param {any} row */
  async keysForIdentity(row) {
    const [confirmed, link] = await Promise.all([
      this.deps.identities ? this.deps.identities.resolveMany([row]) : Promise.resolve([]),
      this.db.pulseCharacterLinks && row.pulseCharacterId ? this.db.pulseCharacterLinks.findOne({ pulseCharacterId: row.pulseCharacterId }, { projection: { _id: 0, proId: 1, accountId: 1 } }) : Promise.resolve(null),
    ]);
    return [...new Set([confirmed[0]?.groupKey, link?.proId ? `pro:${link.proId}` : null, link?.accountId ? `acct:${link.accountId}` : null, `solo:${row.pulseId}`].filter(key => typeof key === "string"))];
  }
  /** @param {string} userId @param {any} row */
  async isStarred(userId, row) {
    const prefs = sanitizeRivals(await this.deps.users.getPreferences(userId, "rivals"));
    if (!prefs.keys.length || !row?.pulseId) return false;
    const candidates = await this.keysForIdentity(row);
    return candidates.some(key => prefs.keys.includes(key));
  }
  /** @param {string} userId @param {Array<{key:string,pulseIds:string[]}>} groups @param {import('../util/parseQuery').GlobalFilters} filters */
  async aggregate(userId, groups, filters) {
    const now = this.now(), since = new Date(now - 7 * 86400000);
    const ids = groups.flatMap(group => group.pulseIds);
    const match = { ...gamesMatchStage(userId, filters), excluded: { $ne: true }, _deleted: { $ne: true }, _deletionPending: { $ne: true } };
    const groupExpr = groups.length ? { $switch: { branches: groups.map(group => ({ case: { $in: ["$opponent.pulseId", group.pulseIds] }, then: { $literal: group.key } })), default: null } } : null;
    const result = await this.db.games.aggregate([
      { $match: match }, { $match: { date: { $lte: new Date(now) }, "opponent.pulseId": { $type: "string", $ne: "" }, $or: [{ date: { $gte: since } }, { "opponent.pulseId": { $in: ids } }] } },
      { $project: { date: 1, result: 1, durationSec: 1, "opponent.pulseId": 1, "opponent.strategy": 1, ...OPP_INTENT_LABEL_PROJECTION } },
      { $facet: {
        recent: [{ $match: { date: { $gte: since } } }, { $group: { _id: "$opponent.pulseId", games: { $sum: 1 } } }, { $sort: { _id: 1 } }, { $limit: MAX_RECENT + 1 }],
        rivals: [{ $match: { "opponent.pulseId": { $in: ids } } }, { $group: { _id: groupExpr, total: { $sum: 1 }, sample: { $topN: { n: SAMPLE_SIZE, sortBy: { date: -1, _id: -1 }, output: "$$ROOT" } } } }],
      } },
    ], { maxTimeMS: 10000, allowDiskUse: false }).toArray();
    const recordedGame = await this.db.games.findOne({ userId, _deleted: { $ne: true }, _deletionPending: { $ne: true } }, { projection: { _id: 1 }, maxTimeMS: 3000 });
    const facet = result[0] || { recent: [], rivals: [] };
    /** @type {any[]} */ const recent = facet.recent;
    /** @type {any[]} */ const rivals = facet.rivals;
    return { generatedAt: new Date(now).toISOString(), hasAnyGames: !!recordedGame, recentComplete: recent.length <= MAX_RECENT,
      weekGames: Object.fromEntries(recent.slice(0,MAX_RECENT).map(row => [row._id, row.games])),
      rivals: Object.fromEntries(rivals.filter(row => row._id !== null).map(row => [row._id, summarizeRival(row.sample, row.total)])) };
  }
}
module.exports = { RivalsService, parseRivalGroups, summarizeRival, MAX_IDS, MAX_RECENT, SAMPLE_SIZE };
