"use strict";

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http"), net = require("net");
const { gunzipSync } = require("zlib");
const { createHash } = require("crypto");
const { isNativeError } = require("util").types;
const request = require("supertest"), pino = require("pino").default;
const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoInstance, MongoInstanceEvents } = require("mongodb-memory-server-core/lib/util/MongoInstance");
const { MongoClient, Collection, BSON, MongoNetworkError } = require("mongodb");
const { verifyToken } = require("@clerk/backend");
const previousDsn = process.env.SENTRY_DSN;
delete process.env.SENTRY_DSN;
const previousFetch = global.fetch;
let externalFetchCalls = 0;
const externalFetch = jest.fn(async () => {
  externalFetchCalls += 1; throw new Error("private_search_external_fetch_unexpected");
});
const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const searchQuery = require("../src/services/privateSearchQuery");
const { sha256 } = require("../src/util/hash");
const ENDPOINT = "/v1/search/quick", QUERY_SENTINEL = "PRIVATE_QUICK_QUERY_SENTINEL";
const DEVICE_A = "A".repeat(43), DEVICE_B = "B".repeat(43);
const INDEX = "b2_probe_owner_id_v1", DB_NAME = "private_quick_owned_integration";
const previousVersionCheck = process.env.MONGOMS_SYSTEM_BINARY_VERSION_CHECK;
/** @typedef {import('mongodb').Document} Document */
/** @typedef {import('child_process').ChildProcess} Child */
/** @typedef {{kind:string,child:Child,pid:number|undefined,exit:boolean,close:boolean,
 * code:number|null,signal:NodeJS.Signals|null,closed:Promise<void>,ownedPathMatches:boolean}} ProcessReceipt */
/** @typedef {{collection:Collection,pipeline:Document[],options:import('mongodb').AggregateOptions,
 * cursor:import('mongodb').AggregationCursor,closed:boolean}} ReadReceipt */
/** @type {MongoMemoryServer|undefined} */ let mongo;
/** @type {MongoInstance|undefined} */ let instance;
/** @type {Promise<void>|undefined} */ let startup;
/** @type {Promise<void>|undefined} */ let memoryStartup;
/** @type {MongoClient|undefined} */ let ownedClient;
/** @type {Awaited<ReturnType<typeof connect>>|undefined} */ let db;
/** @type {ReturnType<typeof buildApp>|undefined} */ let built;
/** @type {http.Server|undefined} */ let server;
/** @type {jest.SpyInstance|undefined} */ let aggregateObserver;
/** @type {ProcessReceipt[]} */ const processes = [];
/** @type {ReadReceipt[]} */ const reads = [];
/** @type {Document[]} */ const commands = [];
/** @type {unknown[]} */ const instanceErrors = [];
/** @type {string[]} */ const logs = [];
/** @type {Set<import('net').Socket>} */ const sockets = new Set();
/** @type {Record<string,unknown>} */ const cleanupReceipt = {};
/** @type {Document[]} */ const pointPlans = [];
const clientLife = { created: /** @type {string[]} */ ([]), closed: /** @type {string[]} */ ([]),
  poolsCreated: /** @type {string[]} */ ([]), poolsClosed: /** @type {string[]} */ ([]), topologyClosed: false };
let ownedDirectory = "", mongoPort = 0, httpClosed = false;
/** @type {unknown} */ let shutdownFailure;

/** @template T @param {Promise<T>} work @param {number} ms @param {string} label @returns {Promise<T>} */
async function within(work, ms, label) {
  /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer;
  /** @type {Promise<never>} */
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); });
  try { return await Promise.race([work, deadline]); }
  finally { clearTimeout(timer); }
}

/** Observe only original ChildProcess references returned by the installed instance.
 * @param {string} kind @param {Child} child */
function observeChild(kind, child) {
  const row = { kind, child, pid: child.pid, exit: false, close: false,
    code: /** @type {number|null} */ (null), signal: /** @type {NodeJS.Signals|null} */ (null),
    closed: Promise.resolve(), ownedPathMatches: kind !== "mongod" };
  row.closed = new Promise(resolve => child.once("close", (code, signal) => {
    row.close = true; row.code = code; row.signal = signal; resolve();
  }));
  child.once("exit", (code, signal) => { row.exit = true; row.code = code; row.signal = signal; });
  child.once("error", error => instanceErrors.push(error));
  // Never throw between original spawn and the installed start() assignment.
  if (kind === "mongod") {
    try { row.ownedPathMatches =
      path.resolve(child.spawnargs[child.spawnargs.indexOf("--dbpath") + 1]) === ownedDirectory; }
    catch { row.ownedPathMatches = false; }
  }
  processes.push(row);
}

/** Retain the real instance before original start() performs asynchronous I/O.
 * @param {MongoInstance} value */
