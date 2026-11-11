// @ts-nocheck
"use strict";

const request = require("supertest");
const { startFullApp, signIn, setPrefs, randomizerPrefs, addGame } = require("./helpers/buildIntentHarness");

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const PATH = "/v1/build-intents/randomizer-stats";
const RESET = new Date("2026-11-07T14:00:00Z");
const BUILD = "protoss-dt-rush";
const OTHER_BUILD = "pvz-robo-opener";
let app, db, services, stop, owner, stranger;
let sequence = 0;

beforeAll(async () => {
  ({ app, db, services, stop } = await startFullApp("randomizer_challenge_test"));
});
afterAll(async () => { await stop?.(); });

beforeEach(async () => {
  sequence += 1;
  owner = await signIn(app, db, "challenge_" + sequence, { enableCheckins: false });
  stranger = await signIn(app, db, "stranger_" + sequence, { enableCheckins: false });
  const pool = randomizerPrefs("PvZ", [BUILD, OTHER_BUILD]);
  await setPrefs(db, owner.userId, { randomizer: { ...pool, rollOnDesktop: true } });
  services.buildIntents.randomizerChallenge.now = () => RESET.getTime();
});

function roll(gameId, fields = {}, intent = {}, userId = owner.userId) {
  return addGame(db, userId, gameId, {
    date: new Date("2026-11-07T15:00:00Z"), startedAt: new Date("2026-11-07T14:58:00Z"), durationSec: 120,
    myRace: "Protoss", opponent: { race: "Zerg", displayName: "private opponent fixture" },
    result: "Victory", ...fields,
    buildIntent: {
      randomizer: { key: BUILD, name: "private pool label" },
      build: { key: BUILD }, status: "confirmed", applied: true, notes: "private note fixture", ...intent,
    },
  });
}

const read = (token) => request(app).get(PATH).set("Authorization", token);

test("summarizes only the owner's eligible rolls and applied matching check-ins", async () => {
  await Promise.all([
    roll("win"),
    roll("loss", { result: "Defeat" }, { randomizer: { key: OTHER_BUILD }, build: { key: OTHER_BUILD } }),
    roll("ignored-draw", { result: "Defeat" }, { status: "pending", applied: false }),
    roll("different-build", { result: "Defeat" }, { build: { key: OTHER_BUILD } }),
    roll("unapplied", { result: "Defeat" }, { applied: false }),
    roll("hidden", { excluded: true }),
    roll("deleted", { _deleted: true }),
    roll("resumed", { isResumedFromReplay: true }),
    roll("foreign", {}, {}, stranger.userId),
  ]);
  await request(app).get(PATH).expect(401);
  const reply = await read(owner.web).expect("Cache-Control", "private, no-store").expect(200);
  expect(reply.body).toEqual({ challengeStartedAt: null, pools: [{
    matchup: "PvZ", enabled: true, rolled: 5, playedAsRolled: 2, wins: 1, losses: 1,
    builds: 2, completed: 2, lastPlayed: "2026-11-07T15:00:00.000Z",
  }] });
  expect(reply.text).not.toMatch(/private|foreign|protoss-dt-rush/);
  expect((await read(stranger.web).expect(200)).body.pools[0].rolled).toBe(1);
  expect((await db.games.indexes()).find((index) => index.name === "randomizer_challenge_owner_date").key)
    .toEqual({ userId: 1, date: -1, "buildIntent.randomizer.key": 1 });
});

test("reset uses server time, retains games and excludes a game that started before the watermark", async () => {
  await Promise.all([
    roll("earlier", { date: new Date("2026-11-06T15:00:00Z"), startedAt: new Date("2026-11-06T14:58:00Z") }),
    roll("straddles-reset", { startedAt: new Date("2026-11-07T13:58:00Z") }),
    roll("current"),
  ]);
  const reset = request(app).post(PATH).set("Authorization", owner.web);
  await reset.send({ userId: stranger.userId, challengeStartedAt: "2099-01-01T00:00:00Z" })
    .expect("Cache-Control", "private, no-store").expect(200, { challengeStartedAt: RESET.toISOString() });
  const reply = await read(owner.web).expect(200);
  expect(reply.body).toMatchObject({ challengeStartedAt: RESET.toISOString(), pools: [{ rolled: 1, playedAsRolled: 1, builds: 2, completed: 1 }] });
  expect((await read(stranger.web).expect(200)).body.challengeStartedAt).toBeNull();
  expect(await db.games.countDocuments({ userId: owner.userId })).toBe(3);
  expect((await db.users.findOne({ userId: owner.userId })).preferences.randomizer.rollOnDesktop).toBe(true);
});

test("pool-only edits keep the current opt-in, and only paired native prefs receive its state", async () => {
  const prefsPath = "/v1/me/preferences/randomizer";
  const readCheckin = (token) => request(app).get("/v1/me/preferences/buildCheckin").set("Authorization", token);
  const putPool = (body) => request(app).put(prefsPath).set("Authorization", owner.web).send(body).expect(200);
  await putPool(randomizerPrefs("PvZ", [BUILD]));
  const native = await readCheckin(owner.device).expect(200);
  expect(native.body.rollOnDesktop).toBe(true);
  expect((await readCheckin(owner.web).expect(200)).body).not.toHaveProperty("rollOnDesktop");
  await putPool({ ...randomizerPrefs("PvZ", [BUILD]), rollOnDesktop: false });
  await putPool(randomizerPrefs("PvZ", [OTHER_BUILD]));
  expect((await readCheckin(owner.device).expect(200)).body).not.toHaveProperty("rollOnDesktop");
});
