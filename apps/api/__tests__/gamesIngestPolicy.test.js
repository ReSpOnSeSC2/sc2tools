// @ts-nocheck
"use strict";

/**
 * Unit: caller-dependent ingest policy (routes/gamesIngestPolicy.js).
 *
 * Provenance must come only from the verified credential source, and the
 * daily-cap bookkeeping must never turn an already-stored upload into an
 * error. Cap admission/billing through the full app is covered by
 * browserIngestQuota.test.js against a real MongoMemoryServer.
 */

const {
  isBrowserSession,
  stampIngestProvenance,
  admitBrowserBatch,
  recordBrowserBatch,
  recordIngestRejections,
} = require("../src/routes/gamesIngestPolicy");

const claimed = () => ({ gameId: "g1", ingestSource: "agent", engineVersion: "1.6.3" });

describe("stampIngestProvenance", () => {
  test("a Clerk session is browser provenance and keeps the engine version", () => {
    const game = claimed();
    stampIngestProvenance(game, { userId: "u1", source: "clerk" });
    expect(game).toEqual({ gameId: "g1", ingestSource: "browser", engineVersion: "1.6.3" });
  });

  test("a device token is agent provenance and drops any engine version", () => {
    const game = { gameId: "g1", ingestSource: "browser", engineVersion: "1.6.3" };
    stampIngestProvenance(game, { userId: "u1", source: "device" });
    expect(game).toEqual({ gameId: "g1", ingestSource: "agent" });
  });

  test.each([
    ["an unknown source", { userId: "u1", source: "overlay" }],
    ["a missing source", { userId: "u1" }],
    ["no auth at all", undefined],
  ])("%s gets neither field, whatever the payload claimed", (_label, auth) => {
    const game = claimed();
    stampIngestProvenance(game, auth);
    expect(game).toEqual({ gameId: "g1" });
  });
});

describe("browser cap bookkeeping", () => {
  const browserReq = (log) => ({ auth: { userId: "u1", source: "clerk" }, log });

  test("only a Clerk session with a user id counts as a browser session", () => {
    expect(isBrowserSession({ userId: "u1", source: "clerk" })).toBe(true);
    expect(isBrowserSession({ userId: "u1", source: "device" })).toBe(false);
    expect(isBrowserSession({ userId: "", source: "clerk" })).toBe(false);
    expect(isBrowserSession(undefined)).toBe(false);
  });

  test("device uploads are admitted without consulting the quota", async () => {
    const quota = { check: jest.fn(), record: jest.fn() };
    const req = { auth: { userId: "u1", source: "device" } };
    await expect(admitBrowserBatch(req, {}, quota, 50)).resolves.toEqual({ blocked: false });
    await recordBrowserBatch(req, quota, { blocked: false }, 50);
    expect(quota.check).not.toHaveBeenCalled();
    expect(quota.record).not.toHaveBeenCalled();
  });

  test("a failed counter write is logged without the error escaping", async () => {
    const quota = {
      check: jest.fn(),
      record: jest.fn(async () => { throw new Error("mongo_down"); }),
    };
    const warn = jest.fn();
    await expect(
      recordBrowserBatch(browserReq({ warn }), quota, { blocked: false, day: "2026-09-27" }, 3),
    ).resolves.toBeUndefined();
    expect(quota.record).toHaveBeenCalledWith("u1", 3, "2026-09-27");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toBe("browser_ingest_quota_record_failed");
  });

  test("nothing is billed when no game was accepted", async () => {
    const quota = { check: jest.fn(), record: jest.fn() };
    await recordBrowserBatch(browserReq(), quota, { blocked: false, day: "2026-09-27" }, 0);
    expect(quota.record).not.toHaveBeenCalled();
  });
});

describe("ingest rejection counters", () => {
  const deviceReq = (log) => ({ auth: { userId: "u1", source: "device" }, log });
  const rejected = [
    { gameId: "secret-game-id", errors: ["/opponent/displayName must be string"] },
    { gameId: "g2", retryable: true, errors: ["upsert_failed: r2 down"] },
  ];

  test("one call per batch with closed codes; retryable-only batches make none", async () => {
    const users = { recordIngestRejections: jest.fn(async () => {}) };
    await recordIngestRejections(deviceReq(), users, rejected);
    expect(users.recordIngestRejections).toHaveBeenCalledTimes(1);
    expect(users.recordIngestRejections).toHaveBeenCalledWith("u1", { validation_failed: 1 });
    await recordIngestRejections(deviceReq(), users, [rejected[1]]);
    await recordIngestRejections(deviceReq(), users, []);
    expect(users.recordIngestRejections).toHaveBeenCalledTimes(1);
  });

  test("older or narrow users services, browser imports and anonymous requests are a no-op", async () => {
    await expect(recordIngestRejections(deviceReq(), undefined, rejected)).resolves.toBeUndefined();
    await expect(recordIngestRejections(deviceReq(), { addPulseId: jest.fn() }, rejected)).resolves.toBeUndefined();
    const users = { recordIngestRejections: jest.fn() };
    await recordIngestRejections({}, users, rejected);
    await recordIngestRejections({ auth: { userId: "u1", source: "clerk" } }, users, rejected);
    expect(users.recordIngestRejections).not.toHaveBeenCalled();
  });

  test("a failed counter write is logged with codes and counts only, without escaping", async () => {
    const warn = jest.fn();
    const users = { recordIngestRejections: jest.fn(async () => { throw new Error("mongo_down"); }) };
    await expect(recordIngestRejections(deviceReq({ warn }), users, rejected)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toBe("ingest_rejection_stats_failed");
    expect(warn.mock.calls[0][0]).toMatchObject({ userId: "u1", counts: { validation_failed: 1 } });
    expect(JSON.stringify(warn.mock.calls[0][0].counts)).not.toMatch(/secret-game-id|displayName/);
  });
});
