"use strict";

const { maintainGameStats, immutableSelection, PROTOCOL_VERSION } = require("./gameStatsMaintenance");
const { statsReadFloorFor } = require("./gameStatsReadFloor");
const { immutableMacroSurface, immutableNeutralOwner, applyMacroSurface, carryUnchangedGameStats } = require("./gameStatsCountNeutral");

const MAX_ACTIVE = 8;
const DELETE_BATCH = 100;
/** @typedef {{userId:string,id:any,epoch?:string,compatibility:boolean}} GameStatsOwner */
/** @typedef {{fenceId?:string,selection?:import('./gameStatsMaintenance').StatsSelection}} AuthorityOptions */
/** @type {WeakMap<object,GameStatsWrites>} */
const instances = new WeakMap();

/** Eager writer maintenance; request-local readers use separate strict proof.
 * A real owner write conflicts with fence acquisition/erasure on that row.
 * Every games command in work must receive the supplied session. */
class GameStatsWrites {
  /** @param {import('../db/connect').DbContext} db @param {any} [logger] */
  constructor(db, logger) {
    this.db = db; this.logger = logger;
    this.stopped = false;
    /** @type {Set<Promise<any>>} */ this.pending = new Set();
  }

  /** Capture identity before external payload work; never rebind on retry.
   * @param {string} userId
   * @param {{unfenced?:boolean}} [options]
   * @returns {Promise<GameStatsOwner|null>} */
  async captureOptional(userId, options = {}) {
    if (this.stopped) throw failure("game_stats_writer_stopping");
    if (typeof userId !== "string" || !userId) throw failure("game_stats_owner_required");
    const compatibility = this.db.gameStatsTransactions !== true;
    if (compatibility && process.env.NODE_ENV === "production") throw failure("game_stats_transactions_required");
    const users = this.db.users;
    const row = users?.findOne ? await users.findOne({ userId, ...(options.unfenced ? { _gdprMutation: { $exists: false } } : {}) }, { projection: { _id: 1, gameStatsMutationEpoch: 1 }, maxTimeMS: 2000 }) : null;
    if (!row || row._id === undefined) {
      return null;
    }
    if (row.gameStatsMutationEpoch !== undefined && (typeof row.gameStatsMutationEpoch !== "string"
      || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(row.gameStatsMutationEpoch))) throw failure("game_stats_mutation_epoch_malformed");
    return { userId, id: row._id, epoch: row.gameStatsMutationEpoch, compatibility };
  }

  /** @param {string} userId @returns {Promise<GameStatsOwner>} */
  async capture(userId) {
    // Admission cannot inherit an active destructive operation's new epoch
    // and wait for its fence to disappear. Identity+epoch+absence are one read.
    const owner = await this.captureOptional(userId, { unfenced: true });
    if (owner) return owner;
    // Legacy slim test fixtures can omit users. They cannot mint authority.
    if (this.db.gameStatsTransactions !== true && process.env.NODE_ENV === "test") {
      if (this.db.users?.findOne && await this.db.users.findOne({ userId }, { projection: { _id: 1 }, maxTimeMS: 2000 })) throw failure("game_stats_owner_unavailable");
      return { userId, id: null, compatibility: true };
    }
    throw failure("game_stats_owner_unavailable");
  }

  /** A production destructive operation must carry its admission identity.
   * @param {string} userId @param {{owner?:GameStatsOwner|null}} fence
   * @returns {Promise<GameStatsOwner>} */
  async forFence(userId, fence) {
    if (fence.owner) {
      if (fence.owner.userId !== userId) throw failure("game_stats_owner_unavailable");
      return fence.owner;
    }
    if (this.db.gameStatsTransactions === true || process.env.NODE_ENV === "production") throw failure("game_stats_owner_unavailable");
    return this.capture(userId);
  }