function observeInstance(value) {
  if (instance === value) return;
  if (instance && instance !== value) throw new Error("unexpected_second_owned_mongo_instance");
  instance = value;
  value.on(MongoInstanceEvents.instanceError, error => instanceErrors.push(error));
  const mongod = value._launchMongod, killer = value._launchKiller;
  value._launchMongod = binary => {
    const child = mongod.call(value, binary); observeChild("mongod", child); return child;
  };
  value._launchKiller = (parent, childPid) => {
    const child = killer.call(value, parent, childPid); observeChild("killer", child); return child;
  };
}

/** @param {unknown} value @param {string} key @returns {unknown} */
function errorField(value, key) {
  if (!value || typeof value !== "object") return undefined;
  try {
    const field = Object.getOwnPropertyDescriptor(value, key);
    return field && Object.hasOwn(field, "value") ? field.value : undefined;
  } catch { return undefined; }
}

/** Synthetic diagnostics only; no original exception object is serialized.
 * @param {unknown} failure */
function failureMetadata(failure) {
  const code = errorField(failure, "code"), codeName = errorField(failure, "codeName");
  const value = errorField(failure, "message"), message = typeof value === "string" ? value : "";
  return { code: typeof code === "string" ? code.slice(0, 100)
    : typeof code === "number" && Number.isSafeInteger(code) ? code : null,
  codeName: typeof codeName === "string" ? codeName.slice(0, 100) : null,
  message: message.slice(0, 1000), messageTail: message.slice(-1000), messageLength: message.length };
}

/** Commands are synthetic test data only, bounded and never sent to a provider.
 * @param {MongoClient} client */
function observeClient(client) {
  client.on("connectionCreated", event => clientLife.created.push(`${event.address}#${event.connectionId}`));
  client.on("connectionClosed", event => clientLife.closed.push(`${event.address}#${event.connectionId}`));
  client.on("connectionPoolCreated", event => clientLife.poolsCreated.push(event.address));
  client.on("connectionPoolClosed", event => clientLife.poolsClosed.push(event.address));
  client.once("topologyClosed", () => { clientLife.topologyClosed = true; });
  client.on("commandStarted", event => {
    if (commands.length >= 4096) throw new Error("finite_command_receipt_exceeded");
    commands.push({ phase: "start", name: event.commandName, command: event.command,
      requestId: event.requestId, connectionId: event.connectionId, address: event.address,
      database: event.databaseName });
  });
  client.on("commandSucceeded", event => commands.push({ phase: "success", name: event.commandName,
    requestId: event.requestId, connectionId: event.connectionId, address: event.address }));
  client.on("commandFailed", event => {
    if (event.commandName === "shutdown") shutdownFailure = event.failure;
    commands.push({ phase: "failure", name: event.commandName, requestId: event.requestId,
      connectionId: event.connectionId, address: event.address,
      // Synthetic-only diagnostics retain the native missing-hint code for
      // an actual observed failure; application logs must remain redacted.
      ...failureMetadata(event.failure) });
  });
}

/** @returns {{db:NonNullable<typeof db>,built:NonNullable<typeof built>}} */
function context() {
  if (!db || !built) throw new Error("owned_fixture_not_ready");
  return { db, built };
}
function transport() { if (!server) throw new Error("owned_http_not_ready"); return request(server); }
/** @param {string} owner @param {string} [q] */
function search(owner, q = "St") { return transport().post(ENDPOINT).set("authorization", owner).send({ q }); }
const bearerA = "Bearer u:a", bearerB = "Bearer u:b";

/** @param {string} owner @param {number} index */
function rival(owner, index) {
  return { userId: owner, pulseId: `${owner}-pulse-${index}`,
    displayNameSample: `Star rival ${index}`, race: "Protoss",
    lastSeen: new Date(1_790_000_000_000 + index * 1000) };
}
/** @param {string} owner @param {number} index */
function plan(owner, index) {
  return { userId: owner, slug: `${owner}-build-${index}`, name: `Stalker plan ${index}`,
    race: "Protoss", vsRace: "Protoss", perspective: "you",
    updatedAt: new Date(1_790_000_000_000 + index * 1000) };
}

async function seed() {
  if (!db) throw new Error("owned_database_missing");
  await db.users.insertMany(["a", "b"].map(name => ({ userId: `u_${name}`,
    clerkUserId: `clerk_${name}`, createdAt: new Date(), lastSeenAt: new Date(), dataRev: 7,
    sessionPolicy: { mode: "fixed", reset: "unchanged" } })));
  await db.deviceTokens.insertMany([[DEVICE_A, "a"], [DEVICE_B, "b"]].map(([token, name]) => ({
    userId: `u_${name}`, tokenHash: sha256(token), revokedAt: null,
    // Fresh normal credential liveness avoids an unrelated preexisting auth touch.
    createdAt: new Date(), lastSeenAt: new Date(),
  })));
  const opponents = ["u_a", "u_b"].flatMap(id => Array.from({ length: 9 }, (_, index) => rival(id, index)));
  Object.assign(opponents[0], { privatePayload: "PRIVATE_SOURCE_ONLY".repeat(65536) });
  opponents.push({ ...rival("u_a", 10), displayNameSample: "PvP - Stalker alias is not a literal prefix" });
  await db.opponents.insertMany(opponents);
  const builds = ["u_a", "u_b"].flatMap(id => Array.from({ length: 9 }, (_, index) => plan(id, index)));
  await db.customBuilds.insertMany([...builds, { ...plan("u_a", 10), deletedAt: new Date() },
    { ...plan("u_a", 11), name: "PvP - Stalker alias is not a literal prefix" }]);
  await db.games.insertOne({ userId: "u_a", gameId: "map-source", map: "Star map", date: new Date() });
}

