"use strict";

const { OwnerRevisions } = require("../util/gameVisibility");
const { playerIdentity, exactKeys } = require("./playerIdentityDirectory");

const MAX_ACCOUNTS = 20;
const TTL_MS = 60_000;
const MAX_CACHE = 512;
const CID = /^[1-9]\d{0,19}$/;
const TOON = /^\d+-S2-\d+-\d+$/;
const projection = Object.freeze({ _id: 0, pulseId: 1, pulseCharacterId: 1, toonHandle: 1, displayNameSample: 1,
  revealedName: 1, wins: 1, losses: 1, gameCount: 1, firstSeen: 1, lastSeen: 1 });
const count = (/** @type {unknown} */ n) => typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : 0;
const name = (/** @type {any} */ row) => String(row.displayNameSample || row.revealedName || "").trim().slice(0, 120);

/** @param {any} doc @param {any[]} [members] @param {string|null} [key] */
function identityContext(doc, members = [doc], key = null) {
  const unique = [...new Map([doc, ...members].filter(Boolean).map(row => [row.pulseId, row])).values()].slice(0, MAX_ACCOUNTS);
  return {
    groupKey: key || `single:${doc.pulseId}`,
    pulseIds: unique.map(row => row.pulseId).filter(value => typeof value === "string" && TOON.test(value)),
    characterIds: [...new Set(unique.map(row => String(row.pulseCharacterId || "")).filter(value => CID.test(value)))],
    identities: unique, mergedAccounts: unique.length,
    alsoPlaysAs: [...new Set(unique.filter(row => row.pulseId !== doc.pulseId).map(name).filter(Boolean))].slice(0, 19),
    wins: unique.reduce((n, row) => n + count(row.wins), 0), losses: unique.reduce((n, row) => n + count(row.losses), 0),
    gameCount: unique.reduce((n, row) => n + count(row.gameCount), 0),
  };
}

