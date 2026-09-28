// @ts-nocheck
"use strict";

/**
 * Per-user daily cap on browser (Clerk-session) ingest.
 *
 * Service: UTC-day counters in ``browser_ingest_daily`` with an injected
 * clock (rollover, TTL fields, indexes). Route: a batch that would exceed
 * the cap gets a non-retryable 429 with ``resetAt``; device-token uploads
 * are never capped or counted; accepted games accumulate across batches.
 */

const request = require("supertest");
const {
  startHarness,
  resetCollections,
  insertDeviceToken,
  userIdForClerk,
  sampleGame,
} = require("./helpers/browserIngestHarness");
const {
  BrowserIngestQuotaService,
  utcDayKey,
  nextUtcMidnight,
  RETENTION_DAYS,
} = require("../src/services/browserIngestQuota");
const { DEFAULTS } = require("../src/config/constants");
const { PURGE_ONLY_COLLECTIONS } = require("../src/services/gdpr");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "browser-token") return { sub: "clerk_user_browser" };
    throw new Error("invalid");
  }),
}));

const ROUTE_CAP = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

let harness;
let clock;

const makeQuota = (cap = 5) => new BrowserIngestQuotaService(
  harness.db.browserIngestDaily,
  { cap, now: () => clock },
);
const postAs = (token, games) => request(harness.app)
  .post("/v1/games")
  .set("authorization", `Bearer ${token}`)
  .send({ games });
const usedToday = async (userId) => {
  const row = await harness.db.browserIngestDaily.findOne({ userId, day: "2026-09-27" });
  return row ? row.count : 0;
};

beforeAll(async () => {
  harness = await startHarness("sc2tools_test_browser_ingest_quota", {
    browserIngestDailyCap: ROUTE_CAP,
  });
});
afterAll(async () => {
  if (harness) await harness.stop();
});
beforeEach(async () => {
  await resetCollections(harness.db);
  clock = new Date("2026-09-27T12:00:00.000Z");
  harness.services.browserIngestQuota.now = () => clock;
});

describe("BrowserIngestQuotaService counters", () => {
  test("counts recorded games against today's cap", async () => {
    const quota = makeQuota(5);
    expect(await quota.usage("u1")).toMatchObject({
      day: "2026-09-27", used: 0, limit: 5, remaining: 5,
    });
    await quota.record("u1", 3);
    await quota.record("u1", 2);
    await quota.record("u1", 0);
    await quota.record("u1", -4);
    await quota.record("u1", 1.5);
    expect(await quota.usage("u1")).toMatchObject({ used: 5, remaining: 0 });
    expect((await quota.check("u1", 0)).allowed).toBe(true);
    expect((await quota.check("u1", 1)).allowed).toBe(false);
    expect((await quota.check("u2", 5)).allowed).toBe(true);
    expect((await quota.check("u2", 6)).allowed).toBe(false);
  });

  test("rolls over at UTC midnight and bills the admitted day", async () => {
    const quota = makeQuota(5);
    clock = new Date("2026-09-27T23:59:59.000Z");
    const decision = await quota.check("u1", 4);
    expect(decision).toMatchObject({ day: "2026-09-27", allowed: true, retryAfterSec: 1 });
    expect(decision.resetAt.toISOString()).toBe("2026-09-28T00:00:00.000Z");

    // The batch finishes after midnight but is billed to the admitted day.
    clock = new Date("2026-09-28T00:00:01.000Z");
    await quota.record("u1", 4, decision.day);
    const today = await quota.usage("u1");
    expect(today).toMatchObject({ day: "2026-09-28", used: 0, remaining: 5 });
    expect(today.resetAt.toISOString()).toBe("2026-09-29T00:00:00.000Z");
    expect(today.retryAfterSec).toBe(24 * 60 * 60 - 1);

    await quota.record("u1", 2);
    const rows = await harness.db.browserIngestDaily
      .find({ userId: "u1" }, { projection: { _id: 0, day: 1, count: 1 } })
      .sort({ day: 1 })
      .toArray();
    expect(rows).toEqual([
      { day: "2026-09-27", count: 4 },
      { day: "2026-09-28", count: 2 },
    ]);
  });
});

