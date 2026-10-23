// @ts-nocheck
"use strict";
const request = require("supertest");
jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());
const { createHarness } = require("./helpers/reviewsHarness");

describe("curated updates and public incident notices", () => {
  let h; let now;
  beforeAll(async () => { h = await createHarness({ rollout: "off" }); for (const name of ["ann", "admin"]) await h.seedUser(name); });
  afterAll(async () => h.close());
  beforeEach(async () => { now = new Date("2026-10-23T12:00:00Z"); h.services.announcements.now = () => now; await h.db.siteConfig.deleteMany({}); await h.db.notifications.deleteMany({}); });
  const as = (name, req) => req.set("authorization", h.bearer(name));
  const draft = (patch = {}) => ({ severity: "warning", audience: "all", message: "Uploads are delayed. Your replays are safe.", href: "/help/desktop-app-overview", startsAt: "2026-10-23T11:00:00Z", endsAt: "2026-10-23T13:00:00Z", expectedRevision: 0, ...patch });

  test("serves a public cacheable banner with ETag, excludes scheduled/expired notices and requires admin writes", async () => {
    const endpoint = "/v1/admin/announcements";
    await request(h.app).put(endpoint).send(draft()).expect(401);
    await as("ann", request(h.app).put(endpoint)).send(draft()).expect(403);
    const saved = await as("admin", request(h.app).put(endpoint)).send(draft()).expect(200);
    expect(saved.body.banner).toMatchObject({ message: draft().message, revision: 1, severity: "warning" });
    const active = await request(h.app).get("/v1/site/banner").expect(200);
    expect(active.headers["cache-control"]).toBe("public, max-age=60"); expect(active.headers.etag).toMatch(/^"[a-f0-9]+"$/);
    expect(active.body.banner.message).toBe(draft().message);
    await request(h.app).get("/v1/site/banner").set("If-None-Match", active.headers.etag).expect(304);
    now = new Date("2026-10-23T10:59:59Z"); expect((await request(h.app).get("/v1/site/banner")).body.banner).toBeNull();
    now = new Date("2026-10-23T13:00:00Z"); expect((await request(h.app).get("/v1/site/banner").set("If-None-Match", active.headers.etag)).body.banner).toBeNull();
  });

  test("rejects invalid notices, protects concurrent edits, broadcasts only a hash and can end a future notice", async () => {
    const emit = jest.fn(); h.services.announcements.io = { emit };
    for (const invalid of [{ endsAt: undefined }, { endsAt: "bad" }, { endsAt: "2026-10-23T10:00:00Z" }, { message: "x".repeat(241) }, { message: "hello\nworld" }, { href: "//evil.example" }, { href: "/\n/evil.example" }, { severity: "other" }]) {
      await as("admin", request(h.app).put("/v1/admin/announcements")).send(draft(invalid)).expect(400);
    }
    await as("admin", request(h.app).put("/v1/admin/announcements")).send(draft({ startsAt: "2026-10-23T12:30:00Z" })).expect(200);
    expect(emit).toHaveBeenCalledWith("site:banner", { hash: expect.any(String) }); expect(JSON.stringify(emit.mock.calls)).not.toContain("Uploads");
    await as("admin", request(h.app).put("/v1/admin/announcements")).send(draft()).expect(409);
    await as("admin", request(h.app).delete("/v1/admin/announcements")).send({ expectedRevision: 1 }).expect(200);
    now = new Date("2026-10-23T14:00:00Z"); expect(await h.services.announcements.active()).toBeNull();
    await as("admin", request(h.app).delete("/v1/admin/announcements")).send({ expectedRevision: 1 }).expect(409);
    h.services.announcements.io = undefined;
  });

  test("the installer feed carries only active agent/all notices, even with no published installer", async () => {
    await as("admin", request(h.app).put("/v1/admin/announcements")).send(draft({ audience: "website" })).expect(200);
    expect((await request(h.app).get("/v1/agent/version")).body.notice).toBeNull();
    await as("admin", request(h.app).put("/v1/admin/announcements")).send(draft({ audience: "agent", expectedRevision: 1 })).expect(200);
    expect((await request(h.app).get("/v1/agent/version")).body).toMatchObject({ update_available: false, notice: { message: draft().message } });
    now = new Date("2026-10-23T13:00:00Z"); expect((await request(h.app).get("/v1/agent/version")).body.notice).toBeNull();
  });

  test("major updates deliver once per entry across concurrent visits and read retries, while respecting mutes", async () => {
    const userId = h.userId("ann");
    await Promise.all(Array.from({ length: 5 }, () => h.services.announcements.deliverMajors(userId)));
    const rows = await h.db.notifications.find({ userId, kind: "whats_new" }).toArray(); expect(rows).toHaveLength(1); expect(rows[0].count).toBe(1);
    await h.services.notifications.markRead(userId, { all: true }); await h.services.announcements.deliverMajors(userId);
    expect((await h.services.notifications.unreadCount(userId)).count).toBe(0);
    await h.db.users.updateOne({ userId: h.userId("admin") }, { $set: { "preferences.notifications": { muted: ["whats_new"] } } });
    await h.services.announcements.deliverMajors(h.userId("admin")); expect(await h.db.notifications.countDocuments({ userId: h.userId("admin") })).toBe(0);
  });
});
