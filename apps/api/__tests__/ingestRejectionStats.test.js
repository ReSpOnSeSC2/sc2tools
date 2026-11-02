// @ts-nocheck
"use strict";

/**
 * Ingest rejection counters (services/ingestRejections.js) through the full
 * app: one best-effort owner-row update per batch, closed codes only, no
 * retryable or deleted-game rejections, no upsert, and a 202 that never
 * changes because of the counter.
 */

const request = require("supertest");
const { startHarness, insertDeviceToken, userIdForClerk, sampleGame } = require("./helpers/browserIngestHarness");
const {
  REJECTION_WINDOW_MS, rejectionCode, rejectionCounts, ingestRejectionUpdate,
} = require("../src/services/ingestRejections");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "browser-token") return { sub: "clerk_user_browser" };
    throw new Error("invalid");
  }),
}));

let harness, userId, deviceToken;
const post = (games) => request(harness.app).post("/v1/games").set("authorization", `Bearer ${deviceToken}`).send({ games });
const invalid = (n) => sampleGame(n, { ingestSource: "desktop" });
const statsOf = async () => (await harness.db.users.findOne({ userId })).ingestStats;
const statsWrites = (spy) => spy.mock.calls.filter(([, update]) => JSON.stringify(update).includes("ingestStats"));

beforeAll(async () => {
  harness = await startHarness("sc2tools_test_ingest_rejections");
  await request(harness.app).get("/v1/me").set("authorization", "Bearer browser-token");
  userId = await userIdForClerk(harness.db, "clerk_user_browser");
  deviceToken = await insertDeviceToken(harness.db, userId);
});
afterAll(async () => { if (harness) await harness.stop(); });
beforeEach(async () => {
  jest.restoreAllMocks();
  await Promise.all([harness.db.games.deleteMany({}), harness.db.gameDetails.deleteMany({}), harness.db.opponents.deleteMany({})]);
  await harness.db.users.updateOne({ userId }, { $unset: { ingestStats: "" } });
});

describe("closed rejection codes", () => {
  test.each([
    [["/ingestSource must be equal to one of the allowed values"], "validation_failed"],
    [["body must be an object"], "validation_failed"],
    [["/opponent/playSignature contains duplicate or inconsistent replay evidence"], "validation_failed"],
    [["game_deleted"], "game_deleted"],
    [["quarantine_failed: boom"], "quarantine_failed"],
    [["upsert_failed: E11000 duplicate"], "upsert_failed"],
    [["custom_build_tag_retry_required"], "custom_build_tag_retry_required"],
    [["quarantine_repair_failed: down"], "quarantine_repair_failed"],
    [["$where: 1"], "validation_failed"],
    [[], "validation_failed"],
    [undefined, "validation_failed"],
  ])("errors %p map to %p", (errors, code) => {
    expect(rejectionCode({ errors })).toBe(code);
  });

  test("a batch counts only non-retryable rejections other than the owner's own deletions", () => {
    expect(rejectionCounts([
      { gameId: "a", errors: ["/x must be string"] }, { gameId: "b", errors: ["body must be an object"] },
      { gameId: "c", retryable: true, errors: ["upsert_failed: r2 down"] }, { gameId: "d", retryable: false, errors: ["game_deleted"] },
      { gameId: "e", retryable: true, errors: ["custom_build_tag_retry_required"] }, null,
    ])).toEqual({ validation_failed: 2 });
    expect(rejectionCounts([])).toEqual({});
  });

  test("the update writes only fixed paths for codes in the closed set", () => {
    const now = new Date("2026-11-01T12:00:00Z");
    expect(ingestRejectionUpdate({}, now)).toBeNull();
    expect(ingestRejectionUpdate({ $where: 1, "a.b": 2, game_deleted: 3, validation_failed: 0, upsert_failed: 1.5 }, now)).toBeNull();
    const [stage] = ingestRejectionUpdate({ validation_failed: 2, "x.y": 1 }, now);
    expect(Object.keys(stage.$set)).toEqual(["ingestStats.rejected", "ingestStats.rejectedSince", "ingestStats.lastRejectedAt"]);
    expect(JSON.stringify(stage)).not.toContain("x.y");
    expect(stage.$set["ingestStats.rejected"].$cond[2]).toEqual({ $literal: { validation_failed: 2 } });
  });
});

