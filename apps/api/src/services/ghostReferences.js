"use strict";

const { randomUUID } = require("crypto");
const { MAX_REFERENCES, MATCHUPS, digest, failure, text, sideOf, normalizeTarget, ownedReplayTarget } = require("./ghostTargets");
const ROOT = "preferences.ghostBuilds";
const HISTORY = `${ROOT}.referenceHistory`;

class GhostReferencesService {
  /** @param {{db:any, gameDetails?:any}} deps */
  constructor(deps) { this.db = deps.db; this.gameDetails = deps.gameDetails || null; }

  /** @param {string} owner */
  async get(owner) {
    const row = await this.db.users.findOne({ userId: owner }, { projection: { _id: 0, [ROOT]: 1 } });
    const raw = row?.preferences?.ghostBuilds || {};
    /** @type {Record<string,any>} */
    const slots = {};
    /** @type {Record<string,any>} */
    const references = {};
    /** @type {Record<string,any[]>} */
    const history = {};
    for (const [matchup, value] of Object.entries(raw.slots || {})) {
      if (MATCHUPS.has(matchup)) {
        try { slots[matchup] = normalizeTarget(value); } catch {}
      }
    }
    for (const value of Object.values(raw.references || {}).slice(0, MAX_REFERENCES)) {
      try {
        const entry = cleanEntry(value);
        references[referenceKey(entry.side, entry.matchup, entry.buildKey)] = entry;
      } catch {}
    }
    for (const entries of Object.values(raw.referenceHistory || {}).slice(-MAX_REFERENCES)) {
      if (!Array.isArray(entries)) continue;
      for (const value of entries.slice(0, 3)) {
        try {
          const entry = cleanEntry(value);
          const key = referenceKey(entry.side, entry.matchup, entry.buildKey);
          if ((history[key] ||= []).length < 3) history[key].push(entry);
        } catch {}
      }
    }
    return { v: 1, slots, references, history };
  }

  /** @param {string} owner @param {any} body */
  async saveSlot(owner, body) {
    if (!MATCHUPS.has(body.matchup)) throw failure("invalid_ghost_matchup");
    if (body.target === null) {
      await this.db.users.updateOne({ userId: owner }, { $unset: { [`${ROOT}.slots.${body.matchup}`]: "" } });
      return this.get(owner);
    }
    const target = normalizeTarget(body.target);
    const side = sideOf(body.side || target.perspective);
    target.perspective = side;
    await this._save(owner, body.matchup, target, body.buildKey ? text(body.buildKey, 160, true) : null, side, target.sourceGameId);
    return this.get(owner);
  }

  /** @param {string} owner @param {any} body */
  async reference(owner, body) {
    const gameId = text(body.gameId, 200, true);
    const side = sideOf(body.side);
    if (body.clear === true) return this._clear(owner, gameId, side, body.buildKey);
    const source = await ownedReplayTarget(this.db, this.gameDetails, owner, gameId, side);
    const buildKey = body.buildKey === undefined ? source.buildKey : text(body.buildKey, 160, true);
    await this._save(owner, source.matchup, source.target, buildKey, side, gameId);
    return this.get(owner);
  }

  /** @param {string} owner @param {string} matchup @param {any} target @param {string|null} buildKey @param {string} side @param {string} gameId */
  async _save(owner, matchup, target, buildKey, side, gameId) {
    /** @type {Record<string,any>} */
    const changes = { [`${ROOT}.v`]: 1, [`${ROOT}.slots.${matchup}`]: target };
    /** @type {Record<string,any>} */
    const filter = { userId: owner };
    if (buildKey !== null) {
      const key = digest(referenceKey(side, matchup, buildKey));
      const path = `${ROOT}.references.${key}`;
      changes[path] = { $literal: { buildKey, matchup, side, gameId, target, revision: randomUUID(), savedAt: new Date().toISOString() } };
      changes[HISTORY] = historyExpression(key);
      filter.$or = [{ [path]: { $exists: true } }, { $expr: { $lt: [{ $size: { $objectToArray: { $ifNull: [`$${ROOT}.references`, {}] } } }, MAX_REFERENCES] } }];
    }
    changes[`${ROOT}.slots.${matchup}`] = { $literal: target };
    const result = await this.db.users.updateOne(filter, [{ $set: changes }]);
    if (!result.matchedCount) throw failure("ghost_reference_limit", 409);
  }

  /** @param {string} owner @param {string} gameId @param {string} side @param {unknown} build */
  async _clear(owner, gameId, side, build) {
    const buildKey = build === undefined ? null : text(build, 160, true);
    const current = await this.get(owner);
    for (const [key, entry] of Object.entries(current.references)) {
      if (entry.gameId !== gameId || entry.side !== side || (buildKey !== null && entry.buildKey !== buildKey)) continue;
      const path = `${ROOT}.references.${digest(key)}`;
      const slot = `${ROOT}.slots.${entry.matchup}`;
      const filter = { userId: owner, [`${path}.gameId`]: gameId, [`${path}.side`]: side, ...revisionFilter(path, entry.revision) };
      const pushHistory = { $set: { [HISTORY]: historyExpression(digest(key)) } };
      const result = await this.db.users.updateOne({ ...filter, [`${slot}.sourceGameId`]: entry.target.sourceGameId, [`${slot}.perspective`]: side }, [pushHistory, { $unset: [path, slot] }]);
      if (!result.matchedCount) await this.db.users.updateOne(filter, [pushHistory, { $unset: path }]);
    }
    return this.get(owner);
  }

