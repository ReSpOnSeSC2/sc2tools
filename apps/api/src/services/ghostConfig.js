"use strict";

// Keep the pure model in parity with web/lib/ghostBuild.ts. The account
// transport additionally caps expanded UTF-8 JSON; legacy compact URLs keep
// their existing, separate encoded-size limit.
const MATCHUPS = Object.freeze(["PvP", "PvT", "PvZ", "TvP", "TvT", "TvZ", "ZvP", "ZvT", "ZvZ"]);
const MAX_GHOST_JSON_BYTES = 64 * 1024;
const ROOT = "preferences.ghost";
const REVISION = "preferences.ghostRevision";
/** @param {unknown} value */
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
/** @param {unknown} value @param {number} cap */
const name = (value, cap) => typeof value === "string"
  ? value.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029]/g, "").replace(/\s+/g, " ").trim().slice(0, cap) : "";

/** @param {unknown} input */
function normalizeGhostTarget(input) {
  if (!record(input)) return null;
  const raw = /** @type {any} */ (input);
  const title = name(raw.name, 80);
  if (raw.v !== 1 || !title || !Array.isArray(raw.steps) || !raw.steps.length || raw.steps.length > 80) return null;
  const steps = [];
  for (const entry of raw.steps) {
    if (!record(entry)) return null;
    const label = name(entry.name, 48);
    if (!label || typeof entry.t !== "number" || !Number.isFinite(entry.t)) return null;
    const t = Math.round(entry.t);
    if (t < 0 || t > 14400) return null;
    let supply = null;
    if (entry.supply !== null && entry.supply !== undefined) {
      if (typeof entry.supply !== "number" || !Number.isFinite(entry.supply)) return null;
      supply = Math.min(200, Math.max(0, Math.floor(entry.supply)));
    }
    steps.push({ supply, t, name: label });
  }
  steps.sort((a, b) => a.t - b.t);
  const source = raw.sourceGameId;
  const sourceGameId = typeof source === "string" && source.length > 0 && source.length <= 64
    && !/[\u0000-\u001f\u007f]/.test(source) ? source : undefined;
  return { v: 1, name: title, steps, ...(sourceGameId ? { sourceGameId } : {}) };
}

/** @param {unknown} input */
function normalizeGhostBuildConfig(input) {
  if (!record(input)) return null;
  const raw = /** @type {any} */ (input);
  if (raw.v !== 2 || !record(raw.slots) || Object.keys(raw.slots).some(key => !MATCHUPS.includes(key))) return null;
  /** @type {Record<string, any>} */ const slots = {};
  for (const key of MATCHUPS) {
    if (!Object.prototype.hasOwnProperty.call(raw.slots, key)) continue;
    const target = normalizeGhostTarget(raw.slots[key]);
    if (!target) return null;
    slots[key] = target;
  }
  return { v: 2, slots };
}

/** @param {unknown} input */
function normalizeSyncedGhostBuildConfig(input) {
  try {
    const json = JSON.stringify(input);
    if (!json || Buffer.byteLength(json, "utf8") > MAX_GHOST_JSON_BYTES) return null;
    return normalizeGhostBuildConfig(input);
  } catch { return null; }
}

/** @param {string} code @param {number} [status] */
function failure(code, status = 400) { return Object.assign(new Error(code), { code, status }); }

class GhostConfigService {
  /** @param {{db:any, overlayTokens?:any, io?:any}} deps */
  constructor({ db, overlayTokens, io }) {
    this.db = db; this.overlayTokens = overlayTokens; this.io = io;
    this.notifications = new Map();
  }

  /** Absent preferences stay absent: old fragment URLs remain usable until
   * the owner explicitly saves or migrates an account configuration.
   * @param {string} owner */
  async get(owner) {
    const row = await this.db.users.findOne({ userId: owner }, { projection: { _id: 0, [ROOT]: 1, [REVISION]: 1 } });
    const config = normalizeSyncedGhostBuildConfig(row?.preferences?.ghost);
    if (!config) return null;
    const raw = row?.preferences?.ghostRevision;
    const revision = Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
    return { ...config, revision };
  }