async function startFixture() {
  global.fetch = externalFetch;
  ownedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "sc2tools-private-quick-"));
  process.env.MONGOMS_SYSTEM_BINARY_VERSION_CHECK = "false";
  const originalStart = MongoInstance.prototype.start;
  const observer = jest.spyOn(MongoInstance.prototype, "start").mockImplementation(
    /** @this {MongoInstance} */ function () {
    observeInstance(this); startup = originalStart.call(this); void startup.catch(() => {}); return startup;
  });
  try {
    mongo = new MongoMemoryServer({ binary: { version: "7.0.14" }, instance: { ip: "127.0.0.1",
      dbPath: ownedDirectory, storageEngine: "wiredTiger", launchTimeout: 10000,
      args: ["--wiredTigerCacheSizeGB", "0.25"] }, spawn: { windowsHide: true } });
    memoryStartup = mongo.start(); void memoryStartup.catch(() => {}); await memoryStartup;
  } finally { observer.mockRestore(); }
  expect(processes).toHaveLength(2); expect(processes.every(row => row.ownedPathMatches)).toBe(true);
  mongoPort = Number(new URL(mongo.getUri()).port);
  expect(Number.isSafeInteger(mongoPort)).toBe(true); expect(mongoPort).toBeGreaterThan(0);
  const originalConnect = MongoClient.prototype.connect;
  const clientObserver = jest.spyOn(MongoClient.prototype, "connect").mockImplementation(
    /** @this {MongoClient} */ function () {
    if (ownedClient && ownedClient !== this) throw new Error("unexpected_second_owned_client");
    if (!ownedClient) { ownedClient = this; observeClient(this); }
    return originalConnect.call(this);
  });
  const logger = pino({ level: "info" }, { write: line => {
    if (logs.length >= 4096) throw new Error("finite_log_receipt_exceeded"); logs.push(line);
  } });
  try { db = await connect({ uri: mongo.getUri(), dbName: DB_NAME, awaitBackgroundIndexes: true },
    { logger, slowQueryMs: Number.MAX_SAFE_INTEGER }); }
  finally { clientObserver.mockRestore(); }
  expect((await db.db.admin().command({ buildInfo: 1 })).version).toBe("7.0.14");
  for (const collection of [db.opponents, db.games]) {
    await collection.createIndex({ userId: 1, _id: 1 }, {
      name: INDEX, unique: false, collation: { locale: "simple" } });
  }
  await seed();
  const config = /** @type {ReturnType<typeof import('../src/config/loader').loadConfig>} */
    (/** @type {unknown} */ ({
    nodeEnv: "test", port: 0, logLevel: "info", mongoUri: "", mongoDb: DB_NAME,
    clerkSecretKey: "fixture-key", serverPepper: Buffer.alloc(32, 7), corsAllowedOrigins: [],
    rateLimitPerMinute: 10000, agentReleaseAdminToken: "fixture-admin", pythonExe: null,
    pythonAnalyzerDir: path.join(ownedDirectory, "no-python"),
  }));
  built = buildApp({ db, logger, config });
}

async function startHttpAndObserveReads() {
  const { built } = context();
  server = http.createServer(built.app); server.once("close", () => { httpClosed = true; });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  /** @type {Promise<void>} */ const listening = new Promise((resolve, reject) => {
    server?.once("error", reject); server?.listen(0, "127.0.0.1", () => resolve());
  });
  await listening;
  const originalAggregate = Collection.prototype.aggregate;
  aggregateObserver = jest.spyOn(Collection.prototype, "aggregate").mockImplementation(
    /** @this {Collection} @param {Document[]} [pipeline] @param {import('mongodb').AggregateOptions} [options] */
    function (pipeline = [], options = {}) {
    const cursor = originalAggregate.call(this, pipeline, options);
    const row = { collection: this, pipeline, options: { ...options }, cursor, closed: false };
    cursor.once("close", () => { row.closed = true; }); reads.push(row); return cursor;
  });
}

/** @param {unknown} failure */
function expectedShutdownError(failure) {
  const closed = failure instanceof MongoNetworkError
    && new RegExp(`^connection \\d+ to 127\\.0\\.0\\.1:${mongoPort} closed$`).test(failure.message);
  const reset = isNativeError(failure) && failure.name === "Error"
    && "code" in failure && failure.code === "ECONNRESET" && failure.message === "read ECONNRESET";
  return closed || reset;
}

