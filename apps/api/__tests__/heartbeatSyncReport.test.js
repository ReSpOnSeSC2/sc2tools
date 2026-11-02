// @ts-nocheck
"use strict";

/**
 * Integration: POST /v1/devices/heartbeat with the item-76 `sync` report
 * through the full app. The report is sanitized, stored on the owner's own
 * device row and listed only to that owner; an oversize or malformed block is
 * dropped while the heartbeat still answers 200 and advances lastSeenAt; an
 * older agent's body keeps the original write and response.
 */

const request = require("supertest");
const { startHarness, insertDeviceToken, userIdForClerk } = require("./helpers/browserIngestHarness");
const { sha256 } = require("../src/util/hash");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "browser-token") return { sub: "clerk_user_browser" };
    if (token === "other-browser-token") return { sub: "clerk_user_other" };
    throw new Error("invalid");
  }),
}));

let harness, userId;
const unresolved = { name: "Opponent", toonHandle: "2-S2-1-424242", count: 3 };
const asUser = (call, token = "browser-token") => call.set("authorization", `Bearer ${token}`);

async function pairedDevice(fields = {}) {
  const bearer = await insertDeviceToken(harness.db, userId);
  if (Object.keys(fields).length) await harness.db.deviceTokens.updateOne({ tokenHash: sha256(bearer) }, { $set: fields });
  return {
    heartbeat: (body) => request(harness.app).post("/v1/devices/heartbeat").set("authorization", `Bearer ${bearer}`).send(body),
    row: () => harness.db.deviceTokens.findOne({ tokenHash: sha256(bearer) }),
  };
}

beforeAll(async () => {
  harness = await startHarness("sc2tools_test_heartbeat_sync");
  await asUser(request(harness.app).get("/v1/me"));
  await asUser(request(harness.app).get("/v1/me"), "other-browser-token");
  userId = await userIdForClerk(harness.db, "clerk_user_browser");
});
afterAll(async () => { if (harness) await harness.stop(); });
beforeEach(async () => { await harness.db.deviceTokens.deleteMany({}); });

test("a sync report is sanitized, stored and listed only for its owner", async () => {
  const device = await pairedDevice();
  const hb = await device.heartbeat({ version: "0.30.0", sync: { pending: 2, paused: true, $where: "1", "a.b": 1, revokedAt: "x",
    skipped: { player_unresolved: 3, $gt: 1 }, unresolvedNames: [{ ...unresolved, $set: { userId: "other" } }] } });
  expect(hb.status).toBe(200);
  expect(Object.keys(hb.body).sort()).toEqual(["receivedAt", "syncAccepted"]);
  expect(hb.body.syncAccepted).toBe(true);
  const row = await device.row();
  expect(row.sync).toEqual({ pending: 2, paused: true, skipped: { player_unresolved: 3 }, unresolvedNames: [unresolved] });
  expect(row.syncReportedAt).toEqual(row.lastSeenAt);
  expect(row.revokedAt).toBeNull();
  const [item] = (await asUser(request(harness.app).get("/v1/devices"))).body.items;
  expect(item).toMatchObject({ sync: row.sync, syncReportedAt: row.syncReportedAt.toISOString() });
  expect((await asUser(request(harness.app).get("/v1/devices"), "other-browser-token")).body.items).toEqual([]);
});

test("an oversize or malformed sync block is dropped while the heartbeat still succeeds", async () => {
  const old = new Date(Date.now() - 3600000);
  const device = await pairedDevice({ lastSeenAt: old, sync: { pending: 9 }, syncReportedAt: old });
  const many = Array.from({ length: 40 }, (_, i) => ({ ...unresolved, toonHandle: `1-S2-1-${i}` }));
  for (const sync of [{ pending: 1, unresolvedNames: many }, "not-an-object", { unknown: true }]) {
    const hb = await device.heartbeat({ hostname: "STILL-SEEN", sync });
    expect(hb.status).toBe(200);
    expect(hb.body.syncAccepted).toBe(false);
  }
  const row = await device.row();
  expect(row.lastSeenAt.getTime()).toBeGreaterThan(old.getTime());
  expect(row.hostname).toBe("STILL-SEEN");
  expect(row).toMatchObject({ sync: { pending: 9 }, syncReportedAt: old });
});

test("a delayed heartbeat never rolls a newer stored report back", async () => {
  const newer = new Date(Date.now() + 3600000);
  const device = await pairedDevice({ sync: { pending: 9 }, syncReportedAt: newer });
  const hb = await device.heartbeat({ hostname: "LATE", sync: { pending: 1 } });
  expect(hb.status).toBe(200);
  expect(hb.body.syncAccepted).toBe(true); // valid, but older than what is stored
  expect(await device.row()).toMatchObject({ hostname: "LATE", sync: { pending: 9 }, syncReportedAt: newer });
});

test("a heartbeat without sync keeps the old write and response, and leaves a stored report alone", async () => {
  const device = await pairedDevice();
  const hb = await device.heartbeat({ version: "0.24.0", os: "Windows" });
  expect(hb.status).toBe(200);
  expect(Object.keys(hb.body)).toEqual(["receivedAt"]);
  const bare = await device.row();
  expect(bare).not.toHaveProperty("sync");
  expect(bare).not.toHaveProperty("syncReportedAt");
  const [listed] = (await asUser(request(harness.app).get("/v1/devices"))).body.items;
  expect(Object.keys(listed).sort()).toEqual(["agentOs", "agentVersion", "createdAt", "deviceId", "lastSeenAt", "userId"]);
  await device.heartbeat({ sync: { paused: true } });
  const reported = await device.row();
  await device.heartbeat({ version: "0.24.0" });
  expect(await device.row()).toMatchObject({ sync: { paused: true }, syncReportedAt: reported.syncReportedAt });
});