/** Cache-only identity expansion. Never calls Pulse, corpus aggregates or detail storage. */
class ScoutingIdentitiesService {
  /** @param {import('../db/connect').DbContext} db @param {{now?:()=>number}} [opts] */
  constructor(db, opts = {}) {
    this.db = db; this.now = opts.now || Date.now;
    /** @type {Map<string, {at:number,value:any}>} */ this.cache = new Map();
    /** @type {Map<string, {at:number,value:boolean}>} */ this.preferences = new Map();
    this.revisions = new OwnerRevisions();
  }
  /** @param {string} userId */
  invalidateForUser(userId) {
    this.revisions.invalidate(userId); this.preferences.delete(userId);
    for (const key of this.cache.keys()) if (key.startsWith(`${userId}|`)) this.cache.delete(key);
  }
  clear() { this.cache.clear(); this.preferences.clear(); this.revisions = new OwnerRevisions(); }
  /** A synchronous hint for the enrichment key; expiry forces an admitted refresh. @param {string} userId @param {string|null} cid @param {string|null} toon */
  cacheKey(userId, cid, toon) {
    const pref = this.preferences.get(userId);
    if (pref && this.now() - pref.at < TTL_MS && pref.value === false) return "single:preference-off";
    const hit = this.cache.get(`${userId}|${cid || ""}|${toon || ""}`)
      || (cid ? [...this.cache].find(([key]) => key.startsWith(`${userId}|${cid}|`))?.[1] : null);
    return hit && this.now() - hit.at < TTL_MS ? `${hit.value.groupKey}:${hit.value.pulseIds.join(",")}` : "unresolved";
  }
  /** @param {Map<any,any>} cache @param {string} key @param {any} value */
  remember(cache, key, value) {
    cache.delete(key); cache.set(key, { at: this.now(), value });
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value || "");
  }
  /** @param {string} userId */
  async enabled(userId) {
    const hit = this.preferences.get(userId);
    if (hit && this.now() - hit.at < TTL_MS) return hit.value;
    const revision = this.revisions.get(userId);
    const row = this.db.users ? await this.db.users.findOne({ userId }, { projection: { _id: 0, "preferences.opponentScouting.groupByPlayer": 1 }, maxTimeMS: 1000 }) : null;
    const value = row?.preferences?.opponentScouting?.groupByPlayer !== false;
    if (this.revisions.current(userId, revision)) this.remember(this.preferences, userId, value);
    return this.revisions.current(userId, revision) ? value : false;
  }
  /** @param {string} userId @param {any} doc @param {boolean} [allowMerge] */
  async resolve(userId, doc, allowMerge = true) {
    const single = identityContext(doc);
    if (!allowMerge || !userId || !doc?.pulseId) return single;
    const revision = this.revisions.get(userId), key = `${userId}|${doc.pulseCharacterId || ""}|${doc.pulseId}`;
    try { if (!await this.enabled(userId)) return single; } catch { return single; }
    if (!this.revisions.current(userId, revision)) return single;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < TTL_MS) return hit.value;
    let value;
    try { value = await this.load(userId, doc); } catch { value = single; }
    if (!this.revisions.current(userId, revision)) return single;
    this.remember(this.cache, key, value);
    return value;
  }
  /** @param {string} userId @param {any} doc */
  async load(userId, doc) {
    const single = identityContext(doc), identity = playerIdentity(doc);
    if (!identity) return single;
    const exact = exactKeys(doc);
    const linkMatch = [identity.pulseCharacterId && { pulseCharacterId: identity.pulseCharacterId }, identity.toonHandle && { toonHandle: identity.toonHandle }].filter(Boolean);
    const cached = this.db.pulseCharacterLinks ? await this.db.pulseCharacterLinks.find({ $or: linkMatch }, { projection: { _id: 0, pulseCharacterId: 1, toonHandle: 1, accountId: 1 }, maxTimeMS: 1000 }).limit(21).toArray() : [];
    if (cached.length > 20 || cached.some(row => (identity.pulseCharacterId && row.pulseCharacterId !== identity.pulseCharacterId)
      || (identity.toonHandle && row.toonHandle && row.toonHandle !== identity.toonHandle))) return single;
    const accountIds = [...new Set(cached.map(row => row.accountId).filter(value => typeof value === "string" && value.length <= 100))];
    const keys = [...exact, ...accountIds.map(id => `acct:${id}`)];
    const approved = this.db.playerIdentities ? await this.db.playerIdentities.find({ active: true, $or: [{ sourceKeys: { $in: keys } }, { targetKeys: { $in: keys } }] },
      { projection: { _id: 0, groupKey: 1, revision: 1, "target.key": 1, "target.pulseId": 1, "target.pulseCharacterId": 1, "target.toonHandle": 1, "target.displayName": 1, "target.race": 1, "target.region": 1, sourceKeys: { $slice: 41 }, targetKeys: { $slice: 41 } }, maxTimeMS: 1000 }).limit(21).toArray() : [];
    const groups = [...new Set(approved.map(row => row.groupKey).filter(value => typeof value === "string" && value.length <= 200))];
    if (approved.length > 20 || groups.length > 1 || accountIds.length > 1
      || approved.some(row => (row.sourceKeys || []).length > 40 || (row.targetKeys || []).length > 40)) return single;
    const groupKey = groups[0] || (accountIds[0] ? `acct:${accountIds[0]}` : null);
    if (!groupKey) return single;
    const cids = new Set(single.characterIds), toons = new Set(single.pulseIds);
    if (approved.length) {
      const targetKeys = [...new Set(approved.flatMap(row => Array.isArray(row.targetKeys) ? row.targetKeys : []))].slice(0, 40);
      const members = await this.db.playerIdentities.find({ active: true, targetKeys: { $in: targetKeys } },
        { projection: { _id: 0, groupKey: 1, sourceKeys: { $slice: 41 }, targetKeys: { $slice: 41 } }, maxTimeMS: 1000 }).limit(21).toArray();
      if (members.length > 20 || members.some(row => row.groupKey !== groupKey
        || (row.sourceKeys || []).length > 40 || (row.targetKeys || []).length > 40)) return single;
      for (const edge of [...approved, ...members]) for (const key of [...(edge.sourceKeys || []), ...(edge.targetKeys || [])]) {
        if (typeof key !== "string") continue;
        if (key.startsWith("pulse:") && CID.test(key.slice(6))) cids.add(key.slice(6));
        if (key.startsWith("toon:") && TOON.test(key.slice(5))) toons.add(key.slice(5));
        if (key.startsWith("acct:") && key.length <= 105) accountIds.push(key.slice(5));
      }
    }
    if (accountIds.length && this.db.pulseCharacterLinks) {
      const siblings = await this.db.pulseCharacterLinks.find({ accountId: { $in: [...new Set(accountIds)].slice(0, 20) } },
        { projection: { _id: 0, pulseCharacterId: 1 }, maxTimeMS: 1000 }).sort({ pulseCharacterId: 1 }).limit(21).toArray();
      for (const sibling of siblings) if (CID.test(sibling.pulseCharacterId || "")) cids.add(sibling.pulseCharacterId);
    }
    const ids = [...cids].slice(0, MAX_ACCOUNTS), handles = [...toons].slice(0, MAX_ACCOUNTS);
    const rows = await this.db.opponents.find({ userId, $or: [{ pulseCharacterId: { $in: ids } }, { pulseId: { $in: handles } }] },
      { projection, maxTimeMS: 1000 }).sort({ pulseCharacterId: 1, pulseId: 1 }).limit(MAX_ACCOUNTS).toArray();
    // The live row remains authoritative and first even if the catalog cap is hit.
    const target = approved[0]?.target ? playerIdentity(approved[0].target) : null;
    return { ...identityContext(doc, rows, groupKey), ...(target ? { globalIdentity: {
      groupKey, displayName: target.displayName, target, revision: count(approved[0].revision),
    } } : {}) };
  }
}

module.exports = { ScoutingIdentitiesService, identityContext, MAX_ACCOUNTS, TTL_MS, projection };