/** @param {unknown} failure */
function optionalShutdownFields(failure) {
  if ("syscall" in Object(failure)) expect(Reflect.get(Object(failure), "syscall")).toBe("read");
  if ("address" in Object(failure)) expect(Reflect.get(Object(failure), "address")).toBe("127.0.0.1");
  if ("port" in Object(failure)) expect(Reflect.get(Object(failure), "port")).toBe(mongoPort);
}

/** Bounded graceful shutdown from reviewed runner04: exact owned request/failure
 * identity and clean process exit, with no platform-specific broad error waiver. */
async function gracefulShutdown() {
  const { db } = context(), process = processes.find(row => row.kind === "mongod");
  if (!process || processes.filter(row => row.kind === "mongod").length !== 1) throw new Error("owned_mongod_missing");
  const offset = commands.length;
  /** @type {unknown} */ let failure;
  /** @type {Document|undefined} */ let reply;
  try { reply = await db.client.db(DB_NAME).admin().command({
    shutdown: 1, force: true, timeoutSecs: 1, maxTimeMS: 2000 },
    { timeoutMS: 2000 }); }
  catch (error) { failure = error; }
  await within(process.closed, 5000, "owned_mongod_clean_exit_timeout");
  const events = commands.slice(offset).filter(row => row.name === "shutdown");
  expect(events).toHaveLength(2);
  const [started, terminal] = events;
  expect(started).toMatchObject({ phase: "start", database: "admin", address: `127.0.0.1:${mongoPort}` });
  expect(started.command).toMatchObject({ shutdown: 1, force: true, timeoutSecs: 1 });
  expect(started.command.maxTimeMS).toBeGreaterThan(0); expect(started.command.maxTimeMS).toBeLessThanOrEqual(2000);
  expect(Number.isSafeInteger(started.requestId)).toBe(true);
  expect(clientLife.created).toContain(`${started.address}#${started.connectionId}`);
  expect(terminal).toMatchObject({ requestId: started.requestId, address: started.address,
    connectionId: started.connectionId, phase: failure ? "failure" : "success" });
  expect(process).toMatchObject({ exit: true, close: true, code: 0, signal: null });
  expect(instanceErrors).toHaveLength(0);
  if (failure) {
    expect(shutdownFailure).toBe(failure);
    expect(expectedShutdownError(failure)).toBe(true); optionalShutdownFields(failure);
  } else expect(reply?.ok).toBe(1);
  cleanupReceipt.gracefulOwnedShutdown = true;
}

async function closeHttp() {
  const closing = server?.listening ? new Promise((resolve, reject) => {
    server?.close(error => error ? reject(error) : resolve(undefined));
  }) : Promise.resolve();
  try { await within(closing, 5000, "owned_http_close_timeout"); }
  finally {
    const socketCloses = [...sockets].map(socket => new Promise(resolve => {
      socket.once("close", () => resolve(undefined)); socket.destroy();
    }));
    await within(Promise.all(socketCloses), 2000, "owned_http_socket_close_timeout");
    await within(closing, 2000, "owned_http_close_event_missing");
  }
  if (server) expect(httpClosed).toBe(true);
  expect(sockets.size).toBe(0);
}

async function probeClosedMongoPort() {
  if (!mongoPort) return;
  const result = await new Promise(resolve => {
    const socket = net.createConnection({ host: "127.0.0.1", port: mongoPort });
    let error = "", connected = false;
    socket.setTimeout(1000, () => socket.destroy(new Error("owned_port_probe_timeout")));
    socket.once("connect", () => { connected = true; socket.destroy(); });
    socket.once("error", value => { error = "code" in value ? String(value.code) : value.message; });
    socket.once("close", () => resolve({ error, connected }));
  });
  expect(result).toEqual({ error: "ECONNREFUSED", connected: false });
}

/** @param {unknown[]} failures @param {()=>Promise<unknown>|undefined} work */
async function cleanupStep(failures, work) {
  try { await work(); } catch (error) { failures.push(error); }
}

/** @param {unknown[]} failures */
function writeReceipt(failures) {
  if (!ownedDirectory) return;
  const value = { ...cleanupReceipt, ownedDatabase: DB_NAME, ownedDirectory, mongoPort,
    preservedData: true, cleanupDeletes: false, failures: failures.map(String), clientLife, pointPlans,
    process: processes.map(({ child: _child, closed: _closed, ...row }) => row),
    allNativeCursorsClosed: reads.every(row => row.closed), socketCount: sockets.size,
    actualCommands: commands, discoveryFixtureHashes: FROZEN_HASHES,
    actualReaders: reads.map(row => ({ collection: row.collection.collectionName,
      pipeline: row.pipeline, options: row.options, nativeCloseObserved: row.closed })) };
  const encoded = BSON.EJSON.stringify(value, undefined, 2, { relaxed: false });
  if (Buffer.byteLength(encoded) > 4 * 1024 * 1024) throw new Error("owned_test_receipt_cap_exceeded");
  fs.writeFileSync(path.join(ownedDirectory, "private-search-receipt.json"), encoded, { flag: "wx" });
}