  /** @param {GameStatsOwner} owner @param {AuthorityOptions} [options] */
  authority(owner, options = {}) {
    return { userId: owner.userId, ...(owner.id === null ? {} : { _id: owner.id }),
      gameStatsMutationEpoch: owner.epoch === undefined ? { $exists: false } : owner.epoch,
      ...(options.fenceId ? { "_gdprMutation.id": options.fenceId } : { _gdprMutation: { $exists: false } }) };
  }

  /** @template T @overload @param {GameStatsOwner} owner
   * @param {(session:import('mongodb').ClientSession|undefined)=>Promise<T>} work
   * @param {AuthorityOptions} [options] @returns {Promise<T>} */
  /** @overload @param {GameStatsOwner} owner
   * @param {import('./gameStatsCountNeutral').MacroSurfaceMutation} work
   * @returns {Promise<import('mongodb').UpdateResult>} */
  /** @template T @param {GameStatsOwner} owner
   * @param {((session:import('mongodb').ClientSession|undefined)=>Promise<T>)|import('./gameStatsCountNeutral').MacroSurfaceMutation} work
   * @param {AuthorityOptions} [options] @returns {Promise<any>} */
  write(owner, work, options = {}) {
    if (this.stopped) return Promise.reject(failure("game_stats_writer_stopping"));
    if (this.pending.size >= MAX_ACTIVE) return Promise.reject(failure("game_stats_writer_busy"));
    let operation;
    try { operation = prepareOperation(this.db, owner, work, options); }
    catch (error) { return Promise.reject(error); }
    const task = this.#perform(operation.owner, operation.work, operation.options, operation.selection, operation.mutation);
    this.pending.add(task);
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task));
    return task;
  }

  /** @template T @param {GameStatsOwner} owner
   * @param {(session:import('mongodb').ClientSession|undefined)=>Promise<T>} work
   * @param {AuthorityOptions} options @param {Readonly<Record<string,any>>|null} selection
   * @param {Readonly<import('./gameStatsCountNeutral').MacroSurfaceMutation>|null} mutation @returns {Promise<T>} */
  async #perform(owner, work, options, selection, mutation) {
    if (owner.compatibility) {
      // Explicit standalone/test compatibility does not mint a valid revision.
      // Existing retained state is durably retired before legacy work. Unknown
      // or failed retirement must never dispatch that work.
      if (owner.id !== null) {
        const retired = await this.db.users.updateOne(this.authority(owner, options), {
          $set: { gameStatsWriterStatus: "unsupported" },
          $unset: { gameStats: "", gameStatsRevision: "", gameStatsProtocolVersion: "", gameStatsMaintenance: "" },
        }, { upsert: false });
        if (retired.matchedCount !== 1) throw failure("game_stats_authority_changed");
      }
      return work(undefined);
    }
    if (!this.db.client || owner.id === null) throw failure("game_stats_transactions_required");
    const prepared = statsReadFloorFor(this.db, this.logger)();
    const floor = prepared instanceof Promise ? await prepared : prepared;
    // The barrier may outlive HTTP closure or shutdown. Never dispatch new
    // transaction work after stop; the charged task owns the barrier lifetime.
    if (this.stopped) throw failure("game_stats_writer_stopping");
    const session = this.db.client.startSession({ causalConsistency: true });
    session.advanceOperationTime(floor);
    try {
      return /** @type {T} */ (await session.withTransaction(/** @returns {Promise<T|import('mongodb').UpdateResult>} */ () => mutation
        ? carryUnchangedGameStats(this.db, owner, mutation, session)
        : maintainGameStats(this.db, owner, this.authority(owner, options), /** @type {Readonly<Record<string,any>>} */ (selection), work, session),
      { readConcern: { level: "snapshot" }, writeConcern: { w: "majority", j: true, wtimeoutMS: 5000 },
        readPreference: "primary", maxCommitTimeMS: 5000, timeoutMS: 10_000 }));
    } finally {
      // Disposal failure is diagnostic; it cannot replace an original Mongo
      // outcome or turn an unknown commit into a retry of external effects.
      try { await session.endSession(); }
      catch (error) { try { this.logger?.warn?.({ err: error }, "game_stats_session_cleanup_failed"); } catch { /* Diagnostic only. */ } }
    }
  }

  /** Bounded deletion preserves the original filter (including captured IDs).
   * External cleanup/notifications and the cursor are outside retries.
   * @param {GameStatsOwner} owner @param {Record<string,any>} filter
   * @param {AuthorityOptions & {assert?:()=>Promise<void>}} [options] */
  async deleteMany(owner, filter, options = {}) {
    if (owner.compatibility) {
      await options.assert?.();
      return this.write(owner, () => this.db.games.deleteMany(filter), options);
    }
    let deletedCount = 0;
    for (;;) {
      await options.assert?.();
      const rows = await this.db.games.find(filter, { projection: { _id: 1 } }).limit(DELETE_BATCH).toArray();
      if (!rows.length) {
        // Even an empty wipe eagerly initializes/recovers its retained total.
        if (!deletedCount) return this.write(owner, async () => ({ acknowledged: true, deletedCount }), { ...options, selection: { ids: [] } });
        return { acknowledged: true, deletedCount };
      }
      const ids = rows.map(row => row._id);
      const result = await this.write(owner, session => this.db.games.deleteMany(
        { $and: [filter, { _id: { $in: ids } }] }, session ? { session } : {},
      ), { ...options, selection: { ids } });
      deletedCount += result.deletedCount;
    }
  }

  /** Stop future dispatch, then wait for actual transaction promises, including
   * requests whose HTTP socket already closed. @returns {Promise<void>} */
  async stopAndDrain() {
    this.stopped = true;
    await Promise.allSettled([...this.pending]);
  }
}

