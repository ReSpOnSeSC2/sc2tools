"use strict";

const { randomUUID } = require("crypto");
const { performance } = require("perf_hooks");
const { sha256 } = require("../util/hash");

const AUTHORITY_KEY = "device-auth-reuse-authority-v1";
const OWNER_NAMESPACE = "device-auth-owner:v1";
const PROTOCOL_VERSION = 1;
const PENDING_LIMIT = 8;
const ACTIVE_LIMIT = 8;
const WRITER_DRAIN_MS = 2100;
const UUID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const KINDS = new Set(["issue", "revoke-hash", "revoke-id", "erase"]);
const WRITE_OPTIONS = Object.freeze({ writeConcern: { w: /** @type {const} */ ("majority"), j: true, wtimeoutMS: 5000 }, maxTimeMS: 5000 });
/** @typedef {{operationId:string,ownerHash:string,kind:string,phase:string}} PendingCredential */
/** @typedef {{_id:string,key:string,protocolVersion:number,ownerHashNamespace:string,
 * incarnation:string,generation:string,mode:string,grantsEverEnabled:boolean,
 * denyAll:boolean,pending:PendingCredential[]}} CredentialAuthority */
/** @type {WeakMap<object, DeviceCredentialWrites>} */
const instances = new WeakMap();

/** Writer preparation only. There is deliberately no grant, retained lookup,
 * activation or expiry API. Future readers must use the reviewed short-lease
 * protocol; seeing a prepared document does not authorize cached requests. */
class DeviceCredentialWrites {
  /** @param {import('mongodb').Collection<CredentialAuthority>} collection
   * @param {{logger?:any, now?:()=>number, wait?:(ms:number)=>Promise<void>}} [options] */
  constructor(collection, options = {}) {
    this.collection = collection;
    this.logger = options.logger;
    this.now = options.now || (() => performance.now());
    this.wait = options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.stopped = false;
    /** @type {Set<Promise<any>>} */ this.pending = new Set();
    /** @type {Promise<void>|null} */ this.preparation = null;
  }

  /** Missing history is conservative: a fresh incarnation still drains old
   * grants. Never reset an existing row, clear uncertainty, or enable readers.
   * No expiresAt/owner: generic lock TTL/release must not delete authority.
   * @returns {Promise<void>} */
  prepare() {
    if (!this.collection) return Promise.reject(failure("device_credential_authority_unavailable"));
    if (!this.preparation) {
      const preparation = this.collection.updateOne({ _id: AUTHORITY_KEY }, {
        $setOnInsert: { key: AUTHORITY_KEY, protocolVersion: PROTOCOL_VERSION,
          ownerHashNamespace: OWNER_NAMESPACE, incarnation: randomUUID(), generation: randomUUID(),
          mode: "prepared", grantsEverEnabled: true, denyAll: false, pending: [] },
      }, { ...WRITE_OPTIONS, upsert: true }).then(result => {
        if (result.acknowledged === false) throw failure("device_credential_authority_unacknowledged");
      }).catch(error => {
        // Concurrent first writers can race the fixed unique key. The begin
        // CAS still validates and majority-writes the actual existing row.
        if (error?.code !== 11000) throw error;
      });
      this.preparation = preparation;
      // Only concurrent setup is shared. A later missing record must get a
      // fresh prepared/unknown-history incarnation and full conservative drain.
      // Empty recreated pending is not proof old unknown work has settled;
      // future reader activation needs a new explicit incarnation cutover.
      void preparation.then(() => { if (this.preparation === preparation) this.preparation = null; },
        () => { if (this.preparation === preparation) this.preparation = null; });
      return preparation;
    }
    return this.preparation;
  }