async function stopFixture() {
  /** @type {unknown[]} */ const failures = [];
  await cleanupStep(failures, closeHttp);
  await cleanupStep(failures, () => built?.services.customBuilds.stopReclassifications());
  await cleanupStep(failures, async () => {
    if (built) expect(built.services.privateSearch.capacity.capacitySnapshot().active).toBe(0);
  });
  await cleanupStep(failures, () => db ? gracefulShutdown() : undefined);
  await cleanupStep(failures, () => ownedClient?.close());
  // Preserve startup failure as a failed Jest setup hook; then perform fresh
  // actual stop after settlement, including an instance MMS never returned.
  cleanupReceipt.startup = (await Promise.allSettled([startup, memoryStartup])).map(row =>
    row.status === "rejected" ? { status: row.status, reason: String(row.reason) } : { status: row.status });
  await cleanupStep(failures, () => mongo?.stop({ doCleanup: false, force: false }));
  await cleanupStep(failures, () => instance?.stop());
  for (const row of processes) {
    await cleanupStep(failures, () => within(row.closed, 2000, "owned_child_close_missing"));
  }
  await cleanupStep(failures, probeClosedMongoPort);
  aggregateObserver?.mockRestore();
  global.fetch = previousFetch;
  if (previousDsn === undefined) delete process.env.SENTRY_DSN; else process.env.SENTRY_DSN = previousDsn;
  if (previousVersionCheck === undefined) delete process.env.MONGOMS_SYSTEM_BINARY_VERSION_CHECK;
  else process.env.MONGOMS_SYSTEM_BINARY_VERSION_CHECK = previousVersionCheck;
  writeReceipt(failures);
  expect(processes.every(row => row.exit && row.close)).toBe(true);
  expect(processes.filter(row => row.kind === "mongod")).toHaveLength(1);
  expect(processes.filter(row => row.kind === "killer")).toHaveLength(1);
  expect(clientLife.created.slice().sort()).toEqual(clientLife.closed.slice().sort());
  expect(clientLife.poolsCreated.slice().sort()).toEqual(clientLife.poolsClosed.slice().sort());
  expect(clientLife.topologyClosed).toBe(true); expect(externalFetchCalls).toBe(0);
  expect(fs.existsSync(ownedDirectory)).toBe(true);
  expect(reads.every(row => row.closed)).toBe(true);
  if (failures.length) throw new AggregateError(failures, "owned_private_search_fixture_cleanup_failed");
}

beforeAll(async () => { await startFixture(); await startHttpAndObserveReads(); }, 120000);
afterAll(stopFixture, 60000);
beforeEach(async () => {
  const { db } = context();
  await db.pendingIdentityDeletions.deleteMany({});
  await db.users.updateMany({}, { $unset: { _gdprMutation: "" } });
  await db.deviceTokens.updateMany({}, { $set: { lastSeenAt: new Date() } });
});
afterEach(() => { expect(logs.join("")).not.toContain(QUERY_SENTINEL); });

test.each(["{bad-json", "x".repeat(70_000)])("rejected GET skips parsers, auth and service reads", async body => {
  const { built } = context(), offset = commands.length, verifyCalls = jest.mocked(verifyToken).mock.calls.length;
  const service = jest.spyOn(built.services.privateSearch, "quick");
  try {
    const response = await transport().get(`${ENDPOINT}?unknown=${QUERY_SENTINEL}`)
      .type("json").send(body).expect(405);
    expect(response.headers["cache-control"]).toBe("private, no-store"); expect(response.headers.allow).toBe("POST");
    expect(service).not.toHaveBeenCalled(); expect(jest.mocked(verifyToken).mock.calls).toHaveLength(verifyCalls);
    expect(commands.slice(offset).filter(row => ["find", "aggregate", "getMore"].includes(row.name))).toHaveLength(0);
  } finally { service.mockRestore(); }
});

/** @type {Array<[string|{q:string},number,string]>} */
const UNAUTH_CASES = [
  [{ q: "St" }, 401, "missing_token"], ["{bad-json", 400, "private_search_invalid_request"],
  [JSON.stringify({ q: QUERY_SENTINEL.repeat(100) }), 413, "private_search_body_too_large"],
];
test.each(UNAUTH_CASES)("unauthenticated input follows parser/auth ordering %#", async (body, status, code) => {
  const { built } = context(), service = jest.spyOn(built.services.privateSearch, "quick");
  try {
    const response = await transport().post(ENDPOINT).type("json").send(body).expect(Number(status));
    expect(response.body.error.code).toBe(code); expect(service).not.toHaveBeenCalled();
    expect(response.headers["cache-control"]).toBe("private, no-store");
  } finally { service.mockRestore(); }
});

test.each([bearerA, `Bearer ${DEVICE_A}`])("credential %# rejects unsupported media without reads", async auth => {
  const { built } = context(), service = jest.spyOn(built.services.privateSearch, "quick");
  try {
    await transport().post(ENDPOINT).set("authorization", auth).type("text").send(QUERY_SENTINEL).expect(415);
    expect(service).not.toHaveBeenCalled();
  } finally { service.mockRestore(); }
});