describe("POST /v1/games counts rejections on the owner row", () => {
  test("one update per batch counts its validation rejections and the 202 keeps its shape", async () => {
    const write = jest.spyOn(harness.db.users, "updateOne");
    const games = [sampleGame(1), invalid(2), invalid(3)];
    const res = await post(games);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: [{ gameId: games[0].gameId, created: true }], rejected: [
      { gameId: games[1].gameId, errors: [expect.stringMatching(/^\/ingestSource /)] },
      { gameId: games[2].gameId, errors: [expect.stringMatching(/^\/ingestSource /)] },
    ] });
    expect(statsWrites(write)).toHaveLength(1);
    const stats = await statsOf();
    expect(stats).toEqual({ rejected: { validation_failed: 2 }, rejectedSince: expect.any(Date), lastRejectedAt: expect.any(Date) });
    expect(stats.rejectedSince).toEqual(stats.lastRejectedAt);
  });

  test("a later batch adds inside the window; the first batch after it starts a new window", async () => {
    await post([invalid(4)]);
    const first = await statsOf();
    await post([invalid(5), invalid(6)]);
    const second = await statsOf();
    expect(second.rejected).toEqual({ validation_failed: 3 });
    expect(second.rejectedSince).toEqual(first.rejectedSince);
    expect(second.lastRejectedAt.getTime()).toBeGreaterThanOrEqual(first.lastRejectedAt.getTime());
    const expired = new Date(Date.now() - REJECTION_WINDOW_MS - 60_000);
    await harness.db.users.updateOne({ userId }, { $set: { "ingestStats.rejectedSince": expired, "ingestStats.rejected.quarantine_failed": 4 } });
    await post([invalid(7)]);
    const third = await statsOf();
    expect(third.rejected).toEqual({ validation_failed: 1 });
    expect(third.rejectedSince.getTime()).toBeGreaterThan(expired.getTime());
  });
});

describe("POST /v1/games leaves the owner row alone when nothing counts", () => {
  test("retryable storage failures and deleted games are not counted", async () => {
    const counter = jest.spyOn(harness.services.users, "recordIngestRejections");
    jest.spyOn(harness.services.games, "upsertWithRevision")
      .mockRejectedValueOnce(new Error("detail store down"))
      .mockRejectedValueOnce(Object.assign(new Error("deleted"), { code: "game_deleted" }));
    const res = await post([sampleGame(8), sampleGame(9)]);
    expect(res.status).toBe(202);
    expect(res.body.rejected).toEqual([
      { gameId: sampleGame(8).gameId, retryable: true, errors: ["upsert_failed: detail store down"] },
      { gameId: sampleGame(9).gameId, retryable: false, errors: ["game_deleted"] },
    ]);
    expect(counter).not.toHaveBeenCalled();
    expect(await statsOf()).toBeUndefined();
  });

  test("browser imports are not counted: their own import UI reports each failure", async () => {
    const res = await request(harness.app).post("/v1/games").set("authorization", "Bearer browser-token").send({ games: [invalid(11)] });
    expect(res.status).toBe(202);
    expect(res.body.rejected).toHaveLength(1);
    expect(await statsOf()).toBeUndefined();
  });

  test("a counter failure never changes the 202", async () => {
    jest.spyOn(harness.services.users, "recordIngestRejections").mockRejectedValueOnce(new Error("users write refused"));
    const res = await post([invalid(10)]);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: [], rejected: [{ gameId: invalid(10).gameId, errors: [expect.stringMatching(/^\/ingestSource /)] }] });
    expect(await statsOf()).toBeUndefined();
  });

  test("a missing owner is a no-op that never creates a users row", async () => {
    await harness.services.users.recordIngestRejections("ghost-owner", { validation_failed: 2 });
    expect(await harness.db.users.countDocuments({ userId: "ghost-owner" })).toBe(0);
    await harness.services.users.recordIngestRejections(userId, { $where: 1, "a.b": 1, game_deleted: 2 });
    expect(await statsOf()).toBeUndefined();
  });
});
