"use strict";

const { SessionResolutionGate } = require("./sessionResolutionGate");
const { OwnerRevisions } = require("../util/gameVisibility");
const { MAX_DATE_MS } = require("./sessions");
const { historyError, stale, invalid, integer, encode, parseSessionDescriptor, parsePageDescriptor, parseGamePageDescriptor } = require("./sessionHistoryDescriptor");
const { DAY, timezone, membershipFilters, naturalSpan, makeSpan, scopeHash } = require("./sessionHistoryWindow");
const { queryHistoryRows } = require("./sessionHistoryQuery");
const { completeCandidates, publicSummary, inOutput, shapeLoad, base, olderWindow } = require("./sessionHistoryViews");
const REQUEST_MS = 4000;

class SessionHistoryService {
  /** @param {Pick<import('../db/connect').DbContext,'games'|'users'>} db
   * @param {{sessionPolicy:import('./sessionPolicy').SessionPolicyService,now?:()=>number}} opts */
  constructor(db, opts) {
    this.db = db; this.policy = opts.sessionPolicy; this.now = opts.now ?? (() => Date.now());
    this.sequence = 0; this.gate = new SessionResolutionGate({ maxComputeWaiters: 0 });
    this.resetRevisions = new OwnerRevisions();
  }
  /** Synchronous guard captured BEFORE policy/profile/games resolution.
   * @param {string} owner */
  capturePublication(owner) {
    const lease = this.policy.lease(owner), reset = this.resetRevisions.get(owner);
    return () => { this.policy.assertCurrent(lease); if (!this.resetRevisions.current(owner, reset)) stale(); };
  }
  /** Retire held reads without changing natural membership or shared caches.
   * @param {string} owner */
  invalidateForReset(owner) { this.resetRevisions.invalidate(owner); }
  /** @template T @param {string} owner @param {()=>Promise<T>} work @returns {Promise<T>} */
  admit(owner, work) {
    this.sequence += 1;
    const task = /** @type {Promise<T>} */ (this.gate.resolve(owner, `history:${this.sequence}`, { reuseRecent: false }, work));
    /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer;
    /** @type {Promise<never>} */ const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(historyError("session_history_unavailable", 503)), REQUEST_MS);
    });
    return Promise.race([task, timeout]).catch(error => {
      if (error && typeof error === "object" && "code" in error && error.code === "SESSION_RESOLUTION_BUSY") throw historyError("session_history_unavailable", 503);
      throw error;
    }).finally(() => { if (timer) clearTimeout(timer); });
  }
  /** @param {string} owner @param {Record<string,unknown>} query @returns {Promise<import('./sessionHistoryTypes').HistoryList>} */
  list(owner, query = {}) {
    const check = this.check(owner);
    return this.admit(owner, async () => {
      check();
      const limit = integer(query.limit ?? 20, 1, 50);
      const page = query.before === undefined ? null : parsePageDescriptor(query.before);
      const context = await this.naturalContext(owner, query, page); check();
      if (page && (page.s !== context.scopeHash || page.g !== context.gapMinutes)) return stale();
      const load = await this.load(owner, context, check); check();
      if (page && page.h !== load.digest) return stale();
      const value = this.listResult(load, page, limit); check(); return value;
    });
  }
  /** @param {string} owner @param {Record<string,unknown>} query @returns {Promise<import('./sessionHistoryTypes').HistoryCurrent>} */
  current(owner, query = {}) {
    const check = this.check(owner);
    return this.admit(owner, async () => {
      check();
      const context = await this.currentContext(owner, query); check();
      const load = await this.load(owner, context, check); check();
      const value = load.status === "ready" ? load.candidates.at(-1) : null;
      const session = value ? publicSummary(value, context) : null;
      check(); return { ...base(load), kind: "current", session, manualAnchorAt: context.anchor,
        activity: session ? session.active ? "active" : "last" : "empty" };
    });
  }
  /** @param {string} owner @param {string} id @param {Record<string,unknown>} query @returns {Promise<import('./sessionHistoryTypes').HistoryDetail>} */
  detail(owner, id, query = {}) {
    const check = this.check(owner);
    return this.admit(owner, async () => {
      check();
      const descriptor = parseSessionDescriptor(id);
      integer(query.gamesLimit ?? 50, 1, 100);
      if (query.gamesBefore !== undefined) parseGamePageDescriptor(query.gamesBefore);
      const context = descriptor.k === "current" ? await this.currentContext(owner, query) : await this.detailContext(owner, descriptor, query);
      check();
      if (descriptor.s !== context.scopeHash || descriptor.g !== context.gapMinutes || descriptor.a !== context.anchor) return stale();
      const load = await this.load(owner, context, check); check();
      const value = this.detailResult(load, descriptor, id, query); check(); return value;
    });
  }
  /** @param {string} owner */
  check(owner) {
    const guard = this.capturePublication(owner), started = Date.now();
    return () => { guard(); if (Date.now() - started >= REQUEST_MS) throw historyError("session_history_unavailable", 503); };
  }
  /** @param {string} owner @param {Record<string,unknown>} query @param {import('./sessionHistoryTypes').PageDescriptor|null} page
   * @returns {Promise<import('./sessionHistoryTypes').HistoryContext>} */
  async naturalContext(owner, query, page) {
    const filters = membershipFilters(query), policy = await this.policy.resolve(owner);
    const span = naturalSpan(query, this.now(), policy.gapMinutes, filters, page);
    return { mode: "natural", gapMinutes: policy.gapMinutes, scopeHash: scopeHash(owner, "natural", policy.gapMinutes, filters),
      filters, span, floor: filters.since?.getTime() ?? null, ceiling: Math.min(filters.until?.getTime() ?? span.asOf, span.asOf), anchor: null };
  }
  /** @param {string} owner @param {import('./sessionHistoryTypes').SessionDescriptor} id @param {Record<string,unknown>} query */
  async detailContext(owner, id, query) {
    const filters = membershipFilters(query), policy = await this.policy.resolve(owner), now = this.now();
    const span = makeSpan(Date.parse(id.f), Date.parse(id.e) + 1, now, policy.gapMinutes,
      integer(query.contextDays ?? 0, 0, 30), timezone(query.tz), filters.since?.getTime() ?? null, filters.until?.getTime() ?? now);
    return { mode: /** @type {const} */ ("natural"), gapMinutes: policy.gapMinutes, scopeHash: scopeHash(owner, "natural", policy.gapMinutes, filters),
      filters, span, floor: filters.since?.getTime() ?? null, ceiling: Math.min(filters.until?.getTime() ?? now, now), anchor: null };
  }
  /** @param {string} owner @param {Record<string,unknown>} query @returns {Promise<import('./sessionHistoryTypes').HistoryContext>} */
  async currentContext(owner, query) {
    if (Object.keys(query).some(key => !["tz", "contextDays", "gamesLimit", "gamesBefore"].includes(key))) return invalid();
    integer(query.contextDays ?? 0, 0, 30);
    const profile = await this.db.users.findOne({ userId: owner }, { projection: { _id: 0, userId: 1, sessionGapMinutes: 1, sessionAnchorAt: 1, _gdprMutation: 1 } });
    if (!profile) throw historyError("account_deleted", 401);
    if (profile._gdprMutation) throw historyError("gdpr_operation_busy", 503);
    const policy = await this.policy.resolve(owner, { ownerKnown: true, storedGapMinutes: profile.sessionGapMinutes });
    const now = this.now(), rawAnchor = typeof profile.sessionAnchorAt === "string" ? Date.parse(profile.sessionAnchorAt) : NaN;
    const anchor = Number.isFinite(rawAnchor) && Math.abs(rawAnchor) <= MAX_DATE_MS ? new Date(rawAnchor).toISOString() : null;
    const floor = Math.max(-MAX_DATE_MS, now - 14 * DAY, anchor === null ? -MAX_DATE_MS : Date.parse(anchor));
    const filters = { since: new Date(floor), until: new Date(now) };
    const span = { from: floor, to: now + 1, asOf: now, scanFrom: floor, scanTo: now, contextDays: 0, tz: timezone(query.tz) };
    return { mode: "current", gapMinutes: policy.gapMinutes, scopeHash: scopeHash(owner, "current", policy.gapMinutes, { liveDays: 14, anchor }),
      filters, span, floor, ceiling: now, anchor };
  }
  /** @param {string} owner @param {import('./sessionHistoryTypes').HistoryContext} context @param {()=>void} check */
  async load(owner, context, check) {
    try {
      const result = await queryHistoryRows(this.db, owner, context, check);
      return shapeLoad(context, result.overflow, result.overflow ? [] : completeCandidates(result.rows, context));
    }
    catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      if (code === "session_history_field_limit" || code === "session_history_rows_invalid") return shapeLoad(context, true, []);
      throw error;
    }
  }
  /** @param {import('./sessionHistoryTypes').HistoryLoad} load @param {import('./sessionHistoryTypes').PageDescriptor|null} page @param {number} limit
   * @returns {import('./sessionHistoryTypes').HistoryList} */
  listResult(load, page, limit) {
    const values = load.candidates.filter(value => inOutput(value, load.context)).reverse();
    const index = page ? values.findIndex(value => encode(value.descriptor) === page.b) : -1;
    if (page && index < 0) return stale();
    const selected = load.status === "ready" ? values.slice(index + 1, index + 1 + limit) : [];
    const last = selected.at(-1), span = load.context.span;
    const more = last && index + 1 + selected.length < values.length;
    const before = more ? encode({ v: 1, k: "before", s: load.context.scopeHash, g: load.context.gapMinutes,
      f: new Date(span.from).toISOString(), t: new Date(span.to).toISOString(), n: new Date(span.asOf).toISOString(), c: span.contextDays,
      z: span.tz, h: load.digest, b: encode(last.descriptor) }) : null;
    return { ...base(load), kind: "history", items: selected.map(value => publicSummary(value, load.context)), nextBefore: before,
      nextWindow: load.status === "ready" ? olderWindow(load.context) : null };
  }
  /** @param {import('./sessionHistoryTypes').HistoryLoad} load @param {import('./sessionHistoryTypes').SessionDescriptor} descriptor @param {string} id
   * @param {Record<string,unknown>} query @returns {import('./sessionHistoryTypes').HistoryDetail} */
  detailResult(load, descriptor, id, query) {
    const limit = integer(query.gamesLimit ?? 50, 1, 100), page = query.gamesBefore === undefined ? null : parseGamePageDescriptor(query.gamesBefore);
    if (page && page.s !== id) return stale();
    const value = load.candidates.find(row => row.descriptor.f === descriptor.f && row.descriptor.e === descriptor.e);
    if (load.status === "narrow_window") return { ...base(load), kind: "detail", session: null, games: [], gamePage: { limit, count: 0, total: 0 }, nextGamesBefore: null, mmr: [] };
    if (!value || value.descriptor.h !== descriptor.h || (load.context.mode === "current" && value !== load.candidates.at(-1))) return stale();
    if (!value.coverage) return { ...base(load), kind: "detail", session: null, games: [], gamePage: { limit, count: 0, total: 0 }, nextGamesBefore: null, mmr: [] };
    const offset = page?.p ?? 0;
    if (offset >= value.games.length && page) return stale();
    const games = value.games.slice(offset, offset + limit), end = offset + games.length;
    return { ...base(load), kind: "detail", session: publicSummary(value, load.context), games,
      gamePage: { limit, count: games.length, total: value.games.length },
      nextGamesBefore: end < value.games.length ? encode({ v: 1, k: "games", s: id, p: end }) : null, mmr: value.candidate.summary.mmr };
  }
}
module.exports = { SessionHistoryService, REQUEST_MS };
