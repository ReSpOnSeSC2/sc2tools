// @ts-nocheck
"use strict";

/**
 * Integration: in-browser (Clerk-session) replay ingest through the full
 * app. Provenance is derived from the verified credential, never from the
 * payload: a Clerk upload is stamped ``ingestSource: "browser"`` and keeps
 * its ``engineVersion``; a device-token upload is always ``"agent"`` with no
 * engine version, whatever the body claims.
 */

const request = require("supertest");
const {
  startHarness,
  resetCollections,
  insertDeviceToken,
  userIdForClerk,
  sampleGame,
} = require("./helpers/browserIngestHarness");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "browser-token") return { sub: "clerk_user_browser" };
    throw new Error("invalid");
  }),
}));

const WEB_ORIGIN = "https://sc2tools.app";

let harness;

const postAs = (token, body) => request(harness.app)
  .post("/v1/games")
  .set("authorization", `Bearer ${token}`)
  .send(body);

beforeAll(async () => {
  harness = await startHarness("sc2tools_test_browser_ingest", {
    corsAllowedOrigins: [WEB_ORIGIN],
  });
});
afterAll(async () => {
  if (harness) await harness.stop();
});
beforeEach(async () => {
  await resetCollections(harness.db);
});

describe("POST /v1/games - browser ingest provenance", () => {
  test("accepts a Clerk batch and stamps browser provenance on the slim row", async () => {
    const games = [
      sampleGame(1, { ingestSource: "agent", engineVersion: "1.6.3" }),
      sampleGame(2, { engineVersion: "1.6.3-rc.1+build.5" }),
    ];
    const res = await postAs("browser-token", { games });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      accepted: [
        { gameId: games[0].gameId, created: true },
        { gameId: games[1].gameId, created: true },
      ],
      rejected: [],
    });

    const userId = await userIdForClerk(harness.db, "clerk_user_browser");
    const row = await harness.db.games.findOne({ userId, gameId: games[0].gameId });
    // The payload claimed "agent"; the Clerk credential wins.
    expect(row.ingestSource).toBe("browser");
    expect(row.engineVersion).toBe("1.6.3");
    expect(row.buildLog).toBeUndefined();
    expect(row.opponent.pulseLookupAttempted).toBe(false);
    const second = await harness.db.games.findOne({ userId, gameId: games[1].gameId });
    expect(second.engineVersion).toBe("1.6.3-rc.1+build.5");

    const detail = await harness.db.gameDetails.findOne({ userId, gameId: games[0].gameId });
    expect(detail.buildLog).toEqual(["[0:12] Pylon"]);
    expect(detail.oppBuildLog).toEqual(["[0:17] SpawningPool"]);
    expect(detail.ingestSource).toBeUndefined();
  });

  test("device uploads are stamped agent and drop any claimed engine version", async () => {
    const first = await postAs("browser-token", { games: [sampleGame(1)] });
    expect(first.status).toBe(202);
    const userId = await userIdForClerk(harness.db, "clerk_user_browser");
    const deviceToken = await insertDeviceToken(harness.db, userId);

    const claimed = sampleGame(3, { ingestSource: "browser", engineVersion: "1.6.3" });
    const res = await postAs(deviceToken, { games: [claimed] });
    expect(res.status).toBe(202);
    expect(res.body.accepted).toEqual([{ gameId: claimed.gameId, created: true }]);

    const row = await harness.db.games.findOne({ userId, gameId: claimed.gameId });
    expect(row.ingestSource).toBe("agent");
    expect(row).not.toHaveProperty("engineVersion");
  });

  test("an agent re-upload of a browser game clears the stale engine version", async () => {
    const game = sampleGame(4, { engineVersion: "1.6.3" });
    await postAs("browser-token", { games: [game] });
    const userId = await userIdForClerk(harness.db, "clerk_user_browser");
    const deviceToken = await insertDeviceToken(harness.db, userId);

    const res = await postAs(deviceToken, { games: [sampleGame(4)] });
    expect(res.status).toBe(202);
    expect(res.body.accepted).toEqual([{ gameId: game.gameId, created: false }]);
    const row = await harness.db.games.findOne({ userId, gameId: game.gameId });
    expect(row.ingestSource).toBe("agent");
    expect(row).not.toHaveProperty("engineVersion");
    expect(await harness.db.games.countDocuments({ userId })).toBe(1);
  });
});

describe("POST /v1/games - provenance validation and CORS", () => {
  test("an invalid engine version rejects only that item, permanently", async () => {
    const good = sampleGame(5, { engineVersion: "1.6.3" });
    const bad = sampleGame(6, { engineVersion: "latest" });
    const tooLong = sampleGame(7, { engineVersion: `1.6.3-${"a".repeat(40)}` });
    const res = await postAs("browser-token", { games: [good, bad, tooLong] });
    expect(res.status).toBe(202);
    expect(res.body.accepted).toEqual([{ gameId: good.gameId, created: true }]);
    expect(res.body.rejected).toHaveLength(2);
    expect(res.body.rejected[0]).toMatchObject({ gameId: bad.gameId });
    expect(res.body.rejected[0].errors[0]).toMatch(/^\/engineVersion /);
    expect(res.body.rejected[0].retryable).toBeUndefined();
    expect(res.body.rejected[1]).toMatchObject({ gameId: tooLong.gameId });
    expect(res.body.rejected[1].retryable).toBeUndefined();
    const userId = await userIdForClerk(harness.db, "clerk_user_browser");
    expect(await harness.db.games.countDocuments({ userId })).toBe(1);
  });

  test("an unknown ingestSource value is rejected rather than silently rewritten", async () => {
    const res = await postAs("browser-token", {
      games: [sampleGame(8, { ingestSource: "desktop" })],
    });
    expect(res.status).toBe(202);
    expect(res.body.accepted).toEqual([]);
    expect(res.body.rejected[0].errors[0]).toMatch(/^\/ingestSource /);
  });

  test("the service re-bounds provenance for internal callers that skip validation", async () => {
    const { games } = harness.services;
    await games.upsertWithRevision("internal-user", sampleGame(10, {
      ingestSource: "desktop",
      engineVersion: "not-semver",
    }));
    const row = await harness.db.games.findOne({ userId: "internal-user" });
    expect(row).not.toHaveProperty("ingestSource");
    expect(row).not.toHaveProperty("engineVersion");

    await games.upsertWithRevision("internal-user", sampleGame(11, {
      ingestSource: "browser",
      engineVersion: "1.6.3",
    }));
    const found = await games.existingGameIds("internal-user", [
      sampleGame(11).gameId, "missing", sampleGame(10).gameId,
    ]);
    // Order is unspecified; the unknown id must be absent.
    expect([...found].sort()).toEqual([sampleGame(10).gameId, sampleGame(11).gameId].sort());
    expect(await games.existingGameIds("internal-user", [])).toEqual([]);
  });

  test("exposes Retry-After to an allowed cross-origin caller", async () => {
    const res = await request(harness.app)
      .post("/v1/games")
      .set("origin", WEB_ORIGIN)
      .set("authorization", "Bearer browser-token")
      .send({ games: [sampleGame(9)] });
    expect(res.status).toBe(202);
    expect(res.headers["access-control-allow-origin"]).toBe(WEB_ORIGIN);
    expect(res.headers["access-control-expose-headers"]).toBe("Retry-After");
  });
});