/** @param {ReadReceipt[]} actual @param {string} gamesCollection @param {string} id */
function assertReaders(actual, gamesCollection, id) {
  expect(actual).toHaveLength(8);
  expect(actual.some(row => row.collection.collectionName === gamesCollection)).toBe(false);
  expect(actual.filter(row => row.options.hint === "userId_1_pulseId_1")).toHaveLength(1);
  expect(actual.filter(row => row.options.hint === "userId_1_slug_1")).toHaveLength(1);
  for (const row of actual) {
    expect(row.closed).toBe(true); expect(row.options).toMatchObject({ raw: true, readPreference: "primary",
      maxTimeMS: 300, timeoutMS: 300, timeoutMode: "cursorLifetime", comment: "sc2tools-private-search-v2" });
    const match = row.pipeline[0].$match;
    if (match.pulseId?.$in) {
      expect(match.pulseId.$in).toHaveLength(9); expect(match.pulseId.$in).toContain(`${id}-pulse-0`);
    }
    if (match.slug?.$in) {
      expect(match.slug.$in).toHaveLength(9); expect(match.slug.$in).toContain(`${id}-build-0`);
    }
  }
}

/** @param {number} offset */
function assertReaderWire(offset) {
  const starts = commands.slice(offset).filter(row => row.phase === "start" && row.name === "aggregate");
  expect(starts).toHaveLength(8);
  for (const row of starts) {
    expect(row.command.comment).toBe("sc2tools-private-search-v2");
    expect(row.command.maxTimeMS).toBeGreaterThan(0); expect(row.command.maxTimeMS).toBeLessThanOrEqual(300);
    expect(row.command.allowDiskUse).toBe(false);
    expect(row).toMatchObject({ database: DB_NAME, address: `127.0.0.1:${mongoPort}` });
  }
}

test.each([bearerA, `Bearer ${DEVICE_A}`, bearerB, `Bearer ${DEVICE_B}`])(
  "actual Clerk/device search is owner-only, ordered, nine-validated and read-only %#", async auth => {
    const { db } = context(), id = [bearerA, `Bearer ${DEVICE_A}`].includes(auth) ? "u_a" : "u_b";
    const before = await db.users.findOne({ userId: id }), offset = commands.length, firstRead = reads.length;
    const response = await search(auth).set("If-None-Match", "*").expect(200);
    expect(response.headers.etag).toBeUndefined(); expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(Number(response.headers["content-length"])).toBe(Buffer.byteLength(response.text));
    expect(Buffer.byteLength(response.text)).toBeLessThanOrEqual(65536);
    expect(response.text).not.toContain("PRIVATE_SOURCE_ONLY");
    expect(response.body.version).toBe(2);
    for (const [group, key] of [["opponents", "pulseId"], ["customBuilds", "slug"]]) {
      const result = response.body.groups[group]; expect(result.status).toBe("ready");
      expect(result.hasMore).toBe(true); expect(result.items).toHaveLength(8);
      expect(result.items.map((/** @type {Document} */ row) => row[key])).toEqual(
        Array.from({ length: 8 }, (_, index) => `${id}-${group === "opponents" ? "pulse" : "build"}-${8 - index}`));
    }
    expect(response.body.groups.maps).toEqual({ status: "unavailable", reason: "deferred", items: [], hasMore: null });
    expect(await db.users.findOne({ userId: id })).toEqual(before);
    const writes = commands.slice(offset)
      .filter(row => ["update", "insert", "delete", "findAndModify"].includes(row.name));
    expect(writes).toHaveLength(0);
    assertReaders(reads.slice(firstRead), db.games.collectionName, id); assertReaderWire(offset);
  },
);

test.each([bearerA, `Bearer ${DEVICE_A}`])("current identity tombstone denies both credential paths %#", async auth => {
  const { db, built } = context();
  await db.pendingIdentityDeletions.insertOne({
    _id: built.services.identityDeletions.keyFor("clerk_a"), state: "purging" });
  const response = await search(auth).expect(401);
  expect(response.body.error.code).toBe("account_deleted"); expect(response.body.groups).toBeUndefined();
});

test.each([bearerA, `Bearer ${DEVICE_A}`])("any current GDPR mutation denies both credential paths %#", async auth => {
  const { db } = context(); await db.users.updateOne({ userId: "u_a" }, { $set: { _gdprMutation: null } });
  const response = await search(auth).expect(503);
  expect(response.body.error.code).toBe("gdpr_operation_busy"); expect(response.body.groups).toBeUndefined();
});

/** @param {unknown} value @returns {unknown} */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(([key, item]) => [key, stable(item)]));
  return value;
}

