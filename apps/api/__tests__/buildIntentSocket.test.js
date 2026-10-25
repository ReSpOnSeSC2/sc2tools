// @ts-nocheck
/* eslint-disable max-lines-per-function */
"use strict";

/**
 * Build check-in realtime: ``overlay:buildIntent`` replay on overlay
 * connect / resync and the ``overlay:randomizer:rolled`` report, wired the
 * way server.js wires them (socket/auth.js options → BuildIntentsService).
 * Overlay rooms must never receive a build key or name.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { attachSocketAuth, ROLL_REPORTS_PER_WINDOW } = require("../src/socket/auth");
const { LiveGameBroker } = require("../src/services/liveGameBroker");
const { OverlayTokensService } = require("../src/services/overlayTokens");
const { BuildIntentsService } = require("../src/services/buildIntents");
const {
  DAY_MS,
  makeFakeIo,
  randomizerPrefs,
  setPrefs,
  addOverlayToken,
  addCustomBuild,
} = require("./helpers/buildIntentHarness");

const KEY_MS = 1_790_000_000_000;
const PHOENIX_KEY = "pvz-2-stargate-phoenix";
const PHOENIX = "PvZ - 2 Stargate Phoenix";
const ROBO_KEY = "pvz-robo-opener";
const OVERLAY_KEYS = ["gameKey", "holdRemainingMs", "suppressRandomizer"];

function setupIo() {
  let mw = null;
  let onConnect = null;
  return {
    use(fn) {
      mw = fn;
    },
    on(event, fn) {
      if (event === "connection") onConnect = fn;
    },
    async connect(handshake) {
      const socket = makeSocket(handshake);
      await new Promise((resolve, reject) => {
        mw(socket, (err) => (err ? reject(err) : resolve()));
      });
      onConnect(socket);
      return socket;
    },
  };
}

function makeSocket(handshake) {
  const handlers = new Map();
  return {
    handshake,
    data: {},
    connected: true,
    emitted: [],
    rooms: [],
    join(room) {
      this.rooms.push(room);
    },
    emit(event, payload) {
      this.emitted.push({ event, payload });
    },
    on(event, fn) {
      handlers.set(event, fn);
    },
    fire(event, ...args) {
      const fn = handlers.get(event);
      return fn ? fn(...args) : undefined;
    },
    disconnect() {
      this.connected = false;
    },
  };
}

async function flush() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Poll until ``predicate`` holds (real Mongo I/O sits in the chains). */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("build check-in realtime", () => {
  let mongo;
  let db;
  let roomIo;
  let broker;
  let service;
  let socketIo;
  let rolls;
  let userCounter = 0;
  /** Every overlay:buildIntent payload seen anywhere in this suite. */
  const overlayPayloads = [];

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "build_intent_socket_test" });
  });

  afterAll(async () => {
    for (const payload of overlayPayloads) {
      expect(Object.keys(payload).sort()).toEqual(OVERLAY_KEYS);
      const text = JSON.stringify(payload);
      expect(text).not.toMatch(/pvz-|custom:|Stargate|Robo|DT/);
    }
    expect(overlayPayloads.length).toBeGreaterThan(0);
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(() => {
    roomIo = makeFakeIo();
    broker = new LiveGameBroker();
    service = new BuildIntentsService(db, { io: roomIo, liveGameBroker: broker });
    rolls = [];
    const overlayTokens = new OverlayTokensService(db);
    socketIo = setupIo();
    attachSocketAuth(socketIo, {
      secretKey: "sk_test",
      resolveOverlayToken: (token) => overlayTokens.resolve(token),
      validateOverlayToken: (userId, token) => overlayTokens.tokenBelongsToUser(userId, token),
      resolveRandomizerPrefs: async () => ({ version: 2, matchups: {} }),
      resolveBuildIntent: (userId) => service.overlayStateForCurrentGame(userId),
      onRandomizerRolled: (userId, token, payload) => {
        const promise = service.handleRandomizerRoll(userId, token, payload);
        rolls.push(promise);
        return promise;
      },
    });
  });

  afterEach(() => {
    for (const e of roomIo.events("overlay:buildIntent")) overlayPayloads.push(e.payload);
  });

  async function settleRolls() {
    await flush();
    while (rolls.length > 0) await Promise.allSettled(rolls.splice(0));
  }

  /** A user in a PvZ loading screen with a randomizer-enabled overlay token. */
  async function liveUser({ register = true, phase = "match_loading" } = {}) {
    userCounter += 1;
    const userId = `sock-user-${userCounter}`;
    const token = `sock-tok-${userCounter}`;
    const gameKey = `Opp|Streamer|${KEY_MS + userCounter}`;
    await db.users.insertOne({ userId, clerkUserId: `clerk_sock_${userCounter}`, preferences: {} });
    await setPrefs(db, userId, {
      buildCheckin: { enabled: true, askAtLoading: true, askAfterGame: true },
      randomizer: randomizerPrefs("PvZ", [PHOENIX_KEY, ROBO_KEY, "custom:ghost", "custom:dt"]),
    });
    await addCustomBuild(db, userId, "dt", { name: "DT Rush" });
    await addOverlayToken(db, userId, token, ["opponent", "randomizer"]);
    const env = {
      phase,
      gameKey,
      displayTime: 0,
      user: { name: "Streamer", race: "Protoss" },
      opponent: { name: "Opp", race: "Zerg" },
    };
    broker.publish(userId, env);
    if (register) {
      await service.registerFromEnvelope(userId, { ...env, phase: "match_loading" });
      // The agent's loading card registers the game it asks about.
      await service.putLive(userId, gameKey, { action: "register" }, { source: "device" });
    }
    roomIo.clear();
    return { userId, token, gameKey };
  }

  async function overlaySocket(token) {
    const socket = await socketIo.connect({ auth: { overlayToken: token } });
    // overlay:config is the last emit of the connect chain.
    await waitFor(() => socket.emitted.some((e) => e.event === "overlay:config"));
    for (const e of socket.emitted) {
      if (e.event === "overlay:buildIntent") overlayPayloads.push(e.payload);
    }
    return socket;
  }

  function liveDoc(userId, gameKey) {
    return db.buildIntentLive.findOne({ userId, gameKey });
  }

  describe("replay on connect and resync", () => {
    test("sends the current game's state before overlay:config", async () => {
      const { userId, token, gameKey } = await liveUser();
      await service.putLive(userId, gameKey, { action: "declare", buildKey: PHOENIX_KEY }, { source: "device" });
      const socket = await overlaySocket(token);
      const events = socket.emitted.map((e) => e.event);
      const intentAt = events.indexOf("overlay:buildIntent");
      expect(intentAt).toBeGreaterThanOrEqual(0);
      expect(intentAt).toBeLessThan(events.indexOf("overlay:config"));
      expect(socket.emitted[intentAt].payload).toEqual({
        gameKey, suppressRandomizer: true, holdRemainingMs: 0,
      });
    });

    test("sends nothing when the current game has no live record", async () => {
      const { token } = await liveUser({ register: false });
      const socket = await overlaySocket(token);
      expect(socket.emitted.some((e) => e.event === "overlay:buildIntent")).toBe(false);
      expect(socket.emitted.some((e) => e.event === "overlay:config")).toBe(true);
    });

    test("resync replays the state", async () => {
      const { token, gameKey } = await liveUser();
      const socket = await overlaySocket(token);
      socket.emitted.length = 0;
      await socket.fire("overlay:resync");
      await waitFor(() => socket.emitted.some((e) => e.event === "overlay:buildIntent"));
      const replayed = socket.emitted.filter((e) => e.event === "overlay:buildIntent");
      // The randomizer can spin for this user, so the 6 s hold is running.
      expect(replayed.map((e) => e.payload)).toEqual([
        { gameKey, suppressRandomizer: false, holdRemainingMs: expect.any(Number) },
      ]);
      expect(replayed[0].payload.holdRemainingMs).toBeGreaterThan(0);
      expect(replayed[0].payload.holdRemainingMs).toBeLessThanOrEqual(6000);
      overlayPayloads.push(...replayed.map((e) => e.payload));
    });
  });

  describe("overlay:randomizer:rolled", () => {
    test("records the server's build for the current game and pings the user room", async () => {
      const { userId, token, gameKey } = await liveUser();
      const socket = await overlaySocket(token);
      socket.fire("overlay:randomizer:rolled", { gameKey, buildId: PHOENIX_KEY, name: "Client says otherwise" });
      await settleRolls();
      const doc = await liveDoc(userId, gameKey);
      expect(doc.randomizer).toEqual({
        key: PHOENIX_KEY,
        name: PHOENIX,
        slug: null,
        source: "catalog",
        at: expect.any(Date),
        verifiedPool: true,
      });
      expect(doc.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * DAY_MS);
      expect(roomIo.events("build-intent:changed")).toEqual([
        { room: `user:${userId}`, event: "build-intent:changed", payload: { gameKey } },
      ]);
      expect(roomIo.events("overlay:buildIntent")).toHaveLength(0);
      const state = await service.getLive(userId, gameKey);
      expect(state.randomizer).toEqual(expect.objectContaining({ key: PHOENIX_KEY, name: PHOENIX }));
    });

    test("a custom pool entry resolves to the user's build", async () => {
      const { userId, token, gameKey } = await liveUser();
      const socket = await overlaySocket(token);
      socket.fire("overlay:randomizer:rolled", { gameKey, buildId: "custom:dt" });
      await settleRolls();
      expect((await liveDoc(userId, gameKey)).randomizer).toEqual(expect.objectContaining({
        key: "custom:dt", name: "DT Rush", slug: "dt", source: "custom",
      }));
    });

    test.each([
      ["the token no longer shows the randomizer", async ({ userId, token }) => {
        await db.overlayTokens.updateOne({ userId, token }, { $set: { enabledWidgets: ["opponent"] } });
      }, (ctx) => ({ gameKey: ctx.gameKey, buildId: PHOENIX_KEY })],
      ["the token was revoked", async ({ userId, token }) => {
        await db.overlayTokens.updateOne({ userId, token }, { $set: { revokedAt: new Date() } });
      }, (ctx) => ({ gameKey: ctx.gameKey, buildId: PHOENIX_KEY })],
      ["the report is for another game", async () => {}, () => ({ gameKey: `Opp|Streamer|${KEY_MS - 1}`, buildId: PHOENIX_KEY })],
      ["the game has ended", async ({ userId, gameKey }) => {
        broker.publish(userId, { phase: "match_ended", gameKey });
      }, (ctx) => ({ gameKey: ctx.gameKey, buildId: PHOENIX_KEY })],
      ["the build is not in the pool", async () => {}, (ctx) => ({ gameKey: ctx.gameKey, buildId: "pvz-stargate-opener" })],
      ["the pool entry names no build", async () => {}, (ctx) => ({ gameKey: ctx.gameKey, buildId: "custom:ghost" })],
      ["the matchup's randomizer is off", async ({ userId }) => {
        await setPrefs(db, userId, { randomizer: randomizerPrefs("PvZ", [PHOENIX_KEY], { enabled: false }) });
      }, (ctx) => ({ gameKey: ctx.gameKey, buildId: PHOENIX_KEY })],
      ["the payload is malformed", async () => {}, () => "pvz-2-stargate-phoenix"],
      ["the build id is too long", async () => {}, (ctx) => ({ gameKey: ctx.gameKey, buildId: "x".repeat(201) })],
    ])("ignores a report when %s", async (_label, arrange, payload) => {
      const ctx = await liveUser();
      const socket = await overlaySocket(ctx.token);
      await arrange(ctx);
      socket.fire("overlay:randomizer:rolled", payload(ctx));
      await settleRolls();
      expect((await liveDoc(ctx.userId, ctx.gameKey)).randomizer).toBeNull();
      expect(roomIo.events("build-intent:changed")).toHaveLength(0);
    });

    test("the first accepted roll wins", async () => {
      const { userId, token, gameKey } = await liveUser();
      const socket = await overlaySocket(token);
      socket.fire("overlay:randomizer:rolled", { gameKey, buildId: PHOENIX_KEY });
      await settleRolls();
      socket.fire("overlay:randomizer:rolled", { gameKey, buildId: ROBO_KEY });
      await settleRolls();
      expect((await liveDoc(userId, gameKey)).randomizer.key).toBe(PHOENIX_KEY);
      expect(roomIo.events("build-intent:changed")).toHaveLength(1);
    });

    test("at most three reports per user and game reach the database", async () => {
      const { userId, token, gameKey } = await liveUser();
      const socket = await overlaySocket(token);
      for (let i = 0; i < 3; i += 1) {
        socket.fire("overlay:randomizer:rolled", { gameKey, buildId: "pvz-stargate-opener" });
      }
      await settleRolls();
      socket.fire("overlay:randomizer:rolled", { gameKey, buildId: PHOENIX_KEY });
      await settleRolls();
      expect((await liveDoc(userId, gameKey)).randomizer).toBeNull();
    });

    test("one socket forwards at most ten reports a minute", async () => {
      const { token, gameKey } = await liveUser();
      const socket = await overlaySocket(token);
      for (let i = 0; i < ROLL_REPORTS_PER_WINDOW + 5; i += 1) {
        socket.fire("overlay:randomizer:rolled", { gameKey, buildId: "nope" });
      }
      await flush();
      expect(rolls.length).toBe(ROLL_REPORTS_PER_WINDOW);
      await settleRolls();
    });

    test("a roll after a declaration re-tells the overlay whether to suppress", async () => {
      const { userId, token, gameKey } = await liveUser();
      await service.putLive(userId, gameKey, { action: "declare", buildKey: ROBO_KEY }, { source: "device" });
      const socket = await overlaySocket(token);
      roomIo.clear();
      socket.fire("overlay:randomizer:rolled", { gameKey, buildId: PHOENIX_KEY });
      await settleRolls();
      expect(roomIo.events("overlay:buildIntent")).toEqual([{
        room: `overlay:${token}`,
        event: "overlay:buildIntent",
        payload: { gameKey, suppressRandomizer: true, holdRemainingMs: 0 },
      }]);
      overlayPayloads.push(...roomIo.events("overlay:buildIntent").map((e) => e.payload));

      const second = await liveUser();
      await service.putLive(second.userId, second.gameKey, { action: "declare", buildKey: PHOENIX_KEY }, { source: "device" });
      const secondSocket = await overlaySocket(second.token);
      roomIo.clear();
      secondSocket.fire("overlay:randomizer:rolled", { gameKey: second.gameKey, buildId: PHOENIX_KEY });
      await settleRolls();
      expect(roomIo.events("overlay:buildIntent").map((e) => e.payload)).toEqual([
        { gameKey: second.gameKey, suppressRandomizer: false, holdRemainingMs: 0 },
      ]);
    });

    test("without a live record the matchup comes from the broker and the record is created", async () => {
      const { userId, token, gameKey } = await liveUser({ register: false, phase: "match_started" });
      const socket = await overlaySocket(token);
      socket.fire("overlay:randomizer:rolled", { gameKey, buildId: PHOENIX_KEY });
      await settleRolls();
      const doc = await liveDoc(userId, gameKey);
      expect(doc).toEqual(expect.objectContaining({
        matchup: "PvZ", oppName: "Opp", keyStartedAtMs: KEY_MS + userCounter, gameId: null,
      }));
      expect(doc.randomizer.key).toBe(PHOENIX_KEY);
    });
  });
});
