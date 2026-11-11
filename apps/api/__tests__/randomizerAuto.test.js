// @ts-nocheck
"use strict";

const request = require("supertest");
const { startFullApp, signIn, setPrefs, randomizerPrefs, addOverlayToken } = require("./helpers/buildIntentHarness");

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const BUILD = "protoss-dt-rush";
const MATCHUP = "PvZ";
let app, db, io, services, stop, account, now;
let key;
let sequence = 0;

beforeAll(async () => {
  ({ app, db, io, services, stop } = await startFullApp("randomizer_auto_test"));
});
afterAll(async () => { await stop?.(); });

beforeEach(async () => {
  account = await signIn(app, db, "autopick_" + ++sequence, { enableCheckins: false });
  now = Date.now();
  key = "Example opponent|Example owner|" + now;
  services.buildIntents.live.now = () => now;
  await setPool(true);
  io.in = () => ({ fetchSockets: async () => [] });
  io.clear();
});

function envelope(fields = {}) {
  return {
    gameKey: key, phase: "match_loading", displayTime: 0, receivedAt: now,
    isReplay: false,
    players: [{ type: "user" }, { type: "user" }],
    user: { race: "Protoss" }, opponent: { race: "Zerg", name: "Example opponent" },
    ...fields,
  };
}

function setPool(rollOnDesktop) {
  return setPrefs(db, account.userId, { randomizer: { ...randomizerPrefs(MATCHUP, [BUILD]), rollOnDesktop } });
}

function liveRow() {
  return db.buildIntentLive.findOne({ userId: account.userId, gameKey: key });
}

async function deliver(env = envelope(), fromDevice = true) {
  const broker = services.liveGameBroker;
  expect(broker.publish(account.userId, env, fromDevice)).toBe(true);
  await services.buildIntents.registerFromEnvelope(account.userId, env, fromDevice);
}

function socket(token, descriptor, extra = {}) {
  return { data: { kind: "overlay", overlayUserId: account.userId, overlayToken: token,
    overlayPresence: descriptor, ...extra } };
}

test("the real live route admits only device authentication, not envelope hints", async () => {
  const spy = jest.spyOn(services.buildIntents, "registerFromEnvelope");
  try {
    const send = (auth) => request(app).post("/v1/agent/live").set("Authorization", auth)
      .send(envelope({ fromDevice: true, deviceSource: true }));
    await send(account.web).expect(200);
    await spy.mock.results[0].value;
    expect(spy).toHaveBeenLastCalledWith(account.userId, expect.any(Object), false);
    expect((await liveRow()).randomizer).toBeNull();
    await send(account.device).expect(200);
    await spy.mock.results[1].value;
    expect(spy).toHaveBeenLastCalledWith(account.userId, expect.any(Object), true);
    expect((await liveRow()).randomizer).toMatchObject({ key: BUILD, native: true, verifiedPool: true, widgetReveal: false });
    expect(io.events("build-intent:changed")).toHaveLength(1);
  } finally { spy.mockRestore(); }
});

test("requires a fresh explicit opt-in and proof of no authorized connected randomizer source", async () => {
  const token = "connected-widget";
  await addOverlayToken(db, account.userId, token, ["randomizer"]);
  const randomizer = { surface: "widget", widget: "randomizer" };
  io.in = () => ({ fetchSockets: async () => [socket(token, randomizer)] });
  await deliver();
  expect((await liveRow()).randomizer).toBeNull();
  now += 3000;
  await setPool(false);
  io.in = () => ({ fetchSockets: async () => [] });
  await deliver();
  expect((await liveRow()).randomizer).toBeNull();
  now += 3000;
  await setPool(true);
  io.in = () => ({ fetchSockets: async () => { throw new Error("fixture missing presence"); } });
  await deliver();
  expect((await liveRow()).randomizer).toBeNull();
  now += 3000;
  // An unrelated widget, a control dock and stale revoked authorization
  // can all remain connected without owning the randomizer reveal.
  await db.overlayTokens.updateOne({ token }, { $set: { revokedAt: new Date(now) } });
  const activeToken = "other-active-widget";
  await addOverlayToken(db, account.userId, activeToken, ["randomizer", "scouting"]);
  io.in = () => ({ fetchSockets: async () => [
    socket(token, randomizer), socket(activeToken, { surface: "widget", widget: "scouting" }),
    socket(activeToken, randomizer, { overlayControlOnly: true }),
  ] });
  await deliver();
  expect((await liveRow()).randomizer).toMatchObject({ key: BUILD, native: true });
});

test("rechecks the accepted device envelope after resolving a build", async () => {
  const options = services.buildIntents.options;
  const original = options.resolveKey.bind(options);
  const spy = jest.spyOn(options, "resolveKey").mockImplementationOnce(async (...args) => {
    const resolved = await original(...args);
    // A browser diagnostic became the latest envelope for this same key.
    services.liveGameBroker.publish(account.userId, envelope({ fromDevice: true }), false);
    return resolved;
  });
  try {
    await deliver();
    expect((await liveRow()).randomizer).toBeNull();
    expect(io.events("build-intent:changed")).toHaveLength(0);
  } finally { spy.mockRestore(); }
});

test("waits for the loading check-in and preserves a declaration or the first successful roll", async () => {
  await setPrefs(db, account.userId, { buildCheckin: { enabled: true, askAtLoading: true } });
  await deliver();
  expect((await liveRow()).randomizer).toBeNull();
  await services.buildIntents.putLive(account.userId, key, {
    action: "declare", buildKey: BUILD, myRace: "Protoss", oppRace: "Zerg",
  }, { source: "device" });
  now += 3000;
  await deliver(envelope({ phase: "match_started" }));
  expect((await liveRow()).randomizer).toBeNull();
  expect((await liveRow()).declared.key).toBe(BUILD);
  key = "New example opponent|Example owner|" + now;
  const current = envelope({ phase: "match_started" });
  await Promise.all([deliver(current), deliver(current)]);
  const winner = (await liveRow()).randomizer;
  expect(winner).toMatchObject({ key: BUILD, native: true });
  now += 3000;
  await deliver(envelope({ phase: "match_in_progress", displayTime: 10 }));
  expect((await liveRow()).randomizer).toEqual(winner);
});

test.each([
  { isReplay: true }, { synthetic: true }, { players: [{ type: "computer" }, { type: "user" }] },
  { players: [{ type: "user" }, { type: "user" }, { type: "user" }] },
  { phase: "match_in_progress", displayTime: 35 },
])("does not auto-roll ineligible telemetry %j", async (fields) => {
  await deliver(envelope(fields));
  expect((await liveRow())?.randomizer ?? null).toBeNull();
});