// Immutable proposal02 discovery vectors from retained A03 shape receipts.
// A03 overall FAILED at collStats; these fixed query vectors are not a claim
// that the failed run was accepted. No runtime cache-file dependency exists.
/** @type {Readonly<Record<string,string>>} */
const FROZEN_DISCOVERY = Object.freeze({
  opponents: [
    "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",
    "H4so8TyDWAAA",
  ].join(""),
  customBuilds: [
    "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",
  ].join(""),
  maps: [
    "H4sIAAAAAAAACu1b3W/bNhB/918hCH7MACUd1sVvQ1sDBZqlSLa9NJ5BS2eVK/VRUkqcBfrfB1KyrA9+SXa8NnVeYkh3x+Pd",
    "7453JPU0cRzXTwgBP8NJ7M4cN0QRMPeMv/iC44A/QmFIIUQZlI9hkwLFEcTZdUwe3ZmT0RzEG5bk1IfrhxjoFdrgKI/cmfM0",
    "cRzHcadxHq2Avo8zLvJn7/IXd+I4RYPvA45wpmF4vWOgwHKSaRkud9T3mOEV0cv/dUee4hQIjsGdOZ8EacnAWSKU+Z9rEeJZ",
    "zoC+F2ZaXcxYhAjhkvhfIf4LmU0ZLKE7LcSjJQ5aD3rKnW9FboUqhZPWHDV21MhIafIP+EN19Bo6njX4Eo6GvxCR8CMBr9LG",
    "278mRUkFX3tEMsKSOHtMud/caeWWHlFDt5qLZRTHYZd2MdHwWatZa3JmOQOCM6CIyADV0Eav60T2puUV5icp7OMVHI/xCmY3",
    "wPIIgjlNohtICXq0clF/IMdxI8wY91uf3HHcOCdE/maVJBKLLvbz/jhzLAMgkIEdTF+0DXASf4Q4kIThj2QL2PgkD74XPJiz",
    "DBAc8pV3ZI5pLME6wpIYr3/n05MxVASS3CMzhuNwO0leLGy8wmuh/aBz2FnXKeZHmWojk7z8KdcJ4/+YqjH+I5T2It9PnrHo",
    "4wMer+KTTkWtJcnkrldxlFwsox8gfvNRPT+JrmaxrdL9wvMUYseCp1S1/1wCSK3RO/QNmBl6LOi2LxS+5phCcPxO5LigVKFM",
    "riQK5AhWcfQwqSLSxod5DIPFhwix8YZVMBk9ZYoTyxFUsdOgUI+sGrU4TNpg+N9uMdcloRDCZo7j4Dexcumc4+I4zduBOhpJ",
    "Or0HI8pO2HBkWaHLGmEmlFmNZkaboHourAu0cPN9urvbPJ17nucVP5U/5/P5vFioBy6GQX3sUiZPnOb1s9izTkyyAXlcmPGq",
    "tzk5KNgswkwbzDahZQqqIeFkgLZFCKlhq5FtChhlqMhHU4zUDgzP4zFxvr6727xe85+Xa2lgFIdGYTgEhMaywIgw3bpiRJdp",
    "EbFFlj5hmVClXIBVUvV4UqBpYef8UdlseC4zbwQFKFPsNu+2u1sNZ/sIIeVdPSLDJOg7hDXyuz1CeQrVQVnbYO40pEne7WpL",
    "LYVqvGHpWr0S/CbJhYH7LnCnrHFS1n2nOgnqTlRiukoEju+55cS53AgFtEGraTEVK9iOonk2dIikadnuSmy4v9D9OmhbF97y",
    "Y5vjuVDWFqtdeDaybjABpRqpcWQ1bk0/QcwGYjfVRsm3gzI9ekzcQ3DaR5qRtj7iOHSdeZCYae96ncLm+TLzW3495hQy33/I",
    "7ErVU7g8X7hcVyX9KWReQMi0+7NT2OwfNsr+uuXKbm8qu7invL5n18UUI5pZfbM1qj0dKVLXLo0UaSiPR0rVVA9jralPsAap",
    "avzVvxeNHRqaPDDDvkn/5uz2DWxSldvVtb25ojfX8c28qnjfrp8VRLuKQUFgyI+Lw0S/0sL9axhbFgphThB9t0kpMFZeAJe2",
    "dinKMqDifvjft5l8nuUsOQ5cbLFLNW6Shu03yeautejeveyW5IMGkU6N/g1u6XDievu3ukaUiHOnXKJNKjniffR6k9fyun0/",
    "y426pz+pEmYjSqrPECK0+QNHcHXbEN0R+2p7vlhp4yJCkoe3mH35k/GprBFh4gOM6mMOVH3LUYsjiY/ELUyX4SjdlpFbaSue",
    "OG7bJ/vyiW05PuPy8epimdJkBWUuXuJgeS8oi0nxH7gQwutaMgAA",
  ].join(""),
});
/** @type {Readonly<Record<string,string>>} */
const FROZEN_HASHES = Object.freeze({
  opponents: "f1a09ebeaa8ab9a54bd97a7e57af3da1c52a5c48922b6348dc225829900aef1f",
  customBuilds: "a5ac632d74391f11f79440dd6d9ab0630eda1351ccdeee659bac5067d2ea0c0b",
  maps: "60bb55c0f74b0781ba0c958313f4795f613fa4f6dbe220eb9a356ec0f3c1e4fc",
});

