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
