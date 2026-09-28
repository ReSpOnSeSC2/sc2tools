// @ts-nocheck
"use strict";

/**
 * Integration: POST /v1/games/exists through the full app. The browser
 * importer asks which replays the server already holds before parsing, so
 * the answer must be scoped to the caller, include quarantined rows,
 * preserve input order, and refuse device tokens.
 */

const request = require("supertest");
const {
  startHarness,
  resetCollections,
  insertDeviceToken,
  userIdForClerk,
  sampleGame,
} = require("./helpers/browserIngestHarness");
const { GAMES_EXISTS_MAX_PER_WINDOW } = require("../src/routes/gamesExists");
const { LIMITS } = require("../src/config/constants");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "browser-token") return { sub: "clerk_user_browser" };
    if (token === "other-browser-token") return { sub: "clerk_user_other" };
    throw new Error("invalid");
  }),
}));

let harness;

const exists = (token, body) => request(harness.app)
  .post("/v1/games/exists")
  .set("authorization", `Bearer ${token}`)
  .send(body);
const ingest = (token, games) => request(harness.app)
  .post("/v1/games")
  .set("authorization", `Bearer ${token}`)
  .send({ games });

beforeAll(async () => {
  harness = await startHarness("sc2tools_test_games_exists");
});
afterAll(async () => {
  if (harness) await harness.stop();
});
beforeEach(async () => {
  await resetCollections(harness.db);
});

describe("POST /v1/games/exists - lookups", () => {
  test("returns only the caller's stored ids, in input order, deduped", async () => {
    const mine = [sampleGame(1), sampleGame(2), sampleGame(3)];
    expect((await ingest("browser-token", mine)).status).toBe(202);
    const theirs = sampleGame(4);
    expect((await ingest("other-browser-token", [theirs])).status).toBe(202);

    const missing = "2026-01-01T00:00:00|Nobody|Nowhere|1";
    const res = await exists("browser-token", {
      gameIds: [
        mine[2].gameId,
        missing,
        theirs.gameId,
        mine[0].gameId,
        mine[2].gameId,
      ],
    });
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({ existing: [mine[2].gameId, mine[0].gameId] });
  });

  test("answers from the unique {userId, gameId} index without reading documents", async () => {
    const mine = [sampleGame(1), sampleGame(2)];
    expect((await ingest("browser-token", mine)).status).toBe(202);
    const userId = await userIdForClerk(harness.db, "clerk_user_browser");
    const findSpy = jest.spyOn(harness.db.games, "find");
    try {
      const found = await harness.services.games.existingGameIds(
        userId,
        [mine[0].gameId, "missing"],
      );
      expect(found).toEqual([mine[0].gameId]);
      // Fire-and-forget session work from the ingest above may also read
      // ``games``; pick out the lookup's own ``$in`` query.
      const lookups = findSpy.mock.calls.filter(([f]) => f && f.gameId && f.gameId.$in);
      expect(lookups).toHaveLength(1);
      const [filter, options] = lookups[0];
      expect(filter).toEqual({ userId, gameId: { $in: [mine[0].gameId, "missing"] } });
      findSpy.mockRestore();
      // Re-run the service's exact query through the real planner.
      const plan = await harness.db.games.find(filter, options).explain("executionStats");
      expect(JSON.stringify(plan.queryPlanner)).toContain('"indexName":"userId_1_gameId_1"');
      expect(JSON.stringify(plan.queryPlanner)).not.toContain("COLLSCAN");
      // Covered: the projection needs nothing outside the index.
      expect(plan.executionStats.totalDocsExamined).toBe(0);
      expect(plan.executionStats.nReturned).toBe(1);
    } finally {
      findSpy.mockRestore();
    }
  });

  test("includes quarantined resume-from-replay rows", async () => {
    const resumed = sampleGame(5, { isResumedFromReplay: true });
    const upload = await ingest("browser-token", [resumed]);
    expect(upload.body.accepted[0]).toMatchObject({ quarantined: true });
    const res = await exists("browser-token", { gameIds: [resumed.gameId] });
    expect(res.status).toBe(200);
    expect(res.body.existing).toEqual([resumed.gameId]);
  });
});

describe("POST /v1/games/exists - validation, auth and limits", () => {
  test.each([
    ["an empty list", { gameIds: [] }],
    ["too many ids", { gameIds: Array.from({ length: LIMITS.GAMES_EXISTS_MAX_IDS + 1 }, (_, i) => `g${i}`) }],
    ["a non-string id", { gameIds: ["ok", 42] }],
    ["an empty-string id", { gameIds: [""] }],
    ["an over-long id", { gameIds: ["x".repeat(LIMITS.GAME_ID_MAX_LENGTH + 1)] }],
    ["a missing gameIds field", {}],
    ["an unexpected field", { gameIds: ["a"], includeDetails: true }],
    ["a non-array gameIds", { gameIds: "a" }],
  ])("400s on %s", async (_label, body) => {
    const res = await exists("browser-token", body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_request");
    expect(Array.isArray(res.body.error.details)).toBe(true);
    expect(res.body.error.details.length).toBeGreaterThan(0);
  });

  test("accepts exactly the maximum number of ids", async () => {
    const gameIds = Array.from({ length: LIMITS.GAMES_EXISTS_MAX_IDS }, (_, i) => `g${i}`);
    const res = await exists("browser-token", { gameIds });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ existing: [] });
  });

  test("refuses device tokens with 403 clerk_auth_required", async () => {
    await ingest("browser-token", [sampleGame(6)]);
    const userId = await userIdForClerk(harness.db, "clerk_user_browser");
    const deviceToken = await insertDeviceToken(harness.db, userId);
    const res = await exists(deviceToken, { gameIds: [sampleGame(6).gameId] });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("clerk_auth_required");
  });

  test("401s without credentials", async () => {
    const res = await request(harness.app)
      .post("/v1/games/exists")
      .send({ gameIds: ["a"] });
    expect(res.status).toBe(401);
    const bad = await exists("not-a-real-token", { gameIds: ["a"] });
    expect(bad.status).toBe(401);
  });

  test("rate limits each user to 60 lookups per minute", async () => {
    // Only this test calls exists as "other-browser-token", so its per-user
    // bucket starts empty; "browser-token" has used ~a dozen lookups.
    const body = { gameIds: ["a"] };
    for (let i = 0; i < GAMES_EXISTS_MAX_PER_WINDOW; i += 1) {
      const ok = await exists("other-browser-token", body);
      expect(ok.status).toBe(200);
    }
    const limited = await exists("other-browser-token", body);
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({
      error: { code: "rate_limited", message: "rate_limited" },
    });
    expect(limited.headers["cache-control"]).toBe("no-store");
    // Another user is unaffected.
    const other = await exists("browser-token", body);
    expect(other.status).toBe(200);
  });
});