test("shipping discovery pipelines equal the frozen proposal vectors without cache runtime imports", () => {
  /** @type {Array<'opponents'|'customBuilds'|'maps'>} */ const groups = ["opponents", "customBuilds", "maps"];
  for (const group of groups) {
    const bytes = gunzipSync(Buffer.from(FROZEN_DISCOVERY[group], "base64"));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(FROZEN_HASHES[group]);
    const frozen = JSON.parse(bytes.toString("utf8"));
    const actual = searchQuery[group]("b2:small", "St");
    expect(stable(BSON.EJSON.serialize({ pipeline: actual.pipeline, options: actual.options }, { relaxed: false })))
      .toEqual(stable({ pipeline: frozen.pipeline, options: frozen.options }));
  }
});

/** @param {unknown} value @returns {Document[]} */
function nodes(value) {
  if (!value || typeof value !== "object") return [];
  return [/** @type {Document} */ (value), ...Object.values(value).flatMap(nodes)];
}

/** @param {ReadReceipt} row @param {number} maxDocs @param {number} maxKeys */
async function pointPlan(row, maxDocs, maxKeys) {
  const cursor = row.collection.aggregate(row.pipeline, { hint: row.options.hint,
    maxTimeMS: 300, allowDiskUse: false, readPreference: "primary", collation: { locale: "simple" } });
  try {
    const offset = commands.length;
    const explained = await cursor.explain({ verbosity: "executionStats", maxTimeMS: 300 });
    const wire = commands.slice(offset).filter(value => value.phase === "start" && value.name === "explain");
    expect(wire).toHaveLength(1); expect(wire[0].command.maxTimeMS).toBe(300);
    expect(wire[0].command.explain).toMatchObject({ hint: row.options.hint, maxTimeMS: 300, allowDiskUse: false });
    expect(wire[0]).toMatchObject({ database: DB_NAME, address: `127.0.0.1:${mongoPort}` });
    const stages = explained.stages.filter((/** @type {Document} */ stage) => stage.$cursor);
    expect(stages).toHaveLength(1);
    const source = stages[0].$cursor, stats = source.executionStats;
    pointPlans.push({ hint: row.options.hint, maximumDocs: maxDocs, maximumKeys: maxKeys, explained });
    expect(stats.executionSuccess).toBe(true);
    expect(Number.isSafeInteger(stats.totalDocsExamined)).toBe(true);
    expect(stats.totalDocsExamined).toBeGreaterThanOrEqual(0);
    expect(Number.isSafeInteger(stats.totalKeysExamined)).toBe(true);
    expect(stats.totalKeysExamined).toBeGreaterThanOrEqual(0);
    expect(stats.totalDocsExamined).toBeLessThanOrEqual(maxDocs);
    expect(stats.totalKeysExamined).toBeLessThanOrEqual(maxKeys);
    const winning = source.queryPlanner.winningPlan.queryPlan || source.queryPlanner.winningPlan;
    expect(nodes(winning).map(value => value.stage)).not.toContain("COLLSCAN");
    const indexStages = nodes(winning).filter(value => value.stage === "IXSCAN");
    const idFastPath = nodes(winning).some(value => ["IDHACK", "EXPRESS_IXSCAN"].includes(value.stage));
    if (row.options.hint === "_id_" && idFastPath) {
      expect(stats.totalDocsExamined).toBeLessThanOrEqual(1); expect(stats.totalKeysExamined).toBeLessThanOrEqual(1);
    } else expect(indexStages.map(value => value.indexName)).toContain(row.options.hint);
  } finally { await cursor.close(); }
}

test("actual identity and selected-nine publication plans use bounded fixed point indices", async () => {
  const offset = reads.length; await search(bearerA).expect(200);
  const selected = reads.slice(offset).filter(row => ["userId_1", "_id_", "userId_1_pulseId_1", "userId_1_slug_1"]
    .includes(String(row.options.hint)));
  expect(selected).toHaveLength(6);
  for (const row of selected) {
    const publication = String(row.options.hint).includes("pulseId") || String(row.options.hint).includes("slug");
    await pointPlan(row, publication ? 10 : 2, publication ? 32 : 2);
  }
});

test("an absent named owner index fails only opponents closed without a fallback scan", async () => {
  const { db } = context();
  // Only this new owned fixture's index is removed, then restored in finally.
  await db.opponents.dropIndex(INDEX);
  try {
    const response = await search(bearerA).expect(200);
    expect(response.body.groups.opponents).toEqual({ status: "unavailable",
      reason: "missing_access_path", items: [], hasMore: null });
    expect(response.body.groups.customBuilds.status).toBe("ready");
  } finally {
    await db.opponents.createIndex({ userId: 1, _id: 1 }, {
      name: INDEX, unique: false, collation: { locale: "simple" } });
  }
});