  /** @returns {Record<string,any>} */
  #authority() {
    return { _id: AUTHORITY_KEY, key: AUTHORITY_KEY, protocolVersion: PROTOCOL_VERSION,
      expiresAt: { $exists: false }, owner: { $exists: false },
      ownerHashNamespace: OWNER_NAMESPACE, incarnation: { $regex: UUID }, generation: { $regex: UUID },
      mode: { $in: ["prepared", "active"] }, grantsEverEnabled: { $in: [false, true] },
      denyAll: { $in: [false, true] }, $expr: { $cond: [{ $isArray: "$pending" },
        { $lte: [{ $size: "$pending" }, PENDING_LIMIT] }, false] } };
  }

  /** @param {unknown} owner */
  ownerHash(owner) {
    return typeof owner === "string" && owner.length > 0 && owner.length <= 256
      ? sha256(`${OWNER_NAMESPACE}\0${owner}`) : null;
  }

  /** No timer/TTL frees pending credentials. Missing scope or full durable
   * capacity sets sticky denyAll, allowing original writes without inventing
   * unbounded per-owner state. @param {unknown} owner @param {string} kind */
  async begin(owner, kind) {
    await this.prepare();
    const operationId = randomUUID(), ownerHash = this.ownerHash(owner);
    const room = { $and: [{ $eq: ["$denyAll", false] }, ownerHash !== null,
      { $lt: [{ $size: "$pending" }, PENDING_LIMIT] }] };
    const row = await this.collection.findOneAndUpdate(this.#authority(), [{ $set: {
      generation: { $literal: randomUUID() },
      denyAll: { $or: ["$denyAll", ownerHash === null, { $gte: [{ $size: "$pending" }, PENDING_LIMIT] }] },
      pending: { $cond: [room, { $concatArrays: ["$pending", { $literal: [{ operationId, ownerHash, kind, phase: "draining" }] }] }, "$pending"] },
    } }], { ...WRITE_OPTIONS, returnDocument: "after" });
    if (!row || !validAuthority(row)) throw failure("device_credential_authority_unavailable");
    const tracked = row.pending.some(entry => entry.operationId === operationId);
    // Prepared mode or an absent predecessor cannot prove no old grant exists.
    // A future optimized bootstrap needs its own durable draining protocol.
    await this.#drainLeaseBound();
    if (tracked) {
      const writing = await this.collection.findOneAndUpdate({ ...this.#authority(), incarnation: row.incarnation,
        pending: { $elemMatch: { operationId, ownerHash, phase: "draining" } } }, {
        $set: { "pending.$.phase": "writing", generation: randomUUID() },
      }, { ...WRITE_OPTIONS, returnDocument: "after" });
      if (!validAuthority(writing)) throw failure("device_credential_operation_retired");
    } else {
      const blocked = await this.collection.findOneAndUpdate({ ...this.#authority(), incarnation: row.incarnation,
        denyAll: true }, { $set: { generation: randomUUID() } }, { ...WRITE_OPTIONS, returnDocument: "after" });
      if (!blocked || !validAuthority(blocked) || !blocked.denyAll) throw failure("device_credential_operation_retired");
    }
    return { operationId, ownerHash, kind, incarnation: row.incarnation, tracked };
  }

  /** Fixed elapsed-time wait begins only after durable pending ACK. Never use
   * a writer wall clock or an expired/failed claim as evidence. */
  async #drainLeaseBound() {
    const start = this.now();
    if (!Number.isFinite(start)) throw failure("device_credential_clock_invalid");
    let elapsed = 0;
    while (elapsed < WRITER_DRAIN_MS) {
      await this.wait(WRITER_DRAIN_MS - elapsed);
      const current = this.now();
      if (!Number.isFinite(current) || current < start + elapsed) throw failure("device_credential_clock_invalid");
      elapsed = current - start;
    }
  }

  /** @param {{operationId:string,ownerHash:string|null,kind:string,incarnation:string,tracked:boolean}} operation */
  async complete(operation) {
    if (!operation.tracked) return;
    if (operation.ownerHash === null) throw failure("device_credential_operation_retired");
    const result = await this.collection.updateOne({ ...this.#authority(), incarnation: operation.incarnation,
      pending: { $elemMatch: { operationId: operation.operationId, ownerHash: operation.ownerHash, kind: operation.kind, phase: "writing" } } }, {
      $pull: { pending: { operationId: operation.operationId, ownerHash: operation.ownerHash, kind: operation.kind, phase: "writing" } },
      $set: { generation: randomUUID() },
    }, WRITE_OPTIONS);
    if (result.acknowledged === false || result.matchedCount !== 1) throw failure("device_credential_completion_unavailable");
  }

  /** Diagnostic transition only: failure leaves the original durable gate.
   * It must never replace a credential writer's original result/rejection.
   * @param {{operationId:string,ownerHash:string|null,kind:string,incarnation:string,tracked:boolean}} operation */
  async uncertain(operation) {
    if (!operation.tracked) return;
    try {
      await this.collection.updateOne({ ...this.#authority(), incarnation: operation.incarnation,
        pending: { $elemMatch: { operationId: operation.operationId, ownerHash: operation.ownerHash, kind: operation.kind } } }, {
        $set: { "pending.$.phase": "uncertain", generation: randomUUID() },
      }, WRITE_OPTIONS);
    } catch {
      try { this.logger?.warn?.({ code: "device_credential_uncertain" }, "device_credential_gate_retained"); }
      catch { /* Diagnostics cannot replace the write failure. */ }
    }
  }

  /** @template T @param {unknown} owner @param {string} kind
   * @param {()=>Promise<T>} work @returns {Promise<T>} */
  run(owner, kind, work) {
    if (this.stopped) return Promise.reject(failure("device_credential_writer_stopping"));
    if (!KINDS.has(kind)) return Promise.reject(failure("device_credential_kind_invalid"));
    if (this.pending.size >= ACTIVE_LIMIT) return Promise.reject(failure("device_credential_writer_busy"));
    const task = this.#perform(owner, kind, work);
    this.pending.add(task);
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task));
    return task;
  }

  /** @template T @param {unknown} owner @param {string} kind
   * @param {()=>Promise<T>} work @returns {Promise<T>} */
  async #perform(owner, kind, work) {
    const operation = await this.begin(owner, kind);
    let result;
    try { result = await work(); }
    catch (error) { await this.uncertain(operation); throw error; }
    if (result && typeof result === "object" && /** @type {any} */ (result).acknowledged === false) {
      await this.uncertain(operation); throw failure("device_credential_write_unacknowledged");
    }
    await this.complete(operation);
    return result;
  }

  /** HTTP close does not prove the admitted credential commands stopped.
   * Stop new enrollment, then drain actual work before Mongo closes. */
  async stopAndDrain() {
    this.stopped = true;
    await Promise.allSettled([...this.pending]);
  }
}