describe("BrowserIngestQuotaService storage", () => {
  test("writes TTL-bounded counter rows backed by the declared indexes", async () => {
    const quota = makeQuota(5);
    await quota.record("u1", 2);
    await quota.record("u1", 1, "not-a-day");
    const row = await harness.db.browserIngestDaily.findOne({ userId: "u1" });
    expect(row).toMatchObject({ userId: "u1", day: "2026-09-27", count: 3, _schemaVersion: 1 });
    expect(row.updatedAt).toEqual(clock);
    expect(row.expiresAt.toISOString()).toBe(
      new Date(Date.parse("2026-09-27T00:00:00.000Z") + RETENTION_DAYS * DAY_MS).toISOString(),
    );

    const indexes = await harness.db.browserIngestDaily.indexes();
    const unique = indexes.find((ix) => ix.key.userId === 1 && ix.key.day === 1);
    const ttl = indexes.find((ix) => ix.key.expiresAt === 1);
    expect(unique && unique.unique).toBe(true);
    expect(ttl && ttl.expireAfterSeconds).toBe(0);
    // Account deletion purges the counters too.
    expect(PURGE_ONLY_COLLECTIONS).toContainEqual(["browserIngestDaily", "userId"]);
  });

  test("a corrupt negative counter never grants more than the cap", async () => {
    const quota = makeQuota(5);
    await harness.db.browserIngestDaily.insertOne({ userId: "u9", day: "2026-09-27", count: -100 });
    expect(await quota.usage("u9")).toMatchObject({ used: 0, remaining: 5 });
    expect((await quota.check("u9", 5)).allowed).toBe(true);
    expect((await quota.check("u9", 6)).allowed).toBe(false);
  });

  test("falls back to the default cap and exposes UTC helpers", () => {
    expect(new BrowserIngestQuotaService(harness.db.browserIngestDaily).cap)
      .toBe(DEFAULTS.BROWSER_INGEST_DAILY_CAP);
    expect(new BrowserIngestQuotaService(harness.db.browserIngestDaily, { cap: 0 }).cap)
      .toBe(DEFAULTS.BROWSER_INGEST_DAILY_CAP);
    expect(utcDayKey(new Date("2026-12-31T23:59:59.999Z"))).toBe("2026-12-31");
    expect(nextUtcMidnight(new Date("2026-12-31T23:59:59.999Z")).toISOString())
      .toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("POST /v1/games browser daily cap", () => {
  test("wires the configured cap into the app", () => {
    expect(harness.services.browserIngestQuota.cap).toBe(ROUTE_CAP);
  });

  test("accumulates accepted games across batches, then refuses with a non-retryable 429", async () => {
    const first = await postAs("browser-token", [sampleGame(1), { gameId: "invalid" }]);
    expect(first.status).toBe(202);
    expect(first.body.accepted).toHaveLength(1);
    const userId = await userIdForClerk(harness.db, "clerk_user_browser");
    // Only accepted games are billed.
    expect(await usedToday(userId)).toBe(1);

    const second = await postAs("browser-token", [sampleGame(2), sampleGame(3)]);
    expect(second.status).toBe(202);
    expect(await usedToday(userId)).toBe(3);

    const refused = await postAs("browser-token", [sampleGame(4)]);
    expect(refused.status).toBe(429);
    expect(refused.headers["cache-control"]).toBe("no-store");
    expect(refused.headers["retry-after"]).toBe(String(12 * 60 * 60));
    expect(refused.body).toEqual({
      error: {
        code: "browser_ingest_daily_cap",
        message: expect.stringContaining("3 games per day"),
        retryable: false,
        limit: ROUTE_CAP,
        remaining: 0,
        resetAt: "2026-09-28T00:00:00.000Z",
      },
    });
    expect(await harness.db.games.countDocuments({ userId })).toBe(3);
    expect(await usedToday(userId)).toBe(3);
  });

  test("refuses a batch that would cross the cap even when some would fit", async () => {
    expect((await postAs("browser-token", [sampleGame(1)])).status).toBe(202);
    const res = await postAs("browser-token", [sampleGame(2), sampleGame(3), sampleGame(4)]);
    expect(res.status).toBe(429);
    // The client learns a smaller batch would still fit today.
    expect(res.body.error).toMatchObject({ limit: ROUTE_CAP, remaining: ROUTE_CAP - 1 });
    const userId = await userIdForClerk(harness.db, "clerk_user_browser");
    expect(await harness.db.games.countDocuments({ userId })).toBe(1);
    expect(await usedToday(userId)).toBe(1);
    const smaller = await postAs("browser-token", [sampleGame(2), sampleGame(3)]);
    expect(smaller.status).toBe(202);
    expect(await usedToday(userId)).toBe(ROUTE_CAP);
  });

  test("device uploads are never capped or counted, and the 429 frees the ingest slot", async () => {
    await postAs("browser-token", [sampleGame(1), sampleGame(2), sampleGame(3)]);
    const userId = await userIdForClerk(harness.db, "clerk_user_browser");
    expect((await postAs("browser-token", [sampleGame(4)])).status).toBe(429);

    // replayIngestMaxActive is 1: this would 503 if the 429 leaked the slot.
    const deviceToken = await insertDeviceToken(harness.db, userId);
    const device = await postAs(deviceToken, [sampleGame(5), sampleGame(6)]);
    expect(device.status).toBe(202);
    expect(device.body.accepted).toHaveLength(2);
    expect(await usedToday(userId)).toBe(3);
    expect(await harness.db.games.countDocuments({ userId })).toBe(5);
  });

  test("the cap resets on the next UTC day", async () => {
    await postAs("browser-token", [sampleGame(1), sampleGame(2), sampleGame(3)]);
    expect((await postAs("browser-token", [sampleGame(4)])).status).toBe(429);
    clock = new Date("2026-09-28T00:00:05.000Z");
    const next = await postAs("browser-token", [sampleGame(4)]);
    expect(next.status).toBe(202);
    expect(next.body.accepted).toEqual([{ gameId: sampleGame(4).gameId, created: true }]);
  });
});
