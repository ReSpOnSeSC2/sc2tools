"use strict";

const { randomToken } = require("../util/hash");
const { stampVersion } = require("../db/schemaVersioning");
const { COLLECTIONS } = require("../config/constants");
const { overlayProfileForRead } = require("../validation/overlayProfile");
const { rotationBusy } = require("./overlayTokenWrites");

const ROW_BATCH = 500;
const REQUEST_BATCHES = 8;
const ENGAGEMENT = ["multichatEngagementEvents", "multichatViewers", "multichatPredictions", "multichatClipMoments"];

/** Durable, forward-only rotation on existing token rows. All public writers
 * share tokens.withWrite; a hidden destination cannot acquire conflicting
 * engagement keys. Each updateMany moves at most ROW_BATCH existing _ids, so
 * retries simply select remaining old-token rows (including ambiguous writes).
 * No background jobs, provider calls, new collection or production migration.
 */
class OverlayTokenRotation {
  /** @param {import('../db/connect').DbContext} db @param {import('./overlayTokens').OverlayTokensService} tokens
   * @param {{onRotationStarted?:(token:string)=>void}} [opts] */
  constructor(db, tokens, opts = {}) {
    this.db = db; this.tokens = tokens; this.onRotationStarted = opts.onRotationStarted;
    /** @type {Set<string>} */ this.running = new Set();
    /** @type {((userId:string,from:string,to:string)=>void)|null} */ this.onCompleted = null;
  }

  /** @param {string} userId @param {string} token */
  async rotate(userId, token) {
    if (this.running.has(token) || this.running.size >= 8) throw rotationBusy();
    this.running.add(token);
    try {
      const old = await this.db.overlayTokens.findOne({ userId, token, _rotationPending: { $ne: true } });
      if (!old || old.revokedAt && !old._rotation) throw Object.assign(new Error("not_found"), { status: 404, code: "not_found" });
      this.tokens.writes.block(token);
      this.tokens.invalidate(token);
      // Atomic claim preserves the exact config current at admission closure.
      // A failed insert/response keeps this same reserved credential on retry.
      if (!old._rotation) {
        await this.db.overlayTokens.updateOne({ userId, token, revokedAt: null, _rotation: { $exists: false } }, {
          $set: { _rotation: { to: randomToken(24), startedAt: new Date(), state: "pending" } },
        });
      }
      this.tokens.invalidate(token);
      const source = await this.db.overlayTokens.findOne({ userId, token });
      if (!source?._rotation?.to) throw rotationBusy();
      const replacement = String(source._rotation.to);
      // Retire live credentials even when this request must return pending.
      // Socket failures cannot undo the durable fence; handshake, resync and
      // active-token fanout independently reject this source afterward.
      try { this.onRotationStarted?.(token); } catch { /* durable fence remains */ }
      if (!await this.tokens.writes.drain(token)) return { pending: true };
      const match = { token: replacement, userId, _rotationSource: token };
      if (source._rotation.state !== "complete") await this.db.overlayTokens.updateOne(match, { $setOnInsert: stampVersion({
        ...match, label: source.label || "Default", enabledWidgets: source.enabledWidgets,
        profile: overlayProfileForRead(source.profile), profileRevision: 0,
        createdAt: source._rotation.startedAt, lastSeenAt: null, revokedAt: null, _rotationPending: true,
      }, COLLECTIONS.OVERLAY_TOKENS) }, { upsert: true });

      if (source._rotation.state !== "complete") {
        const studio = await this.db.multichatStudio.findOne({ studioKey: token })
          || await this.db.multichatStudio.findOne({ token });
        if (studio) {
          const copy = /** @type {Record<string,any>} */ ({ ...studio }); delete copy._id;
          // Prefer canonical over arbitrary duplicate legacy documents; copying
          // never deletes the source and preserves server-owned b-roll anchors.
          await this.db.multichatStudio.updateOne({ studioKey: replacement }, {
            $setOnInsert: { ...copy, studioKey: replacement, token: replacement },
          }, { upsert: true });
        }
        let batches = 0;
        for (const key of ENGAGEMENT) {
          const collection = /** @type {import('mongodb').Collection} */ (/** @type {any} */ (this.db)[key]);
          for (;;) {
            const rows = await collection.find({ token }, { projection: { _id: 1 } }).limit(ROW_BATCH).toArray();
            if (!rows.length) break;
            if (batches++ >= REQUEST_BATCHES) return { pending: true };
            await collection.updateMany({ token, _id: { $in: rows.map(row => row._id) } }, { $set: { token: replacement } });
          }
        }
        // Old credential is durably dead before the destination becomes
        // usable. A failure here resumes activation without re-copying state.
        await this.db.overlayTokens.updateOne({ userId, token, "_rotation.to": replacement }, {
          $set: { revokedAt: new Date(), "_rotation.state": "complete" },
        });
      }
      await this.db.overlayTokens.updateOne({ ...match, revokedAt: null, _rotation: { $exists: false } }, { $set: { _rotationPending: false } });
      this.tokens.invalidate(token);
      this.tokens.invalidate(replacement);
      const terminal = (await replacementTargets(this.db.overlayTokens, userId, new Map([[token, replacement]]))).get(token);
      if (terminal?.token) this.onCompleted?.(userId, token, terminal.token);
      return terminal?.token ? { pending: false, token: terminal.token } : terminal?.pending ? { pending: true } : { pending: false, unavailable: true, revoked: terminal?.revoked === true };
    } finally {
      this.tokens.writes.unblock(token);
      this.running.delete(token);
    }
  }
}

/** Resolve only owned, ready terminal credentials. Batched breadth-first
 * reads avoid per-source query fanout; at most32 sources ×16 hops. A revoked
 * terminal, missing row, pending operation, cycle or overlong chain never
 * becomes an active credential by retrying a former source.
 * @param {import('mongodb').Collection} collection @param {string} userId
 * @param {Map<string,string>} starts @param {any[]} [known] */
async function replacementTargets(collection, userId, starts, known = []) {
  /** @type {Map<string, {token?:string,pending?:boolean,revoked?:boolean}>} */ const result = new Map();
  const nodes = new Map(known.map(row => [String(row.token), row]));
  const frontier = new Map([...starts].slice(0, 32));
  for (let hop = 0; hop < 16 && frontier.size; hop++) {
    const missing = [...new Set(frontier.values())].filter(token => !nodes.has(token));
    if (missing.length) {
      const rows = await collection.find({ userId, token: { $in: missing } }, { projection: { token: 1, revokedAt: 1, _rotationPending: 1, _rotation: 1 }, maxTimeMS: 1000 }).toArray();
      for (const token of missing) nodes.set(token, null);
      for (const row of rows) nodes.set(String(row.token), row);
    }
    for (const [source, token] of frontier) {
      const row = nodes.get(token);
      if (!row) { result.set(source, { revoked: true }); frontier.delete(source); }
      else if (row._rotationPending || row._rotation?.state === "pending") { result.set(source, { pending: true }); frontier.delete(source); }
      else if (row._rotation?.state === "complete" && typeof row._rotation.to === "string") frontier.set(source, row._rotation.to);
      else if (row.revokedAt) { result.set(source, { revoked: true }); frontier.delete(source); }
      else { result.set(source, { token }); frontier.delete(source); }
    }
  }
  for (const source of frontier.keys()) result.set(source, {});
  return result;
}

module.exports = { OverlayTokenRotation, ROW_BATCH, REQUEST_BATCHES, ENGAGEMENT, replacementTargets };
