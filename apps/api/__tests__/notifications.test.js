// @ts-nocheck
"use strict";

const request = require("supertest");

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const { createHarness } = require("./helpers/reviewsHarness");
const { NotificationsService, safeHref } = require("../src/services/notifications");

async function checkUnreadPaging(h) {
  const userId = h.userId("ann");
  await h.db.notifications.deleteMany({ userId });
  const old = new Date("2026-10-01T12:00:00.000Z");
  const recent = new Date("2026-10-17T12:00:00.000Z");
  const rows = (prefix, total, createdAt, readAt) => Array.from({ length: total }, (_, i) => ({
    _id: `${prefix}${String(i).padStart(2, "0")}`, userId,
    kind: "review.new", title: `${prefix}${i}`, body: "", href: "/reviews/x",
    count: 1, createdAt, readAt,
  }));
  await h.db.notifications.insertMany([
    ...rows("read", 20, recent, recent), ...rows("old", 29, old, null),
  ]);
  const get = (query = "") => request(h.app).get(`/v1/me/notifications${query}`).set("authorization", h.bearer("ann"));
  const history = await get("?limit=20");
  expect(history.body.items).toHaveLength(20);
  expect(history.body.items.every((row) => row.readAt)).toBe(true);
  const page = await get("?limit=20&unread=true");
  expect(page.body.items).toHaveLength(20);
  expect(page.body.items.every((row) => row.readAt === null)).toBe(true);
  expect(page.body.nextCursor).toMatch(/^n1\./);
  await request(h.app).post("/v1/me/notifications/read").set("authorization", h.bearer("ann"))
    .send({ ids: page.body.items.map((row) => row.id) }).expect(200);
  const remaining = await get(`?limit=20&unread=true&before=${encodeURIComponent(page.body.nextCursor)}`);
  expect(remaining.body.items).toHaveLength(9);
  expect(remaining.body.nextCursor).toBeNull();
  expect(new Set([...page.body.items, ...remaining.body.items].map((row) => row.id)).size).toBe(29);
  const other = await request(h.app).get(`/v1/me/notifications?unread=true&before=${encodeURIComponent(page.body.nextCursor)}`)
    .set("authorization", h.bearer("bob"));
  expect(other.body.items.some((row) => row.id.startsWith("old"))).toBe(false);
  const legacy = await get(`?before=${encodeURIComponent(recent.toISOString())}`);
  expect(legacy.body.items.every((row) => row.id.startsWith("old"))).toBe(true);
  await get("?before=n1.invalid").expect(400);
}

describe("notifications", () => {
  let h;

  beforeAll(async () => {
    h = await createHarness();
    await h.seedUser("ann");
    await h.seedUser("bob");
  });
  afterAll(async () => {
    await h.close();
  });

  test("groups unread events, lists newest first, counts and marks read", async () => {
    const svc = h.services.notifications;
    const render = (n) => ({ title: n === 1 ? "New review on your replay" : `${n} new reviews on your replay` });
    await svc.notify(h.userId("ann"), { kind: "review.new", groupKey: "review-new:x", title: "New review on your replay", href: "/reviews/x", render });
    await svc.notify(h.userId("ann"), { kind: "review.new", groupKey: "review-new:x", title: "New review on your replay", href: "/reviews/x", render });
    await svc.notify(h.userId("ann"), { kind: "review.helpful", title: "Your review was marked helpful", href: "/reviews/y" });
    const list = await request(h.app).get("/v1/me/notifications").set("authorization", h.bearer("ann"));
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(2);
    const grouped = list.body.items.find((n) => n.kind === "review.new");
    expect(grouped).toMatchObject({ title: "2 new reviews on your replay", count: 2, readAt: null });
    expect((await request(h.app).get("/v1/me/notifications/unread-count").set("authorization", h.bearer("ann"))).body.count).toBe(2);
    expect((await request(h.app).get("/v1/me/notifications").set("authorization", h.bearer("bob"))).body.items).toEqual([]);

    await request(h.app).post("/v1/me/notifications/read").set("authorization", h.bearer("bob")).send({ ids: [grouped.id] }).expect(200);
    expect((await request(h.app).get("/v1/me/notifications/unread-count").set("authorization", h.bearer("ann"))).body.count).toBe(2);
    await request(h.app).post("/v1/me/notifications/read").set("authorization", h.bearer("ann")).send({ ids: [grouped.id] }).expect(200);
    // A read group starts a fresh row on the next event.
    await svc.notify(h.userId("ann"), { kind: "review.new", groupKey: "review-new:x", title: "New review on your replay", render });
    const after = await request(h.app).get("/v1/me/notifications").set("authorization", h.bearer("ann"));
    expect(after.body.items.filter((n) => n.kind === "review.new")).toHaveLength(2);
    await request(h.app).post("/v1/me/notifications/read").set("authorization", h.bearer("ann")).send({ all: true }).expect(200);
    expect((await request(h.app).get("/v1/me/notifications/unread-count").set("authorization", h.bearer("ann"))).body.count).toBe(0);
    expect((await request(h.app).get("/v1/me/notifications")).status).toBe(401);
  });

  test("pushes a text-free ping to the user's socket room", async () => {
    const emit = jest.fn();
    const io = { to: jest.fn(() => ({ emit })) };
    const svc = new NotificationsService(h.db, { io });
    await svc.notify(h.userId("bob"), { kind: "review.best", title: "Private-ish title", body: "body text" });
    expect(io.to).toHaveBeenCalledWith(`user:${h.userId("bob")}`);
    expect(emit).toHaveBeenCalledWith("notifications:changed", { kind: "review.best" });
  });

  test("unread filtering precedes pagination and a compound cursor reaches tied older unread rows", async () => {
    await checkUnreadPaging(h);
  });

  test("only same-site relative links are stored", () => {
    expect(safeHref("/reviews/abc#comment-1")).toBe("/reviews/abc#comment-1");
    expect(safeHref("https://evil.example")).toBeNull();
    expect(safeHref("//evil.example")).toBeNull();
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("/\\evil")).toBeNull();
  });
});
