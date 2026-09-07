"use strict";

const { stampVersion } = require("../db/schemaVersioning");
const { COLLECTIONS } = require("../config/constants");

const TOON = /^\d+-S2-\d+-\d+$/;
const CID = /^[1-9]\d{0,19}$/;

/** Stable public character metadata only; never copy tenant statistics or notes. @param {any} row */
function playerIdentity(row) {
  const toonHandle = TOON.test(row.toonHandle || "") ? row.toonHandle : TOON.test(row.pulseId || "") ? row.pulseId : null;
  const pulseCharacterId = CID.test(String(row.pulseCharacterId || "")) ? String(row.pulseCharacterId) : null;
  if (!toonHandle && !pulseCharacterId) return null;
  const displayName = String(row.revealedName || row.displayName || row.displayNameSample || "Unnamed player").slice(0, 80);
  return { key: toonHandle ? `toon:${toonHandle}` : `pulse:${pulseCharacterId}`, pulseId: toonHandle || pulseCharacterId, pulseCharacterId, toonHandle, displayName, race: row.race || null, region: row.region || null };
}

/** @param {any} row @returns {string[]} */
function exactKeys(row) {
  const identity = playerIdentity(row);
  return identity ? [identity.toonHandle && `toon:${identity.toonHandle}`, identity.pulseCharacterId && `pulse:${identity.pulseCharacterId}`].filter(Boolean) : [];
}

/** Indexed autocomplete over real saved characters, including characters without Pulse data. */
class PlayerIdentityDirectory {
  /** @param {import('../db/connect').DbContext} db */
  constructor(db) {
    this.db = db;
    this.col = db.playerIdentityDirectory;
    this.refreshedAt = 0;
    this.refreshPromise = null;
  }

  /** @param {any} row */
  async record(row) {
    const write = this.writeFor(row);
    if (write) await this.col.bulkWrite([write], { ordered: false });
  }

  /** @param {any} row @returns {import('mongodb').AnyBulkWriteOperation|null} */
  writeFor(row) {
    const identity = playerIdentity(row);
    if (!identity) return null;
    const names = [identity.displayName, row.displayNameSample, row.displayName, row.revealedName].filter((name) => typeof name === "string" && name.trim()).flatMap((name) => [name.trim().toLowerCase(), ...name.trim().toLowerCase().split(/\s+/)]);
    // A channel seed often knows only a toon. It must not erase a CID/race
    // previously learned from an actual replay or Pulse response.
    const set = stampVersion(Object.fromEntries(Object.entries({ ...identity, updatedAt: new Date() }).filter(([, value]) => value !== null)), COLLECTIONS.PLAYER_IDENTITY_DIRECTORY);
    return { updateOne: { filter: { key: identity.key }, update: { $set: set, $addToSet: { searchNames: { $each: [...new Set(names)] }, identityKeys: { $each: exactKeys(identity) } } }, upsert: true } };
  }

  /** Stream the initial backfill, then only changed source rows. No full player list in memory. */
  async ensureFresh() {
    if (Date.now() - this.refreshedAt < 60_000) return;
    if (!this.refreshPromise) this.refreshPromise = this.refresh().finally(() => { this.refreshPromise = null; });
    await this.refreshPromise;
  }

  async refresh() {
    const start = Date.now();
    if (!this.refreshedAt) {
      const checkpoint = await this.col.findOne({ key: "__directory_sync" });
      if (checkpoint?.completedAt instanceof Date) this.refreshedAt = checkpoint.completedAt.getTime();
    }
    const since = this.refreshedAt ? new Date(this.refreshedAt - 60_000) : null;
    const sources = [
      { col: this.db.opponents, time: "lastSeen" },
      { col: this.db.pulseAccounts, time: "updatedAt" },
    ];
    for (const { col, time } of sources) {
      if (!col) continue;
      const cursor = col.find(since ? { [time]: { $gte: since } } : {}, { projection: { pulseId: 1, pulseCharacterId: 1, toonHandle: 1, displayNameSample: 1, revealedName: 1, race: 1, region: 1 } }).sort({ [time]: 1 }).batchSize(500);
      /** @type {import('mongodb').AnyBulkWriteOperation[]} */
      let writes = [];
      for await (const row of cursor) {
        const write = this.writeFor(row);
        if (write) writes.push(write);
        // Ordered writes preserve the newest name when several users have
        // encountered the same character, with bounded memory/network trips.
        if (writes.length >= 500) { await this.col.bulkWrite(writes); writes = []; }
      }
      if (writes.length) await this.col.bulkWrite(writes);
    }
    if (this.db.playerChannels) {
      /** @type {import('mongodb').AnyBulkWriteOperation[]} */
      let channelWrites = [];
      for await (const row of this.db.playerChannels.find({ removed: { $ne: true }, ...(since ? { updatedAt: { $gte: since } } : {}) })) {
        const name = row.source === "self" ? row.approvedDisplayName : row.displayName;
        const keys = row.source === "self" ? row.approvedIdentityKeys || [] : row.identityKeys || [];
        if (!name) continue;
        for (const key of keys) {
          const write = key.startsWith("toon:") ? this.writeFor({ toonHandle: key.slice(5), displayName: name }) : key.startsWith("pulse:") ? this.writeFor({ pulseCharacterId: key.slice(6), displayName: name }) : null;
          if (write) channelWrites.push(write);
          if (channelWrites.length >= 500) { await this.col.bulkWrite(channelWrites); channelWrites = []; }
        }
      }
      if (channelWrites.length) await this.col.bulkWrite(channelWrites);
    }
    await this.col.updateOne({ key: "__directory_sync" }, { $set: { completedAt: new Date(start) } }, { upsert: true });
    this.refreshedAt = start;
  }

  /** @param {any} q @param {any} cursor */
  async search(q, cursor) {
    if (typeof q !== "string" || q.trim().length < 2 || q.length > 80) return { items: [], nextCursor: null };
    await this.ensureFresh();
    const term = q.trim().toLowerCase();
    const after = typeof cursor === "string" && cursor.length < 150 ? cursor : "";
    const query = TOON.test(q.trim()) || CID.test(q.trim())
      ? { identityKeys: TOON.test(q.trim()) ? `toon:${q.trim()}` : `pulse:${q.trim()}` }
      : { searchNames: { $elemMatch: { $gte: term, $lt: `${term}\uffff` } } };
    const rows = await this.col.find({ ...query, ...(after ? { key: { $gt: after } } : {}) }, { projection: { _id: 0, key: 1, pulseId: 1, pulseCharacterId: 1, toonHandle: 1, displayName: 1, race: 1, region: 1 }, maxTimeMS: 5000 }).sort({ key: 1 }).limit(21).toArray();
    return { items: rows.slice(0, 20).map((row) => ({ pulseCharacterId: null, toonHandle: null, race: null, region: null, ...row })), nextCursor: rows.length > 20 ? rows[19].key : null };
  }

  /** @param {any} key */
  async get(key) {
    if (typeof key !== "string" || key.length > 100) return null;
    await this.ensureFresh();
    return this.col.findOne({ key }, { projection: { _id: 0, key: 1, pulseId: 1, pulseCharacterId: 1, toonHandle: 1, displayName: 1, race: 1, region: 1 } });
  }
}

module.exports = { PlayerIdentityDirectory, playerIdentity, exactKeys };
