// @ts-nocheck
"use strict";

// Separate-process revocation regression: real reader and writer Node processes, each with its own Mongo client and the
// actual pairing, credential-writer, readiness and REST reuse implementations. The reader blocks its event loop past
// the lease, the writer's real revoke ACK reaches it over IPC, and the held one-use ticket, a second consume and an
// independent original lookup must all fail. One replica-set member: this proves process separation and a real
// event-loop hold, not election, host suspension, multi-host clocks, cutover or activation.
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { MongoClient, ObjectId } = require("mongodb");
const path = require("node:path");
const { fork } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const { AUTHORITY_KEY } = require("../src/services/deviceCredentialWrites");
const { credentialReadinessCapability } = require("../src/services/deviceCredentialTopology");
const peers = [], observations = [];
let replica, client, database;

function peer(role, uri) {
  const pending = new Map(), events = new Map(), seen = new Map();
  const env = {};
  for (const name of ["PATH", "Path", "SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP", "LOCALAPPDATA", "USERPROFILE", "APPDATA", "ProgramData", "SystemDrive", "PATHEXT", "HOME"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  Object.assign(env, { NODE_ENV: "test", NODE_OPTIONS: "--max-old-space-size=256", DEVICE_AUTH_PROCESS_ROLE: role, DEVICE_AUTH_PROCESS_URI: uri });
  const child = fork(path.join(__dirname, "helpers", "deviceAuthProcessWorker.js"), [], { env, execArgv: [], windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const record = { role, pid: child.pid, spawnObserved: false, exitObserved: false, closeObserved: false, logs: [] };
  observations.push(record);
  let sequence = 0;
  const closed = new Promise(resolve => child.once("close", code => { record.closeObserved = true; record.closeCode = code; resolve(); }));
  child.once("spawn", () => { record.spawnObserved = true; });
  child.once("exit", (code, signal) => { record.exitObserved = true; record.exitCode = code; record.signal = signal; });
  const rejectPending = error => { for (const task of pending.values()) { clearTimeout(task.timer); task.reject(error); } pending.clear(); };
  child.once("error", error => { record.spawnError = error.message; rejectPending(error); });
  child.once("exit", () => { rejectPending(new Error("Fixture child exited before its pending response")); });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", bytes => { if (record.logs.join("").length < 65536) record.logs.push(String(bytes)); });
  child.on("message", message => {
    if (message.event) {
      seen.set(message.event, message); events.get(message.event)?.(message);
      if (message.event === "fatal") rejectPending(new Error(message.error));
      return;
    }
    const task = pending.get(message.id); if (!task) return;
    pending.delete(message.id); clearTimeout(task.timer);
    if (message.error) task.reject(new Error(message.error)); else task.resolve(message.result);
  });
  const call = (op, values = {}) => {
    const id = `${role}-${++sequence}`;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${op} IPC deadline exceeded`)); }, op === "stop" ? 15000 : 25000);
      pending.set(id, { resolve, reject, timer }); child.send({ id, op, ...values });
    });
    // Keep cleanup failures observable without an unhandled-rejection race.
    void promise.catch(() => {});
    return { id, promise };
  };
  const event = name => seen.has(name) ? Promise.resolve(seen.get(name)) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} event deadline exceeded`)), 12000);
    events.set(name, value => { clearTimeout(timer); resolve(value); });
  });
  const close = async () => {
    if (!record.closeObserved) await call("stop").promise;
    let timer;
    try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Child close deadline exceeded")), 12000); })]); }
    finally { clearTimeout(timer); }
    expect([record.spawnObserved, record.exitObserved, record.closeObserved]).toEqual([true, true, true]);
    expect([record.exitCode, record.closeCode, record.signal]).toEqual([0, 0, null]);
  };
  const value = { child, record, call, event, close }; peers.push(value); return value;
}

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: "7.0.14" }, replSet: { count: 1, storageEngine: "wiredTiger" } });
  expect(replica.servers).toHaveLength(1);
  client = await MongoClient.connect(replica.getUri(), { serverSelectionTimeoutMS: 3000 });
  database = client.db("device_auth_process_fixture");
  const hello = await database.command({ hello: 1 });
  expect(credentialReadinessCapability(hello)).toBe("causal");
  expect(hello.isWritablePrimary).toBe(true);
}, 60000);

afterAll(async () => {
  const outcomes = await Promise.allSettled(peers.map(value => value.close()));
  try { await client?.close(); } finally { await replica?.stop(); }
  process.stdout.write("[device-auth-process-observations] " + JSON.stringify(observations.map(({ logs: _logs, ...rest }) => rest)) + "\n");
  const failures = outcomes.filter(value => value.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map(value => value.reason), "A fixture child did not close cleanly");
}, 60000);

test("a separate writer's revoke ACK cannot admit a held reader ticket after the reader's blocked event loop outlives the lease", async () => {
  const reader = peer("reader", replica.getUri()), writer = peer("writer", replica.getUri());
  const [r, w] = await Promise.all([reader.event("ready"), writer.event("ready")]);
  expect(new Set([r.pid, w.pid, process.pid]).size).toBe(3);
  expect([r.capability, w.capability]).toEqual(["causal", "causal"]);
  const authority = database.collection("jobLocks"), prepared = await authority.findOne({ _id: AUTHORITY_KEY });
  expect(prepared.mode).toBe("prepared");
  // Test-only activation of this synthetic database's authority row. Serving stays uninjected; never a rollout step.
  const activated = await authority.updateOne({ _id: AUTHORITY_KEY, incarnation: prepared.incarnation, mode: "prepared" },
    { $set: { mode: "active" } }, { writeConcern: { w: "majority", j: true } });
  expect(activated.matchedCount).toBe(1);
  const owner = "separate-process-fixture-owner", id = new ObjectId(), hash = createHash("sha256").update(randomUUID()).digest("hex");
  await database.collection("device_tokens").insertOne({ _id: id, userId: owner, tokenHash: hash, revokedAt: null, lastSeenAt: new Date() },
    { writeConcern: { w: "majority", j: true } });
  const ticketId = randomUUID(), first = await reader.call("prepare", { hash, ticketId }).promise;
  expect(first.positive).toEqual({ userId: owner, deviceId: String(id) }); expect(first.ticketStored).toBe(true);
  const entered = reader.event("stall-entered"), held = reader.call("stall-and-consume", { ticketId, holdMs: 8000 });
  await entered;
  expect(await writer.call("revoke", { owner, deviceId: String(id) }).promise).toEqual({ revoked: true });
  const ackProof = randomUUID();
  reader.child.send({ op: "ack", forId: held.id, revoked: true, proof: ackProof });
  const result = await held.promise;
  expect(result.ackProof).toBe(ackProof);
  expect(result.elapsedMs).toBeGreaterThanOrEqual(8000);
  expect(result.elapsedMs).toBeGreaterThan(result.leaseMs);
  expect(result.ticketStillStored).toBe(true); expect(result.sameCachedGeneration).toBe(true);
  expect([result.consumed, result.secondConsume, result.originalLookup]).toEqual([null, null, null]);
  expect(result.wire.filter(row => row.kind === "token-read")).toEqual([
    { kind: "token-read", majority: true, causalFloor: true },
    { kind: "token-read", majority: false, causalFloor: false },
  ]);
  expect((await authority.findOne({ _id: AUTHORITY_KEY })).pending).toEqual([]);
}, 60000);