/** @param {any} row */
function validIdentity(row) {
  return row._id === AUTHORITY_KEY && row.key === AUTHORITY_KEY
    && row.protocolVersion === PROTOCOL_VERSION && row.ownerHashNamespace === OWNER_NAMESPACE
    && validUuid(row.incarnation) && validUuid(row.generation);
}
/** @param {unknown} value */
function validUuid(value) { return typeof value === "string" && UUID.test(value); }
/** @param {any} row */
function validMode(row) {
  return ["prepared", "active"].includes(row.mode) && typeof row.grantsEverEnabled === "boolean"
    && (row.mode !== "active" || row.grantsEverEnabled) && typeof row.denyAll === "boolean";
}
/** @param {any} entry */
function validPending(entry) {
  return !!entry && validUuid(entry.operationId)
    && typeof entry.ownerHash === "string" && /^[\da-f]{64}$/.test(entry.ownerHash)
    && KINDS.has(entry.kind) && ["draining", "writing", "uncertain"].includes(entry.phase);
}
/** @param {any} row */
function validAuthority(row) {
  return !!row && validIdentity(row) && validMode(row)
    && !Object.hasOwn(row, "expiresAt") && !Object.hasOwn(row, "owner")
    && Array.isArray(row.pending) && row.pending.length <= PENDING_LIMIT
    && new Set(row.pending.map((/** @type {any} */ entry) => entry?.operationId)).size === row.pending.length
    && row.pending.every(validPending);
}

/** @param {string} code */
function failure(code) { return Object.assign(new Error(code), { status: 503, code }); }

/** One shared coordinator covers direct service instances and app/GDPR wiring.
 * @param {any} db @param {any} [logger] */
function deviceCredentialWritesFor(db, logger) {
  let service = instances.get(db);
  if (!service) {
    service = new DeviceCredentialWrites(db.db?.collection("jobLocks"), { logger });
    instances.set(db, service);
  }
  return service;
}

module.exports = { DeviceCredentialWrites, deviceCredentialWritesFor, AUTHORITY_KEY, OWNER_NAMESPACE,
  PROTOCOL_VERSION, PENDING_LIMIT, ACTIVE_LIMIT, WRITER_DRAIN_MS };
