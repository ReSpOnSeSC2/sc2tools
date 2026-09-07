"use strict";

const { randomUUID } = require("crypto");
const { ObjectId } = require("mongodb");
const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");
const { isBarcodeLikeName } = require("./opponentIdentityMatcher");
const { PlayerIdentityDirectory, playerIdentity, exactKeys } = require("./playerIdentityDirectory");
const { opponentGamesFilter } = require("../util/opponentIdentity");

/** @param {number} status @param {string} message */
function identityError(status, message) { return Object.assign(new Error(message), { status, code: "player_identity_error" }); }
/** @param {any} text @param {number} min */
function explanation(text, min = 10) {
  if (typeof text !== "string" || text.trim().length < min || text.trim().length > 2000) throw identityError(400, `Enter an explanation between ${min} and 2,000 characters.`);
  return text.trim();
}
/** @param {any} value */
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw identityError(400, "A current revision is required. Refresh and try again.");
  return value;
}
/** @param {any} row @param {boolean} admin */
function submissionDto(row, admin = false) {
  if (!row) return null;
  const { id, source, target, reason, status, createdAt, updatedAt, reviewNote, revision: rev, evidenceCount } = row;
  return { id, source, target, reason, status, createdAt, updatedAt, reviewNote: reviewNote || null, revision: rev, evidenceCount, ...(admin ? { submitterUserId: row.userId } : {}) };
}

class PlayerIdentitiesService {
  /** @param {import('../db/connect').DbContext} db @param {{fetchImpl?:typeof fetch}} [opts] */
  constructor(db, opts = {}) {
    this.db = db;
    this.links = db.playerIdentities;
    this.submissions = db.playerIdentitySubmissions;
    this.directory = new PlayerIdentityDirectory(db);
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
  }

