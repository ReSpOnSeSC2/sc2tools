"use strict";

const { maintainGameStats, immutableSelection, PROTOCOL_VERSION } = require("./gameStatsMaintenance");
const { statsReadFloorFor } = require("./gameStatsReadFloor");
const { immutableNeutralMutation, immutableNeutralOwner, applyNeutralMutation, carryUnchangedGameStats, carryDefinitionGameStats, neutralAuthority,
  carryOpponentRepairGameStats } = require("./gameStatsCountNeutral");

const { types } = require("util");
const { immutableCustomBuildDefinitionSave, applyCustomBuildDefinitionSave } = require("./gameStatsCustomBuildDefinitionSave");
const { OPPONENT_REPAIR_KIND, isOpponentGameFamily, repairContextOwner, issueOpponentIdentityRepair, assertReservedDispatch,
  applyOpponentGameIdentityRepair } = require("./gameStatsOpponentGame");

const MAX_ACTIVE = 8;
const DELETE_BATCH = 100;
/** @typedef {{userId:string,id:any,epoch?:string,compatibility:boolean}} GameStatsOwner */
/** @typedef {{fenceId?:string,selection?:import('./gameStatsMaintenance').StatsSelection}} AuthorityOptions */
/** @type {WeakMap<object,GameStatsWrites>} */
const instances = new WeakMap();
/** @type {WeakMap<GameStatsWrites,DefinitionCapability>} */
const definitionCapabilities = new WeakMap();
/** @typedef {{perform:(owner:GameStatsOwner,mutation:Readonly<import('./gameStatsOpponentGame').OpponentGameIdentityRepairMutation>)=>Promise<import('mongodb').UpdateResult>}} OpponentRepairCapability */
/** @type {WeakMap<GameStatsWrites,OpponentRepairCapability>} */
const opponentRepairCapabilities = new WeakMap();

/** Eager writer maintenance; request-local readers use separate strict proof.
 * A real owner write conflicts with fence acquisition/erasure on that row.
 * Every games command in work must receive the supplied session. */