  /** @param {string} owner @param {any} body */
  async restore(owner, body) {
    const reference = text(body.referenceKey, 200, true);
    const revision = text(body.revision, 80, true);
    const current = await this.get(owner);
    const entry = current.history[reference]?.find((candidate) => candidate.revision === revision);
    if (!entry) throw failure("ghost_reference_history_not_found", 404);
    const key = digest(reference);
    const path = `${ROOT}.references.${key}`;
    /** @type {Record<string,any>} */
    const filter = { userId: owner, ...revisionFilter(path, body.expectedCurrentRevision),
      $or: [{ [path]: { $exists: true } }, { $expr: { $lt: [{ $size: { $objectToArray: { $ifNull: [`$${ROOT}.references`, {}] } } }, MAX_REFERENCES] } }],
    };
    const historyRevision = revision === "legacy" ? { $exists: false } : revision;
    filter[`${HISTORY}.${key}`] = { $elemMatch: { revision: historyRevision } };
    const restored = { ...entry, revision: randomUUID(), savedAt: new Date().toISOString() };
    const result = await this.db.users.updateOne(filter, [{ $set: {
      [`${ROOT}.v`]: 1, [`${ROOT}.slots.${entry.matchup}`]: { $literal: entry.target },
      [path]: { $literal: restored }, [HISTORY]: historyExpression(key, revision),
    } }]);
    if (!result.matchedCount) throw failure("ghost_reference_changed", 409);
    return this.get(owner);
  }

  /** @param {string} owner @param {any} query */
  async comparison(owner, query) {
    const gameId = text(query.gameId, 200, true);
    const side = sideOf(query.side);
    const played = await ownedReplayTarget(this.db, this.gameDetails, owner, gameId, side);
    const buildKey = query.buildKey === undefined ? played.buildKey : text(query.buildKey, 160, true);
    const document = await this.get(owner);
    const reference = document.references[referenceKey(side, played.matchup, buildKey)];
    const base = { matchup: played.matchup, buildKey, rows: [] };
    if (!["Victory", "Defeat", "Tie", "Win", "Loss"].includes(played.game.result)) return { ...base, status: "replay_pending" };
    if (!reference) return { ...base, status: "no_reference" };
    let source = reference.gameId === gameId || reference.target.sourceGameId === played.target.sourceGameId;
    if (!source && reference.target.sourceGameId.startsWith("example:") && this.db.ghostExamples) source = !!(await this.db.ghostExamples.findOne({ _id: reference.target.sourceGameId.slice(8), ownerUserId: owner, sourceGameId: gameId, side }, { projection: { _id: 1 } }));
    if (source) return { ...base, status: "source_replay" };
    return { ...base, status: "ready", reference: { name: reference.target.name, sourceGameId: reference.target.sourceGameId, revision: reference.revision }, rows: compareSteps(reference.target.steps, played.target.steps) };
  }
}

/** @param {string} side @param {string} matchup @param {string} buildKey */
function referenceKey(side, matchup, buildKey) { return `${side}:${matchup}:${buildKey}`; }

/** @param {any} value */
function cleanEntry(value) {
  if (!value || !MATCHUPS.has(value.matchup)) throw failure("invalid_ghost_reference");
  return { buildKey: text(value.buildKey, 160, true), matchup: value.matchup, side: sideOf(value.side),
    gameId: text(value.gameId, 200, true), target: normalizeTarget(value.target),
    revision: value.revision ? text(value.revision, 80, true) : "legacy", savedAt: typeof value.savedAt === "string" && value.savedAt.length <= 40 ? value.savedAt : null };
}

/** @param {string} path @param {unknown} revision @returns {Record<string,any>} */
function revisionFilter(path, revision) {
  if (revision === null) return { [path]: { $exists: false } };
  const wanted = text(revision, 80, true);
  return wanted === "legacy" ? { [path]: { $exists: true }, [`${path}.revision`]: { $exists: false } } : { [`${path}.revision`]: wanted };
}

/** @param {string} key @param {string|null} [exclude] */
function historyExpression(key, exclude = null) {
  const current = `$${ROOT}.references.${key}`;
  const prior = { $filter: { input: { $ifNull: [`$${HISTORY}.${key}`, []] }, as: "prior", cond: { $ne: [{ $ifNull: ["$$prior.revision", "legacy"] }, { $literal: exclude }] } } };
  const entries = { $slice: [{ $concatArrays: [{ $cond: [{ $eq: [{ $type: current }, "object"] }, [current], []] }, prior] }, 3] };
  return { $arrayToObject: { $slice: [{ $concatArrays: [
    { $filter: { input: { $objectToArray: { $ifNull: [`$${HISTORY}`, {}] } }, as: "family", cond: { $ne: ["$$family.k", { $literal: key }] } } },
    [{ k: key, v: entries }],
  ] }, -MAX_REFERENCES] } };
}

/** @param {any[]} target @param {any[]} played */
function compareSteps(target, played) {
  /** @type {Map<string,any[]>} */
  const observed = new Map();
  for (const step of played) {
    const key = step.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!observed.has(key)) observed.set(key, []);
    observed.get(key)?.push(step);
  }
  /** @type {Map<string,number>} */
  const occurrences = new Map();
  return target.map((step) => {
    const key = step.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const occurrence = (occurrences.get(key) || 0) + 1;
    occurrences.set(key, occurrence);
    const actual = observed.get(key)?.[occurrence - 1];
    const compatible = actual && (step.kind === "other" || step.kind === actual.kind) && (step.timing === "recorded" || step.timing === actual.timing);
    return { name: step.name, occurrence, targetSec: step.t, actualSec: actual?.t ?? null,
      deltaSec: compatible ? actual.t - step.t : null, kind: step.kind, timing: step.timing,
      status: actual ? compatible ? "observed" : "event_mismatch" : "missing" };
  });
}

module.exports = { GhostReferencesService };
