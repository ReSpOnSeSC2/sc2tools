// @ts-nocheck
"use strict";

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const request = require("supertest");
const { startFullApp, signIn, randomizerPrefs, setPrefs, addOverlayToken } = require("./helpers/buildIntentHarness");

const PHOENIX = "pvz-2-stargate-phoenix";
const ROBO = "pvz-robo-opener";

describe("native companion canonical randomizer", () => {
  let harness;
  let user;
  let key;
  let envelope;
  let counter = 0;

  beforeAll(async () => { harness = await startFullApp("native_randomizer"); });
  afterAll(async () => { if (harness) await harness.stop(); });
  beforeEach(async () => {
    user = await signIn(harness.app, harness.db, `native${++counter}`);
    key = `Opponent|Streamer|${Date.now() + counter}`;
    envelope = { phase: "match_started", gameKey: key, isReplay: false,
      user: { race: "Protoss", name: "Streamer" }, opponent: { race: "Zerg", name: "Opponent" } };
    await setPrefs(harness.db, user.userId, { randomizer: randomizerPrefs("PvZ", [PHOENIX, ROBO]) });
    harness.services.liveGameBroker.publish(user.userId, envelope);
    await harness.services.buildIntents.registerFromEnvelope(user.userId, envelope);
    harness.io.clear();
  });

  function roll(body = { matchup: "PvZ", releaseHold: false }, auth = user.device, gameKey = key) {
    return request(harness.app).post(`/v1/build-intents/live/${encodeURIComponent(gameKey)}/randomizer`)
      .set("authorization", auth).send(body);
  }

  test("draws and persists without an OBS token, and retries reuse the first pick", async () => {
    const first = await roll().expect(200);
    expect([PHOENIX, ROBO]).toContain(first.body.randomizer.key);
    const doc = await harness.db.buildIntentLive.findOne({ userId: user.userId, gameKey: key });
    expect(doc.randomizer).toMatchObject({ key: first.body.randomizer.key, native: true, verifiedPool: true });
    await setPrefs(harness.db, user.userId, { randomizer: randomizerPrefs("PvZ", [first.body.randomizer.key === PHOENIX ? ROBO : PHOENIX]) });
    const again = await roll().expect(200);
    expect(again.body.randomizer).toEqual(first.body.randomizer);
  });

  test("concurrent native requests share one saved draw", async () => {
    const replies = await Promise.all(Array.from({ length: 6 }, () => roll().expect(200)));
    expect(new Set(replies.map((reply) => reply.body.randomizer.key)).size).toBe(1);
    expect(harness.io.events("build-intent:changed")).toHaveLength(1);
  });

  test("loading holds wait for check-in; explicit Roll now releases the hold", async () => {
    harness.services.liveGameBroker.publish(user.userId, { ...envelope, phase: "match_loading" });
    const held = await roll().expect(409);
    expect(held.body.error.code).toBe("hold_active");
    const explicit = await roll({ matchup: "PvZ", releaseHold: true }).expect(200);
    expect(explicit.body.randomizer).toBeTruthy();
    expect(explicit.body.holdRemainingMs).toBe(0);
  });

  test("manual declarations remain authoritative", async () => {
    await harness.services.buildIntents.putLive(user.userId, key, { action: "declare", buildKey: PHOENIX }, { source: "device" });
    const result = await roll({ matchup: "PvZ", releaseHold: true }).expect(409);
    expect(result.body.error.code).toBe("build_declared");
    expect((await harness.db.buildIntentLive.findOne({ userId: user.userId, gameKey: key })).randomizer).toBeNull();
  });

  test("uses an existing OBS pick and suppresses duplicate OBS reveals after a native pick", async () => {
    await addOverlayToken(harness.db, user.userId, "native-obs-token", ["randomizer"]);
    await harness.services.buildIntents.handleRandomizerRoll(user.userId, "native-obs-token", { gameKey: key, buildId: ROBO });
    expect((await roll().expect(200)).body.randomizer.key).toBe(ROBO);
    const nextKey = `Next|Streamer|${Date.now() + 1000}`;
    harness.services.liveGameBroker.publish(user.userId, { ...envelope, gameKey: nextKey });
    const native = await roll({ matchup: "PvZ", releaseHold: false }, user.device, nextKey).expect(200);
    const opposite = native.body.randomizer.key === PHOENIX ? ROBO : PHOENIX;
    await harness.services.buildIntents.handleRandomizerRoll(user.userId, "native-obs-token", { gameKey: nextKey, buildId: opposite });
    expect((await harness.services.buildIntents.getLive(user.userId, nextKey)).randomizer.key).toBe(native.body.randomizer.key);
    expect(harness.io.events("overlay:buildIntent").some((event) => event.payload.gameKey === nextKey && event.payload.suppressRandomizer)).toBe(true);
    expect((await harness.services.buildIntents.overlayStateForCurrentGame(user.userId)).suppressRandomizer).toBe(true);
  });

  test.each([
    [{ phase: "menu" }, "PvZ", "stale_game"],
    [{ phase: "match_ended" }, "PvZ", "stale_game"],
    [{ isReplay: true }, "PvZ", "stale_game"],
    [{ receivedAt: Date.now() - 60000 }, "PvZ", "stale_game"],
    [{ opponent: { race: "Random", name: "Opponent" } }, "PvZ", "matchup_changed"],
    [{ players: [{}, {}, {}] }, "PvZ", "not_eligible"],
    [{ players: [{ type: "user" }, { type: "computer" }] }, "PvZ", "not_eligible"],
    [{}, "PvT", "matchup_changed"],
  ])("rejects obsolete or ineligible sources %#", async (change, matchup, code) => {
    harness.services.liveGameBroker.publish(user.userId, { ...envelope, ...change });
    expect((await roll({ matchup, releaseHold: true }).expect(409)).body.error.code).toBe(code);
  });

  test("rechecks the current match after asynchronous pool resolution", async () => {
    const service = harness.services.buildIntents;
    const original = service.options.resolveKey.bind(service.options);
    const spy = jest.spyOn(service.options, "resolveKey").mockImplementation(async (...args) => {
      const resolved = await original(...args);
      harness.services.liveGameBroker.publish(user.userId, { ...envelope, gameKey: `Different|Streamer|${Date.now() + 2000}` });
      return resolved;
    });
    try {
      expect((await roll().expect(409)).body.error.code).toBe("stale_game");
      expect((await harness.db.buildIntentLive.findOne({ userId: user.userId, gameKey: key })).randomizer).toBeNull();
    } finally { spy.mockRestore(); }
  });

  test("a switch turned off during pool resolution prevents the draw", async () => {
    const service = harness.services.buildIntents;
    const original = service.options.resolveKey.bind(service.options);
    const spy = jest.spyOn(service.options, "resolveKey").mockImplementation(async (...args) => {
      const resolved = await original(...args);
      await setPrefs(harness.db, user.userId, { randomizer: randomizerPrefs("PvZ", [PHOENIX], { enabled: false }) });
      return resolved;
    });
    try { expect((await roll().expect(409)).body.error.code).toBe("pool_changed"); }
    finally { spy.mockRestore(); }
  });

  test("a declaration committed during pool resolution wins over a pending native draw", async () => {
    const service = harness.services.buildIntents;
    const original = service.options.resolveKey.bind(service.options);
    const spy = jest.spyOn(service.options, "resolveKey").mockImplementation(async (...args) => {
      const resolved = await original(...args);
      await harness.db.buildIntentLive.updateOne({ userId: user.userId, gameKey: key }, {
        $set: { declared: { ...resolved, at: new Date(), via: "agent" } },
      });
      return resolved;
    });
    try {
      expect((await roll().expect(409)).body.error.code).toBe("build_declared");
      expect((await harness.db.buildIntentLive.findOne({ userId: user.userId, gameKey: key })).randomizer).toBeNull();
    } finally { spy.mockRestore(); }
  });

  test("enforces authentication, ownership and request shape", async () => {
    await roll({}, "Bearer invalid-device-token").expect(401);
    const other = await signIn(harness.app, harness.db, `other-native${counter}`);
    expect((await roll({ matchup: "PvZ", releaseHold: true }, other.device).expect(409)).body.error.code).toBe("stale_game");
    await roll({ matchup: "PvZ", releaseHold: true, buildId: PHOENIX }).expect(400);
    await roll({ matchup: "PvZ", releaseHold: "true" }).expect(400);
    await roll({ matchup: "PvZ", releaseHold: true }, user.device, "invalid-key").expect(400);
  });
});