  /** Full replacement is explicit. Practice actions use patch() so two
   * devices editing different matchup slots cannot erase each other.
   * @param {string} owner @param {unknown} input */
  async replace(owner, input) {
    const clean = normalizeSyncedGhostBuildConfig(input);
    // Reserve the largest legal revision's transport overhead at admission.
    if (!clean || !normalizeSyncedGhostBuildConfig({ ...clean, revision: Number.MAX_SAFE_INTEGER })) throw failure("invalid_ghost_config");
    const result = await this.db.users.updateOne({ userId: owner }, { $set: { [ROOT]: clean }, $inc: { [REVISION]: 1 } });
    if (!result.matchedCount) throw failure("user_not_found", 404);
    await this.changed(owner);
    return this.get(owner);
  }

  /** Bounded optimistic merge: no revision documents, leases or background
   * writes. A sibling counter advances in this same write; delayed socket
   * reads and HTTP responses cannot roll a newer client snapshot backward.
   * Migration fills empty slots only; existing account choices win.
   * @param {string} owner @param {any} body */
  async patch(owner, body) {
    if (!record(body)) throw failure("invalid_ghost_config");
    const migration = body.onlyEmpty === true && Object.keys(body).every(key => key === "merge" || key === "onlyEmpty");
    const incoming = migration ? normalizeSyncedGhostBuildConfig(body.merge) : null;
    const slot = !migration && Object.keys(body).every(key => key === "matchup" || key === "target" || key === "expectedTarget") && MATCHUPS.includes(body.matchup);
    const target = slot && body.target !== null ? normalizeGhostTarget(body.target) : null;
    const expects = Object.prototype.hasOwnProperty.call(body, "expectedTarget");
    const expected = expects && body.expectedTarget !== null ? normalizeGhostTarget(body.expectedTarget) : null;
    if (expects && body.expectedTarget !== null && !expected) throw failure("invalid_ghost_config");
    if (migration ? !incoming : !slot || (body.target !== null && !target)) throw failure("invalid_ghost_config");
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await this.db.users.findOne({ userId: owner }, { projection: { _id: 0, [ROOT]: 1 } });
      if (!row) throw failure("user_not_found", 404);
      const raw = row.preferences?.ghost;
      const current = normalizeSyncedGhostBuildConfig(raw) || { v: 2, slots: {} };
      if (expects && JSON.stringify(current.slots[body.matchup] ?? null) !== JSON.stringify(expected)) throw failure("ghost_config_changed", 409);
      /** @type {Record<string, any>} */ const slots = { ...current.slots };
      if (incoming) {
        for (const [key, value] of Object.entries(incoming.slots)) if (!slots[key]) slots[key] = value;
      } else if (target) slots[body.matchup] = target;
      else delete slots[body.matchup];
      const next = normalizeSyncedGhostBuildConfig({ v: 2, slots });
      if (!next || !normalizeSyncedGhostBuildConfig({ ...next, revision: Number.MAX_SAFE_INTEGER })) throw failure("invalid_ghost_config");
      const result = await this.db.users.updateOne({ userId: owner,
        [ROOT]: raw === undefined ? { $exists: false } : { $eq: raw },
      }, { $set: { [ROOT]: next }, $inc: { [REVISION]: 1 } });
      if (result.matchedCount) { await this.changed(owner); return this.get(owner); }
    }
    throw failure("ghost_config_changed", 409);
  }

  /** Only the owner's active token rooms receive targets. The web advisory
   * carries no config. Coalescing held notifications prevents an older read
   * from painting over a later save; no polling or provider fan-out.
   * @param {string} owner */
  async changed(owner) {
    if (!this.io || !this.overlayTokens || (this.notifications.size >= 64 && !this.notifications.has(owner))) return;
    const marker = {};
    this.notifications.set(owner, marker);
    try {
      this.io.to(`user:${owner}`).emit("ghost:changed", true);
      const tokens = await this.overlayTokens.list(owner);
      const ghost = await this.get(owner);
      if (this.notifications.get(owner) !== marker || !ghost) return;
      for (const item of tokens) {
        if (!item.revokedAt && !item.rotationPending) this.io.to(`overlay:${item.token}`).emit("overlay:config", { ghost });
      }
    } catch { /* Preferences are committed; reconnect/read retries recover. */ }
    finally { if (this.notifications.get(owner) === marker) this.notifications.delete(owner); }
  }
}

module.exports = { MATCHUPS, MAX_GHOST_JSON_BYTES, normalizeGhostTarget, normalizeGhostBuildConfig, normalizeSyncedGhostBuildConfig, GhostConfigService };