  /** Verify a pasted character profile against a fixed upstream endpoint before adding it. @param {any} profile */
  async importPulse(profile) {
    if (typeof profile !== "string" || profile.length > 500) throw identityError(400, "Paste an SC2Pulse character profile link or character ID.");
    let id = profile.trim();
    if (!/^[1-9]\d{0,19}$/.test(id)) {
      let url;
      try { url = new URL(id); } catch { url = null; }
      if (!url || url.hostname !== "sc2pulse.nephest.com" || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port || !/^\/sc2\/?$/.test(url.pathname) || url.searchParams.get("type") !== "character") throw identityError(400, "Use an SC2Pulse character profile link (type=character), or its numeric character ID.");
      id = url.searchParams.get("id") || "";
    }
    if (!/^[1-9]\d{0,19}$/.test(id)) throw identityError(400, "That link does not contain a valid character ID.");
    let payload;
    try {
      const response = await this.fetchImpl(`https://sc2pulse.nephest.com/sc2/api/group/character/full?characterId=${id}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000), redirect: "error" });
      if (!response.ok) throw new Error("upstream unavailable");
      const text = await response.text();
      payload = text ? JSON.parse(text) : [];
    } catch { throw identityError(503, "SC2Pulse could not verify this profile. Please try again shortly."); }
    const member = Array.isArray(payload) ? payload.find((entry) => String(entry?.members?.character?.id) === id)?.members : null;
    if (!member?.character || !member.account?.id) throw identityError(404, "SC2Pulse could not find that character. Check the profile link or ID.");
    const ch = member.character;
    const region = /** @type {Record<string,string>} */ ({ US: "1", NA: "1", EU: "2", KR: "3", CN: "5", SEA: "6" })[String(ch.region).toUpperCase()];
    const toonHandle = region && /^\d+$/.test(String(ch.realm)) && /^\d+$/.test(String(ch.battlenetId)) ? `${region}-S2-${ch.realm}-${ch.battlenetId}` : null;
    const displayName = member.proNickname || ch.name;
    if (typeof displayName !== "string" || !displayName.trim()) throw identityError(503, "SC2Pulse returned an incomplete profile. Please try again shortly.");
    const identity = playerIdentity({ pulseCharacterId: id, toonHandle, displayName, region: ch.region });
    await this.db.pulseCharacterLinks.updateOne({ pulseCharacterId: id }, { $set: stampVersion({ pulseCharacterId: id, accountId: String(member.account.id), proId: member.proId ? String(member.proId) : null, proNickname: member.proNickname || null, toonHandle, fetchedAt: new Date() }, COLLECTIONS.PULSE_CHARACTER_LINKS) }, { upsert: true });
    await this.directory.record(identity);
    return { player: identity };
  }

  /** Read cached stable Pulse equivalence only; a name is never a join key. @param {any[]} identities @param {any} [session] */
  async expandedKeys(identities, session) {
    const normalized = identities.map((identity) => playerIdentity(identity || {}));
    const toons = [...new Set(normalized.map((p) => p?.toonHandle).filter(Boolean))];
    const accounts = toons.length ? await this.db.pulseAccounts.find({ toonHandle: { $in: toons } }, { session, projection: { toonHandle: 1, pulseCharacterId: 1 } }).toArray() : [];
    /** @type {Map<string, Set<string>>} */
    const accountCids = new Map();
    for (const row of accounts) {
      const identity = playerIdentity(row);
      if (!identity?.toonHandle || !identity.pulseCharacterId) continue;
      const ids = accountCids.get(identity.toonHandle) || new Set();
      ids.add(identity.pulseCharacterId);
      accountCids.set(identity.toonHandle, ids);
    }
    const cids = [...new Set([...normalized.map((p) => p?.pulseCharacterId).filter(Boolean), ...[...accountCids.values()].flatMap((ids) => [...ids])])];
    const cached = await this.db.pulseCharacterLinks.find({ $or: [{ pulseCharacterId: { $in: cids } }, { toonHandle: { $in: toons } }] }, { session, projection: { pulseCharacterId: 1, toonHandle: 1, proId: 1, accountId: 1 } }).toArray();
    /** @type {Map<string, any[]>} */
    const byCid = new Map();
    /** @type {Map<string, any[]>} */
    const byToon = new Map();
    for (const row of cached) {
      const identity = playerIdentity(row);
      if (!identity?.pulseCharacterId) continue;
      const entry = { ...row, ...identity };
      const cidEntries = byCid.get(identity.pulseCharacterId) || [];
      cidEntries.push(entry);
      byCid.set(identity.pulseCharacterId, cidEntries);
      if (identity.toonHandle) {
        const toonEntries = byToon.get(identity.toonHandle) || [];
        toonEntries.push(entry);
        byToon.set(identity.toonHandle, toonEntries);
      }
    }
    return normalized.map((identity, index) => {
      if (!identity) return [];
      const toon = identity.toonHandle;
      const routeToon = playerIdentity({ pulseId: identities[index]?.pulseId })?.toonHandle;
      if (toon && routeToon && toon !== routeToon) return [];
      const knownCids = new Set(toon ? accountCids.get(toon) || [] : []);
      if (identity.pulseCharacterId) knownCids.add(identity.pulseCharacterId);
      for (const row of (toon ? byToon.get(toon) : null) || []) knownCids.add(row.pulseCharacterId);
      // Both caches must agree with a supplied exact toon/CID pair.
      // Never turn contradictory evidence into the union of two players.
      if (knownCids.size > 1) return [];
      const cid = [...knownCids][0];
      const rows = cid ? byCid.get(cid) || [] : [];
      if (toon && rows.some((row) => row.toonHandle && row.toonHandle !== toon)) return [];
      const keys = new Set(exactKeys(identity));
      if (cid) keys.add(`pulse:${cid}`);
      for (const row of rows) {
        if (row.toonHandle) keys.add(`toon:${row.toonHandle}`);
        if (row.proId) keys.add(`pro:${row.proId}`);
        if (row.accountId) keys.add(`acct:${row.accountId}`);
      }
      return [...keys];
    });
  }

  /** @param {any[]} identities @returns {Promise<Array<any|null>>} */
  async resolveMany(identities) {
    if (!identities.length) return [];
    const keySets = await this.expandedKeys(identities);
    const allKeys = [...new Set(keySets.flat())];
    const rows = await this.links.find({ active: true, $or: [{ sourceKeys: { $in: allKeys } }, { targetKeys: { $in: allKeys } }] }, { projection: { sourceKeys: 1, targetKeys: 1, target: 1, groupKey: 1, revision: 1 } }).toArray();
    // Targets may have been approved before their Pulse account was
    // known. Recompute equivalence from current local caches without
    // rewriting the approved edge or retaining stale account/pro keys.
    const currentTargetKeys = rows.length ? await this.expandedKeys(rows.map((row) => row.target)) : [];
    /** @type {Map<string, {row:any, conflict:boolean}>} */
    const sourceMatches = new Map();
    /** @type {Map<string, {row:any, conflict:boolean}>} */
    const targetMatches = new Map();
    /** @param {Map<string, {row:any, conflict:boolean}>} index @param {string[]} keys @param {any} row */
    const indexRow = (index, keys, row) => {
      for (const key of keys) {
        const hit = index.get(key);
        if (!hit) index.set(key, { row, conflict: false });
        else if (hit.row.groupKey !== row.groupKey) hit.conflict = true;
      }
    };
    rows.forEach((row, index) => {
      const targetKeys = currentTargetKeys[index];
      if (!targetKeys.length) {
        for (const key of row.sourceKeys) sourceMatches.set(key, { row, conflict: true });
        return;
      }
      const groupKey = targetKeys.find((key) => key.startsWith("pro:"))
        || targetKeys.find((key) => key.startsWith("acct:")) || row.groupKey;
      const current = { ...row, targetKeys, groupKey };
      indexRow(sourceMatches, row.sourceKeys, current);
      indexRow(targetMatches, targetKeys, current);
    });
    return keySets.map((keys) => {
      const direct = keys.flatMap((key) => { const hit = sourceMatches.get(key); return hit ? [hit] : []; });
      const hits = direct.length ? direct : keys.flatMap((key) => { const hit = targetMatches.get(key); return hit ? [hit] : []; });
      if (!hits.length || hits.some((hit) => hit.conflict) || new Set(hits.map((hit) => hit.row.groupKey)).size > 1) return null;
      const row = hits[0].row;
      return { groupKey: row.groupKey, displayName: row.target.displayName, target: row.target, revision: row.revision };
    });
  }

  /** @param {string} userId @param {string} pulseId */
  async source(userId, pulseId) {
    const row = await this.db.opponents.findOne({ userId, pulseId }, { projection: { pulseId: 1, pulseCharacterId: 1, toonHandle: 1, displayNameSample: 1, race: 1, region: 1 } });
    if (!row) throw identityError(404, "Opponent not found in your player list.");
    const source = playerIdentity(row);
    if (!source) throw identityError(400, "This opponent needs a Battle.net or SC2Pulse identity before it can be linked.");
    // The route identity remains the exact saved opponent, not the directory's canonical URL.
    source.pulseId = pulseId;
    const wasIdentified = isBarcodeLikeName(row.displayNameSample) ? false : Boolean(await this.links.findOne({ sourceKeys: { $in: exactKeys(source) } }, { projection: { _id: 1 } }));
    return { source, eligible: isBarcodeLikeName(row.displayNameSample) || wasIdentified };
  }

  /** @param {string} userId @param {any} source */
  evidenceFilter(userId, source) {
    return { userId, ...opponentGamesFilter(source), isResumedFromReplay: { $ne: true } };
  }

  /** @param {string} userId @param {string} pulseId @param {boolean} isAdmin */
  async context(userId, pulseId, isAdmin) {
    const { source, eligible } = await this.source(userId, pulseId);
    const [confirmed, own, replayCount, link] = await Promise.all([
      this.resolveMany([source]),
      this.submissions.findOne({ userId, sourceKey: source.key, direct: false }, { sort: { updatedAt: -1 } }),
      this.db.games.countDocuments(this.evidenceFilter(userId, source)),
      this.links.findOne({ sourceKeys: { $in: exactKeys(source) } }),
    ]);
    return { isAdmin, eligible, source, confirmed: confirmed[0] ? { ...confirmed[0], revision: link?.revision || 0 } : null, revision: link?.revision || 0, submission: submissionDto(own), replayCount };
  }

  /** @param {any} source @param {any} rawKey */
  async target(source, rawKey) {
    const target = await this.directory.get(rawKey);
    if (!target) throw identityError(400, "Choose an existing player from the search results.");
    if (!(await this.expandedKeys([target]))[0].length) throw identityError(409, "This player's saved identities conflict. Verify their current SC2Pulse profile before linking it.");
    if (exactKeys(target).some((key) => exactKeys(source).includes(key))) throw identityError(400, "Choose a different player profile.");
    return target;
  }

  /** @param {string} userId @param {any} source */
  async evidenceSnapshot(userId, source) {
    const filter = this.evidenceFilter(userId, source);
    const latest = await this.db.games.findOne(filter, { sort: { _id: -1 }, projection: { _id: 1 } });
    if (!latest) throw identityError(400, "At least one replay against this opponent is required.");
    return { evidenceMaxId: latest._id, evidenceCount: await this.db.games.countDocuments({ ...filter, _id: { $lte: latest._id } }) };
  }

  /** @param {string} userId @param {string} pulseId @param {any} body */
  async submit(userId, pulseId, body) {
    const { source, eligible } = await this.source(userId, pulseId);
    if (!eligible) throw identityError(400, "Identity suggestions are available for barcode opponents.");
    const reason = explanation(body?.reason);
    const target = await this.target(source, body?.targetKey);
    const snapshot = await this.evidenceSnapshot(userId, source);
    const link = await this.links.findOne({ sourceKeys: { $in: exactKeys(source) } });
    const old = await this.submissions.findOne({ userId, sourceKey: source.key, direct: { $ne: true } });
    if (old && revision(body?.submissionRevision) !== old.revision) throw identityError(409, "This suggestion changed. Refresh before editing it.");
    const now = new Date();
    const values = stampVersion({ source, sourceKey: source.key, userId, target, reason, status: "pending", updatedAt: now, reviewNote: null, baseRevision: link?.revision || 0, ...snapshot }, COLLECTIONS.PLAYER_IDENTITY_SUBMISSIONS);
    try {
      if (old) {
        const result = await this.submissions.updateOne({ id: old.id, revision: old.revision }, { $set: values, $inc: { revision: 1 } });
        if (!result.matchedCount) throw identityError(409, "This suggestion was reviewed while you edited it. Refresh and try again.");
      } else await this.submissions.insertOne({ ...values, id: randomUUID(), createdAt: now, revision: 1, direct: false });
    } catch (err) {
      if (/** @type {any} */ (err).code === 11000) throw identityError(409, "A suggestion already exists. Refresh to edit it.");
      throw err;
    }
    return this.context(userId, pulseId, false);
  }

  /** Serialize graph edits within a transaction so concurrent admins cannot create cycles or lose a review.
   * @param {(session:import('mongodb').ClientSession)=>Promise<any>} operation */
  async edit(operation) {
    const session = this.db.client.startSession();
    try {
      return await session.withTransaction(async () => {
        await this.links.updateOne({ kind: "graph-revision" }, { $inc: { revision: 1 }, $setOnInsert: { kind: "graph-revision" } }, { upsert: true, session });
        return operation(session);
      }, { maxCommitTimeMS: 5000 });
    } finally { await session.endSession(); }
  }

  /** @param {any} source @param {any} target @param {number} expected @param {string} adminId @param {any} session */
  async writeLink(source, target, expected, adminId, session) {
    const sourceKeys = exactKeys(source);
    if (!(await this.expandedKeys([source], session))[0].length) throw identityError(409, "The barcode's saved toon and SC2Pulse identities conflict. Refresh its Pulse information before confirming a match.");
    const old = await this.links.findOne({ sourceKeys: { $in: sourceKeys } }, { session });
    if ((old?.revision || 0) !== expected) throw identityError(409, "This barcode identity changed. Refresh before confirming it.");
    // Flatten approved targets. No recursive links survive in storage.
    if (target) {
      const targetLink = await this.links.findOne({ active: true, sourceKeys: { $in: exactKeys(target) } }, { session });
      if (targetLink) target = targetLink.target;
      const targetKeys = (await this.expandedKeys([target], session))[0];
      if (!targetKeys.length || targetKeys.some((key) => sourceKeys.includes(key))) throw identityError(400, "This link would connect the player to themselves.");
      const dependents = await this.links.countDocuments({ active: true, targetKeys: { $in: sourceKeys } }, { session });
      if (dependents) throw identityError(409, "Other barcodes link to this profile. Update those links first to keep their identities consistent.");
      const groupKey = targetKeys.find((key) => key.startsWith("pro:")) || targetKeys.find((key) => key.startsWith("acct:")) || `identity:${target.key}`;
      const values = stampVersion({ source, sourceKeys: [...new Set([...(old?.sourceKeys || []), ...sourceKeys])], target, targetKeys, groupKey, active: true, updatedBy: adminId, updatedAt: new Date(), revision: expected + 1 }, COLLECTIONS.PLAYER_IDENTITIES);
      if (old) await this.links.updateOne({ _id: old._id }, { $set: values }, { session });
      else await this.links.insertOne({ ...values, kind: "link" }, { session });
    } else {
      if (!old?.active) throw identityError(409, "There is no confirmed identity to remove.");
      await this.links.updateOne({ _id: old._id }, { $set: { active: false, updatedBy: adminId, updatedAt: new Date() }, $inc: { revision: 1 } }, { session });
    }
  }

  /** @param {string} userId @param {string} pulseId @param {any} body @param {boolean} [remove] */
  async confirm(userId, pulseId, body, remove = false) {
    const { source, eligible } = await this.source(userId, pulseId);
    if (!eligible) throw identityError(400, "Only a barcode opponent can be identified here.");
    const reason = explanation(body?.reason);
    const expected = revision(body?.revision);
    const target = remove ? null : await this.target(source, body?.targetKey);
    const snapshot = await this.evidenceSnapshot(userId, source);
    await this.edit(async (session) => {
      await this.writeLink(source, target, expected, userId, session);
      await this.submissions.insertOne(stampVersion({ id: randomUUID(), userId, source, sourceKey: source.key, target, reason, reviewNote: reason, status: remove ? "removed" : "approved", direct: true, reviewedBy: userId, createdAt: new Date(), updatedAt: new Date(), revision: 1, ...snapshot }, COLLECTIONS.PLAYER_IDENTITY_SUBMISSIONS), { session });
    });
    return this.context(userId, pulseId, true);
  }

  /** @param {any} opts */
  async list(opts = {}) {
    const status = ["pending", "approved", "rejected", "removed"].includes(opts.status) ? opts.status : "pending";
    let after = null;
    if (opts.cursor) {
      try {
        if (typeof opts.cursor !== "string" || opts.cursor.length > 200) throw new Error();
        const decoded = JSON.parse(Buffer.from(opts.cursor, "base64url").toString());
        if (typeof decoded.id !== "string" || decoded.id.length > 50 || typeof decoded.date !== "string" || !Number.isFinite(Date.parse(decoded.date))) throw new Error();
        after = { id: decoded.id, date: new Date(decoded.date) };
      } catch { throw identityError(400, "Invalid page. Refresh the submission list."); }
    }
    const rows = await this.submissions.find({ status, ...(after ? { $or: [{ createdAt: { $gt: after.date } }, { createdAt: after.date, id: { $gt: after.id } }] } : {}) }).sort({ createdAt: 1, id: 1 }).limit(31).toArray();
    const last = rows[29];
    return { items: rows.slice(0, 30).map((row) => submissionDto(row, true)), nextCursor: rows.length > 30 ? Buffer.from(JSON.stringify({ date: last.createdAt.toISOString(), id: last.id })).toString("base64url") : null };
  }

  /** @param {string} id @param {any} cursor */
  async detail(id, cursor) {
    const row = await this.submissions.findOne({ id });
    if (!row) throw identityError(404, "Suggestion not found.");
    if (cursor && (typeof cursor !== "string" || !/^[a-f\d]{24}$/i.test(cursor))) throw identityError(400, "Invalid evidence page. Refresh this review.");
    const games = await this.db.games.find({ ...this.evidenceFilter(row.userId, row.source), _id: { $lte: row.evidenceMaxId, ...(cursor ? { $lt: new ObjectId(cursor) } : {}) } }, { projection: { gameId: 1, date: 1, map: 1, result: 1, durationSec: 1, "opponent.displayName": 1, "replayFile.storedAt": 1 } }).sort({ _id: -1 }).limit(31).toArray();
    return { submission: submissionDto(row, true), evidence: games.slice(0, 30).map((g) => ({ gameId: g.gameId, date: g.date, map: g.map, result: g.result, durationSec: g.durationSec, opponentName: g.opponent?.displayName || row.source.displayName, hasReplay: Boolean(g.replayFile?.storedAt) })), nextCursor: games.length > 30 ? games[29]._id.toHexString() : null };
  }

  /** @param {string} id @param {string} adminId @param {any} body */
  async review(id, adminId, body) {
    if (!["approved", "rejected"].includes(body?.decision)) throw identityError(400, "Choose approve or reject.");
    const expected = revision(body?.revision);
    const reviewNote = explanation(body?.reviewNote, 1);
    const row = await this.submissions.findOne({ id });
    if (!row) throw identityError(404, "Suggestion not found.");
    const target = body.targetKey ? await this.target(row.source, body.targetKey) : row.target;
    await this.edit(async (session) => {
      const current = await this.submissions.findOne({ id, status: "pending", revision: expected }, { session });
      if (!current) throw identityError(409, "This suggestion has changed or already been reviewed. Refresh the queue.");
      if (body.decision === "approved") await this.writeLink(current.source, target, current.baseRevision, adminId, session);
      await this.submissions.updateOne({ id, revision: expected }, { $set: { status: body.decision, target, reviewNote, reviewedBy: adminId, updatedAt: new Date() }, $inc: { revision: 1 } }, { session });
    });
    return { submission: submissionDto(await this.submissions.findOne({ id }), true) };
  }
}

module.exports = { PlayerIdentitiesService };