class GameStatsWrites {
  /** @param {import('../db/connect').DbContext} db @param {any} [logger] */
  constructor(db, logger) {
    this.db = db; this.logger = logger;
    this.stopped = false;
    /** @type {Set<Promise<any>>} */ this.pending = new Set();
    definitionCapabilities.set(this, { reservations: new Set(), perform: (owner, mutation) => this.#perform(owner,
      session => {
        if (this.stopped) throw failure("game_stats_writer_stopping");
        return applyCustomBuildDefinitionSave(this.db, owner, mutation, session, this.logger);
      }, Object.freeze({}), null, mutation) });
    opponentRepairCapabilities.set(this, { perform: (owner, mutation) => this.#perform(owner,
      session => applyOpponentGameIdentityRepair(this.db, owner, mutation, session), Object.freeze({}), null, mutation) });
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
   * @param {import('./gameStatsCustomBuildIngestTag').CustomBuildIngestTagMutation} work
   * @returns {Promise<import('./gameStatsCustomBuildIngestTag').CustomBuildIngestTagResult>} */
  /** @overload @param {GameStatsOwner} owner
   * @param {import('./gameStatsCountNeutral').UpdateNeutralMutation} work
   * @returns {Promise<import('mongodb').UpdateResult>} */
  /** @overload @param {GameStatsOwner} owner
   * @param {import('./gameStatsCountNeutral').NeutralMutation} work
   * @returns {Promise<import('./gameStatsCountNeutral').NeutralResult>} */
  /** @template T @param {GameStatsOwner} owner
   * @param {((session:import('mongodb').ClientSession|undefined)=>Promise<T>)|import('./gameStatsCountNeutral').NeutralMutation} work
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
   * @param {Readonly<import('./gameStatsCountNeutral').ReservedCarryMutation>|null} mutation @returns {Promise<T>} */
  async #perform(owner, work, options, selection, mutation) {
    if (owner.compatibility) {
      // Explicit standalone/test compatibility does not mint a valid revision.
      // Existing retained state is durably retired before legacy work. Unknown
      // or failed retirement must never dispatch that work.
      if (owner.id !== null) {
        const retired = await this.db.users.updateOne(operationAuthority(this, owner, options, mutation), {
          $set: { gameStatsWriterStatus: "unsupported" },
          $unset: { gameStats: "", gameStatsRevision: "", gameStatsProtocolVersion: "", gameStatsMaintenance: "" },
        }, { upsert: false });
        if (!retiredExactly(retired, mutation)) throw failure("game_stats_authority_changed");
      }
      return compatibilityWork(this, work, mutation);
    }
    if (!this.db.client || owner.id === null) throw failure("game_stats_transactions_required");
    const prepared = statsReadFloorFor(this.db, this.logger)();
    const floor = prepared instanceof Promise ? await prepared : prepared;
    // The barrier may outlive HTTP closure or shutdown. Never dispatch new
    // transaction work after stop; the charged task owns the barrier lifetime.
    if (this.stopped) throw failure("game_stats_writer_stopping");
    assertReservedDispatch(owner, mutation);
    const session = this.db.client.startSession({ causalConsistency: true });
    session.advanceOperationTime(floor);
    try {
      return /** @type {T} */ (await session.withTransaction(/** @returns {Promise<T|import('./gameStatsCountNeutral').NeutralResult|number>} */ () => mutation
        ? performNeutral(this.db, owner, mutation, session)
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
    for (const state of definitionCapabilities.get(this)?.reservations || []) {
      if (!state.started) abandonDefinition(state, failure("game_stats_writer_stopping"));
    }
    await Promise.allSettled([...this.pending]);
  }
}

/** Synchronous preparation precedes admission/floor awaits. Only the named
 * fixed updaters can select carry; ordinary callbacks retain full maintenance.
 * @param {import('../db/connect').DbContext} db @param {GameStatsOwner} owner
 * @param {((session:import('mongodb').ClientSession|undefined)=>Promise<any>)|import('./gameStatsCountNeutral').NeutralMutation} work
 * @param {AuthorityOptions} options */
function prepareOperation(db, owner, work, options) {
  if (typeof work === "function") return { owner, work, options,
    selection: owner.compatibility ? null : immutableSelection(options.selection), mutation: null };
  const mutation = immutableNeutralMutation(work, options), captured = immutableNeutralOwner(owner);
  return { owner: captured, options: Object.freeze({}), selection: null, mutation,
    work: (/** @type {import('mongodb').ClientSession|undefined} */ session) => applyNeutralMutation(db, captured, mutation, session) };
}

/** Internal authority selection does not broaden ordinary callback options.
 * @param {GameStatsWrites} writer @param {GameStatsOwner} owner
 * @param {AuthorityOptions} options
 * @param {Readonly<import('./gameStatsCountNeutral').ReservedCarryMutation>|null} mutation */
function operationAuthority(writer, owner, options, mutation) {
  return mutation ? neutralAuthority(owner, mutation) : writer.authority(owner, options);
}

/** @param {import('../db/connect').DbContext} db @param {any} [logger] */
function gameStatsWritesFor(db, logger) {
  let writer = instances.get(db);
  if (!writer) { writer = new GameStatsWrites(db, logger); instances.set(db, writer); }
  else if (logger) writer.logger = logger;
  return writer;
}

/** @param {import('../db/connect').DbContext} db @param {GameStatsOwner} owner
 * @param {Readonly<import('./gameStatsCountNeutral').ReservedCarryMutation>} mutation
 * @param {import('mongodb').ClientSession} session */
function performNeutral(db, owner, mutation, session) {
  if (mutation.kind === OPPONENT_REPAIR_KIND) return carryOpponentRepairGameStats(db, owner, mutation, session);
  return mutation.kind === "customBuildDefinitionSave" ? carryDefinitionGameStats(db, owner, mutation, session)
    : carryUnchangedGameStats(db, owner, mutation, session);
}

/** Opponent-game families also require an acknowledged single retirement;
 * every existing callback keeps its matched-count-only behavior.
 * @param {import('mongodb').UpdateResult} retired
 * @param {Readonly<import('./gameStatsCountNeutral').ReservedCarryMutation>|null} mutation */
function retiredExactly(retired, mutation) {
  return retired.matchedCount === 1 && (!isOpponentGameFamily(mutation?.kind) || retired.acknowledged === true);
}

/** After acknowledged retirement, a stopped writer never dispatches opponent
 * game work; existing callback families keep their prior behavior.
 * @template T @param {GameStatsWrites} writer
 * @param {(session:import('mongodb').ClientSession|undefined)=>Promise<T>} work
 * @param {Readonly<import('./gameStatsCountNeutral').ReservedCarryMutation>|null} mutation @returns {Promise<T>} */
function compatibilityWork(writer, work, mutation) {
  if (writer.stopped && isOpponentGameFamily(mutation?.kind)) throw failure("game_stats_writer_stopping");
  return work(undefined);
}

/** A fixed fenced heal, not an arbitrary admitted callback. It repeats write()'s
 * stop, capacity and pending accounting, so stopAndDrain awaits it; only a
 * genuine live repair context with the identity descriptor can be issued.
 * @param {GameStatsWrites} writer @param {Readonly<import('./gameStatsOpponentGame').OpponentRepairContext>} context
 * @param {import('./gameStatsOpponentGame').OpponentGameIdentityMutation} input
 * @returns {Promise<import('mongodb').UpdateResult>} */
function writeOpponentGameIdentityRepair(writer, context, input) {
  const capability = opponentRepairCapabilities.get(writer);
  if (!capability) return Promise.reject(failure("game_stats_repair_writer_required"));
  if (writer.stopped) return Promise.reject(failure("game_stats_writer_stopping"));
  if (writer.pending.size >= MAX_ACTIVE) return Promise.reject(failure("game_stats_writer_busy"));
  let owner, mutation;
  try {
    owner = immutableNeutralOwner(/** @type {GameStatsOwner} */ (repairContextOwner(context)));
    mutation = issueOpponentIdentityRepair(context, owner, input);
  } catch (error) { return Promise.reject(error); }
  const task = capability.perform(owner, mutation);
  writer.pending.add(task);
  void task.then(() => writer.pending.delete(task), () => writer.pending.delete(task));
  return task;
}

/** @template T @typedef {{ok:true,value:T}|{ok:false,error:unknown}} DefinitionOutcome */
/** @typedef {{perform:(owner:GameStatsOwner,mutation:Readonly<import('./gameStatsCustomBuildDefinitionSave').DefinitionSaveMutation>)=>Promise<number>,reservations:Set<DefinitionReservation>}} DefinitionCapability */
/** @typedef {{writer:GameStatsWrites,capability:DefinitionCapability,userId:string,
 * mutation:Readonly<import('./gameStatsCustomBuildDefinitionSave').DefinitionSaveMutation>,started:boolean,
 * committed:boolean,abandoned:boolean,finishing:boolean,reason:unknown,
 * capture:Promise<DefinitionOutcome<GameStatsOwner>>|null,queue:Promise<DefinitionOutcome<unknown>>|null,
 * work:Promise<DefinitionOutcome<number>>|null,lifetime:Promise<void>,resolve:()=>void,reject:(error:unknown)=>void}} DefinitionReservation */
/** @typedef {{start:(queue:Promise<unknown>)=>Promise<void>,commit:()=>Promise<number>,abandon:(error:unknown)=>Promise<void>}} DefinitionSaveTicket */
/** A fixed reservation, not an arbitrary admitted callback. Constructor-owned
 * capabilities reject structural lookalikes and avoid an eighth class method.
 * @param {GameStatsWrites} writer @param {string} userId
 * @param {import('./gameStatsCustomBuildDefinitionSave').DefinitionSaveMutation} input
 * @returns {DefinitionSaveTicket} */
function reserveCustomDefinitionSave(writer, userId, input) {
  const capability = definitionCapabilities.get(writer);
  if (!capability) throw failure("game_stats_definition_writer_required");
  if (writer.stopped) throw failure("game_stats_writer_stopping");
  if (writer.pending.size >= MAX_ACTIVE) throw failure("game_stats_writer_busy");
  const mutation = immutableCustomBuildDefinitionSave(input);
  if (typeof userId !== "string" || !userId) throw failure("game_stats_owner_required");
  const state = definitionState(writer, capability, userId, mutation);
  return Object.freeze({ start: queue => startDefinition(state, queue), commit: () => commitDefinition(state),
    abandon: error => abandonDefinition(state, error) });
}

/** @param {GameStatsWrites} writer @param {DefinitionCapability} capability @param {string} userId
 * @param {Readonly<import('./gameStatsCustomBuildDefinitionSave').DefinitionSaveMutation>} mutation */
function definitionState(writer, capability, userId, mutation) {
  let resolve = () => {}; /** @type {(error:unknown)=>void} */ let reject = () => {};
  /** @type {Promise<void>} */ const lifetime = new Promise((done, fail) => { resolve = done; reject = fail; });
  /** @type {DefinitionReservation} */ const state = { writer, capability, userId, mutation, started: false,
    committed: false, abandoned: false, finishing: false, capture: null, queue: null, work: null, reason: null,
    lifetime, resolve, reject };
  writer.pending.add(lifetime); capability.reservations.add(state);
  const release = () => { writer.pending.delete(lifetime); capability.reservations.delete(state); };
  void lifetime.then(release, release);
  return state;
}

/** Immediate outcome handlers avoid detached capture or queue rejections.
 * @template T @param {Promise<T>} promise @returns {Promise<DefinitionOutcome<T>>} */
function definitionOutcome(promise) {
  return promise.then(value => /** @type {DefinitionOutcome<T>} */ ({ ok: true, value }),
    error => /** @type {DefinitionOutcome<T>} */ ({ ok: false, error }));
}

/** @param {DefinitionReservation} state @param {Promise<unknown>} queue @returns {Promise<void>} */
function startDefinition(state, queue) {
  if (state.started || state.abandoned || !types.isPromise(queue)) throw failure("game_stats_definition_ticket_used");
  state.started = true;
  state.queue = definitionOutcome(queue);
  state.capture = definitionOutcome(captureDefinitionOwner(state));
  void state.queue.then(queued => finishDefinition(state, queued));
  return state.lifetime;
}

/** @param {DefinitionReservation} state @returns {Promise<GameStatsOwner>} */
async function captureDefinitionOwner(state) {
  const owner = immutableNeutralOwner(await state.writer.capture(state.userId));
  if (owner.userId !== state.userId || owner.id === null || !state.writer.db.client?.startSession) throw failure("game_stats_owner_unavailable");
  return owner;
}

/** WORK is separate from lifetime: the queue contains this promise and must
 * finish gameWrite/FIFO finally before the joined pending slot can release.
 * @param {DefinitionReservation} state @returns {Promise<number>} */
function commitDefinition(state) {
  if (!state.started || state.committed || state.abandoned) return Promise.reject(state.abandoned ? state.reason : failure("game_stats_definition_ticket_used"));
  state.committed = true;
  const work = runDefinition(state);
  state.work = definitionOutcome(work);
  return work;
}

/** @param {DefinitionReservation} state @returns {Promise<number>} */
async function runDefinition(state) {
  const captured = await /** @type {Promise<DefinitionOutcome<GameStatsOwner>>} */ (state.capture);
  if (!captured.ok) throw captured.error;
  if (state.writer.stopped) throw failure("game_stats_writer_stopping");
  return state.capability.perform(captured.value, state.mutation);
}

/** Close future commit before awaiting. An already-running transaction is
 * never cancelled, relabelled or released by abandonment.
 * @param {DefinitionReservation} state @param {unknown} error @returns {Promise<void>} */
function abandonDefinition(state, error) {
  if (!state.committed && !state.abandoned) { state.abandoned = true; state.reason = error; }
  if (!state.started) {
    /** @type {DefinitionOutcome<unknown>} */ const queued = { ok: false, error };
    state.queue = Promise.resolve(queued);
    void finishDefinition(state, queued);
  }
  return state.lifetime;
}

/** Terminal queue state closes future commit before awaiting capture/work.
 * @param {DefinitionReservation} state @param {DefinitionOutcome<unknown>} queued @returns {Promise<void>} */
async function finishDefinition(state, queued) {
  if (state.finishing) return;
  state.finishing = true;
  if (!state.committed && !state.abandoned) {
    state.abandoned = true; state.reason = failure("game_stats_definition_ticket_unused");
  }
  const captured = state.capture ? await state.capture : null;
  const worked = state.work ? await state.work : null;
  const outcome = definitionResult(state, queued, captured, worked);
  if (outcome.ok) state.resolve(); else state.reject(outcome.error);
}

/** Queue failure stays primary after every actual lifetime has joined.
 * @param {DefinitionReservation} state @param {DefinitionOutcome<unknown>} queued
 * @param {DefinitionOutcome<GameStatsOwner>|null} captured @param {DefinitionOutcome<number>|null} worked
 * @returns {DefinitionOutcome<void>} */
function definitionResult(state, queued, captured, worked) {
  if (!queued.ok) return queued;
  if (worked?.ok === false) return worked;
  if (captured?.ok === false) return captured;
  return state.committed ? { ok: true, value: undefined } : { ok: false, error: state.reason };
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

module.exports = { GameStatsWrites, gameStatsWritesFor, sessionArgs, assertGameStatsContext, PROTOCOL_VERSION, MAX_ACTIVE, DELETE_BATCH, reserveCustomDefinitionSave,
  writeOpponentGameIdentityRepair };
