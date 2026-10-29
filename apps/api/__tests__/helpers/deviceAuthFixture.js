"use strict";

const { randomUUID } = require("crypto");
const { Timestamp } = require("mongodb");
const { AUTHORITY_KEY, OWNER_NAMESPACE, PROTOCOL_VERSION } = require("../../src/services/deviceCredentialWrites");
const { DeviceAuthLease } = require("../../src/services/deviceAuthLease");
const { DeviceAuthReuse } = require("../../src/services/deviceAuthReuse");

function deferred() {
  /** @type {(value?:any)=>void} */ let resolve = () => {};
  /** @type {Promise<any>} */ const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

function activeAuthority() {
  return { _id: AUTHORITY_KEY, key: AUTHORITY_KEY, protocolVersion: PROTOCOL_VERSION,
    ownerHashNamespace: OWNER_NAMESPACE, incarnation: randomUUID(), generation: randomUUID(),
    mode: "active", grantsEverEnabled: true, denyAll: false, pending: [] };
}

/** @param {()=>boolean} predicate */
async function until(predicate) {
  for (let turn = 0; turn < 100; turn += 1) { if (predicate()) return; await Promise.resolve(); }
  throw new Error("Controlled test boundary was not reached");
}

/** Explicit Mongo transport/clock seam; the lease/cache themselves are real.
 * @param {any} [limits] */
function authFixture(limits) {
  /** @type {any} */ const state = { clock: { mono: 0, wall: 1000000 }, row: activeAuthority(), sessions: [] };
  state.client = { startSession: jest.fn(options => {
    /** @type {any} */ const session = { options, operationTime: undefined, endSession: jest.fn(async () => {}) };
    session.advanceOperationTime = jest.fn(value => { session.operationTime = value; });
    state.sessions.push(session); return session;
  }) };
  state.collection = { dbName: "device_auth_fixture", collectionName: "jobLocks" };
  state.command = jest.fn(async (command, options) => {
    options.session.operationTime = new Timestamp({ t: 20, i: 5 });
    return { ok: 1, lastErrorObject: { n: 1 }, value: { ...state.row,
      pending: state.row.pending.map((/** @type {any} */ entry) => ({ ...entry })), grantProbeNonce: command.update.$set.grantProbeNonce } };
  });
  state.client.db = jest.fn(() => ({ command: state.command }));
  state.lease = new DeviceAuthLease(state.collection, state.client, { now: () => state.clock.mono });
  state.snapshot = { hit: { userId: "owner-a", deviceId: "device-a" }, observedLastSeenAtMs: state.clock.wall };
  state.read = jest.fn(async () => ({ ...state.snapshot, hit: state.snapshot.hit && { ...state.snapshot.hit } }));
  state.cache = new DeviceAuthReuse(state.lease, state.read, { wallNow: () => state.clock.wall, limits });
  return state;
}

module.exports = { deferred, activeAuthority, until, authFixture };