/** Synchronous preparation precedes admission/floor awaits. Only the named
 * fixed updater can select carry; ordinary callbacks retain full maintenance.
 * @param {import('../db/connect').DbContext} db @param {GameStatsOwner} owner
 * @param {((session:import('mongodb').ClientSession|undefined)=>Promise<any>)|import('./gameStatsCountNeutral').MacroSurfaceMutation} work
 * @param {AuthorityOptions} options */
function prepareOperation(db, owner, work, options) {
  if (typeof work === "function") return { owner, work, options,
    selection: owner.compatibility ? null : immutableSelection(options.selection), mutation: null };
  const mutation = immutableMacroSurface(work, options), captured = immutableNeutralOwner(owner);
  return { owner: captured, options: Object.freeze({}), selection: null, mutation,
    work: (/** @type {import('mongodb').ClientSession|undefined} */ session) => applyMacroSurface(db, captured, mutation, session) };
}

/** @param {import('../db/connect').DbContext} db @param {any} [logger] */
function gameStatsWritesFor(db, logger) {
  let writer = instances.get(db);
  if (!writer) { writer = new GameStatsWrites(db, logger); instances.set(db, writer); }
  else if (logger) writer.logger = logger;
  return writer;
}
/** @param {string} code */
function failure(code) { return Object.assign(new Error(code), { code, status: 503 }); }

/** Keep legacy fake command arity while supplying a typed real-session tuple.
 * @param {import('mongodb').ClientSession|undefined} session
 * @returns {[]|[{session:import('mongodb').ClientSession}]} */
function sessionArgs(session) { return session ? [{ session }] : []; }

/** Production composition must not accidentally omit the connected-topology
 * capability and fall into development/test compatibility.
 * @param {import('../db/connect').DbContext} db @param {string|undefined} nodeEnv */
function assertGameStatsContext(db, nodeEnv) {
  if ((nodeEnv === "production" || process.env.NODE_ENV === "production")
    && (db.gameStatsTransactions !== true || typeof db.client?.startSession !== "function")) throw failure("game_stats_transactions_required");
}

module.exports = { GameStatsWrites, gameStatsWritesFor, sessionArgs, assertGameStatsContext, PROTOCOL_VERSION, MAX_ACTIVE, DELETE_BATCH };
