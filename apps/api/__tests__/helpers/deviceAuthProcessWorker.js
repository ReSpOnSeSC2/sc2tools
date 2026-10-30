// @ts-nocheck
"use strict";

// Child process for deviceAuthSeparateProcess.mongo.test.js only: a real reader or writer with its own Mongo client and
// the actual pairing, credential-writer, readiness and REST reuse implementations. No serving app, provider, listener
// or native agent.
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const { MongoClient } = require("mongodb");
const { DevicePairingsService } = require("../../src/services/devicePairings");
const { deviceCredentialWritesFor } = require("../../src/services/deviceCredentialWrites");
const { credentialReadinessCapability } = require("../../src/services/deviceCredentialTopology");
const { DEVICE_AUTH_LEASE_MS } = require("../../src/services/deviceAuthLease");
const role = process.env.DEVICE_AUTH_PROCESS_ROLE;
const tickets = new Map(), acknowledgements = new Map(), running = new Set(), wire = [];
let client, pairings, writer, cache, stopping = false, shutdown;
const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()));

async function stop() {
  if (shutdown) return shutdown;
  stopping = true;
  for (const settle of acknowledgements.values()) settle(null);
  shutdown = (async () => {
    await Promise.allSettled([...running]);
    await cache?.stopAndDrain();
    await writer?.stopAndDrain();
    await client?.close();
  })();
  return shutdown;
}

async function stallAndConsume(message) {
  const saved = tickets.get(message.ticketId);
  assert.ok(saved && cache.tickets.has(saved.ticket));
  let settle;
  const acknowledged = new Promise(resolve => { settle = resolve; });
  acknowledgements.set(message.id, settle);
  const timeout = setTimeout(() => settle(null), 20000);
  const start = performance.now();
  try {
    await send({ event: "stall-entered", id: message.id, pid: process.pid });
    // A real OS-thread wait blocks this event loop, timers included. Both readings belong to this child.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, message.holdMs);
    const elapsedMs = performance.now() - start;
    const ack = await acknowledged;
    assert.ok(ack?.revoked && typeof ack.proof === "string", "The writer's revoke ACK must reach the reader before admission");
    const ticketStillStored = cache.tickets.has(saved.ticket);
    // Admission is synchronous after the ACK: no renewal, fresh prepare or fallback before consume.
    const consumed = cache.consume(saved.hash, saved.ticket);
    const secondConsume = cache.consume(saved.hash, saved.ticket);
    const sameCachedGeneration = cache.generation === saved.generation;
    const originalLookup = await pairings.findTokenByHash(saved.hash);
    return { elapsedMs, leaseMs: DEVICE_AUTH_LEASE_MS, ackProof: ack.proof,
      ticketStillStored, consumed, secondConsume, sameCachedGeneration, originalLookup, wire };
  } finally {
    clearTimeout(timeout); acknowledgements.delete(message.id); tickets.delete(message.ticketId);
  }
}

async function execute(message) {
  if (message.op === "prepare") {
    assert.equal(role, "reader");
    const ticket = await cache.prepare(message.hash);
    const probe = await cache.prepare(message.hash);
    const positive = cache.consume(message.hash, probe);
    assert.ok(ticket && positive, "A cold read and a warmed positive must succeed before holding a ticket");
    tickets.set(message.ticketId, { ticket, hash: message.hash, generation: cache.generation });
    return { positive, leaseMs: DEVICE_AUTH_LEASE_MS, ticketStored: cache.tickets.has(ticket) };
  }
  if (message.op === "revoke") {
    assert.equal(role, "writer");
    return { revoked: await pairings.revokeById(message.owner, message.deviceId) };
  }
  if (message.op === "stall-and-consume") return stallAndConsume(message);
  throw new Error("Unexpected fixture operation");
}

process.on("message", message => {
  if (message.op === "ack") { acknowledgements.get(message.forId)?.(message); return; }
  if (message.op === "stop") {
    void stop().then(() => send({ id: message.id, result: { stopped: true } }))
      .then(() => process.disconnect()).catch(async error => {
        process.exitCode = 1; await send({ id: message.id, error: error.message }).catch(() => {});
        if (process.connected) process.disconnect();
      });
    return;
  }
  if (stopping) { void send({ id: message.id, error: "Fixture is stopping" }); return; }
  const task = execute(message);
  running.add(task);
  void task.then(result => send({ id: message.id, result }), error => send({ id: message.id, error: error.message }))
    .catch(() => { process.exitCode = 1; }).finally(() => running.delete(task));
});
process.once("disconnect", () => { void stop().catch(() => { process.exitCode = 1; }); });

void (async () => {
  client = await MongoClient.connect(process.env.DEVICE_AUTH_PROCESS_URI, {
    monitorCommands: true, maxPoolSize: 2, serverSelectionTimeoutMS: 3000, connectTimeoutMS: 3000, socketTimeoutMS: 5000,
  });
  const database = client.db("device_auth_process_fixture"), hello = await database.command({ hello: 1 });
  const capability = credentialReadinessCapability(hello);
  assert.equal(capability, "causal");
  assert.equal(hello.isWritablePrimary, true);
  client.on("commandStarted", event => {
    if (event.commandName === "findAndModify") wire.push({ kind: "authority-write", majority: event.command.writeConcern?.w === "majority", journal: event.command.writeConcern?.j === true });
    if (event.commandName === "find" && event.command.find === "device_tokens") wire.push({ kind: "token-read", majority: event.command.readConcern?.level === "majority", causalFloor: !!event.command.readConcern?.afterClusterTime });
  });
  const db = { client, db: database, deviceCredentialReadiness: capability,
    deviceTokens: database.collection("device_tokens"), users: database.collection("users"), devicePairings: database.collection("device_pairings") };
  writer = deviceCredentialWritesFor(db);
  await writer.readiness.ensure();
  pairings = new DevicePairingsService(db);
  if (role === "reader") { cache = pairings.createRestAuthReuse(); assert.ok(cache); }
  await send({ event: "ready", pid: process.pid, capability, writablePrimary: hello.isWritablePrimary, role });
})().catch(async error => {
  process.exitCode = 1;
  await send({ event: "fatal", error: error.message }).catch(() => {});
  await stop().catch(() => {});
  if (process.connected) process.disconnect();
});
