// @ts-nocheck
"use strict";

const request = require("supertest");
jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());
const { createHarness } = require("./helpers/reviewsHarness");
const { sampleGame } = require("./helpers/browserIngestHarness");
const { NotificationsService } = require("../src/services/notifications");

describe("always-on notification center and support loop", () => {
  let h;
  beforeAll(async () => {
    h = await createHarness({ rollout: "off" });
    for (const name of ["ann", "bob", "admin"]) await h.seedUser(name);
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    await h.db.notifications.deleteMany({}); await h.db.adminEvents.deleteMany({});
    await h.db.users.updateMany({}, { $unset: { "preferences.notifications": "" } });
  });
  const as = (name, req) => req.set("authorization", h.bearer(name));

  test("requires auth, remains available with Reviews off, and isolates preferences and rows by user", async () => {
    await request(h.app).get("/v1/me/notifications").expect(401);
    await as("ann", request(h.app).get("/v1/me/notifications")).expect(200);
    await h.db.users.updateOne({ userId: h.userId("ann") }, { $set: { "preferences.onboarding": { dismissedAt: "kept" }, "preferences.misc": { defaultTab: "macro" } } });
    const saved = await as("ann", request(h.app).put("/v1/me/preferences/notifications")).send({ muted: ["import.done", "import.done", "BAD KIND", 4], arbitrary: true }).expect(200);
    expect(saved.body).toEqual({ muted: ["import.done"], milestones: false });
    const user = await h.db.users.findOne({ userId: h.userId("ann") });
    expect(user.preferences.onboarding).toEqual({ dismissedAt: "kept" }); expect(user.preferences.misc).toEqual({ defaultTab: "macro" });
    expect(await h.services.notifications.notify(h.userId("ann"), { kind: "import.done", title: "Muted" })).toBeNull();
    await h.services.notifications.notify(h.userId("bob"), { kind: "import.done", title: "Bob's import" });
    const rows = await as("ann", request(h.app).get("/v1/me/notifications")); expect(rows.body.items).toEqual([]);
    expect((await as("bob", request(h.app).get("/v1/me/notifications"))).body.items).toHaveLength(1);
  });

  test("deduplicates concurrent deliveries, keeps distinct grouped events and cannot resurface a read retry", async () => {
    const notify = (id) => h.services.notifications.notify(h.userId("ann"), {
      kind: "community.vote", groupKey: "build:today", eventKey: `vote:${id}`,
      title: "1 upvote on Opener", render: (count) => ({ title: `${count} upvotes on Opener` }),
    });
    await Promise.all(Array.from({ length: 20 }, (_, i) => notify(i % 10)));
    const rows = await h.db.notifications.find({ userId: h.userId("ann") }).toArray();
    expect(rows).toHaveLength(1); expect(rows[0].count).toBe(10); expect(rows[0].deliveryKeys).toHaveLength(10);
    expect(rows[0].title).toBe("10 upvotes on Opener");
    await as("ann", request(h.app).post("/v1/me/notifications/read")).send({ all: true }).expect(200);
    await notify(0); expect(await h.db.notifications.countDocuments({ userId: h.userId("ann") })).toBe(1);
    expect((await as("ann", request(h.app).get("/v1/me/notifications/unread-count"))).body.count).toBe(0);
    const response = await as("ann", request(h.app).get("/v1/me/notifications")); expect(JSON.stringify(response.body)).not.toContain("deliveryKeys");
  });

  test("filters categories on the server while compound cursors preserve timestamp ties", async () => {
    const at = new Date();
    await h.db.notifications.insertMany(Array.from({ length: 35 }, (_, i) => ({ _id: `notice_${String(i).padStart(2, "0")}`, userId: h.userId("ann"), kind: i < 25 ? "coaching.booked" : "import.done", title: "Notice", createdAt: at, readAt: null })));
    const first = await as("ann", request(h.app).get("/v1/me/notifications?kind=coaching&limit=20")).expect(200);
    const next = await as("ann", request(h.app).get(`/v1/me/notifications?kind=coaching&limit=20&before=${encodeURIComponent(first.body.nextCursor)}`)).expect(200);
    expect(first.body.items).toHaveLength(20); expect(next.body.items).toHaveLength(5);
    expect(new Set([...first.body.items, ...next.body.items].map((row) => row.id)).size).toBe(25);
    expect((await as("ann", request(h.app).get("/v1/me/notifications?kind=system"))).body.items).toHaveLength(10);
    await as("ann", request(h.app).get("/v1/me/notifications?kind=invalid%20kind")).expect(400);
  });

  test("milestone delivery requires explicit consent and the category is owner-scoped", async () => {
    const userId = h.userId("ann");
    const input = { kind: "moment.win_streak", title: "5 wins in a row", eventKey: "test-game:winStreak", href: "/app/game/test-game" };
    const emit = jest.fn();
    const notifications = new NotificationsService(h.db, { io: { to: jest.fn(() => ({ emit })) } });
    await as("ann", request(h.app).get("/v1/me/preferences/notifications")).expect(200, { muted: [], milestones: false });
    await as("ann", request(h.app).put("/v1/me/preferences/notifications")).send({ milestones: "true" }).expect(200, { muted: [], milestones: false });
    expect(await notifications.notify(userId, input)).toBeNull();
    await as("ann", request(h.app).put("/v1/me/preferences/notifications")).send({ milestones: true }).expect(200, { muted: [], milestones: true });
    expect(await notifications.notify(userId, input)).toMatchObject({ kind: input.kind });
    expect(await notifications.notify(userId, input)).toBeNull();
    expect(emit.mock.calls).toEqual([["notifications:changed", { kind: "refresh" }]]);
    const mine = await as("ann", request(h.app).get("/v1/me/notifications?kind=milestones")).expect(200);
    expect(mine.body.items).toEqual([expect.objectContaining({ kind: input.kind, title: input.title, href: input.href, count: 1 })]);
    expect(JSON.stringify(mine.body)).not.toMatch(/deliveryKeys|userId/);
    for (const [owner, category] of [["ann", "system"], ["bob", "milestones"]]) {
      const other = await as(owner, request(h.app).get(`/v1/me/notifications?kind=${category}`)).expect(200);
      expect(other.body.items).toEqual([]);
    }
    await as("ann", request(h.app).put("/v1/me/preferences/notifications")).send({ milestones: false }).expect(200);
    expect(await notifications.notify(userId, { ...input, eventKey: "another-game:winStreak" })).toBeNull();
    expect(await h.db.notifications.countDocuments({ userId })).toBe(1);
  });

  test("a fresh replay batch supplies every eligible bell milestone without a browser-source token", async () => {
    const userId = h.userId("ann");
    await as("ann", request(h.app).put("/v1/me/preferences/notifications")).send({ milestones: true }).expect(200);
    const moments = h.services.gameMoments;
    const process = moments.process.bind(moments);
    const pending = [];
    const trigger = jest.spyOn(moments, "process").mockImplementation((...args) => {
      const work = process(...args);
      pending.push(work);
      return work;
    });
    const upload = (...games) => as("ann", request(h.app).post("/v1/games")).send({ games }).expect(202);
    const waitForCalls = async count => {
      for (let wait = 0; pending.length < count && wait < 100; wait++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(pending).toHaveLength(count);
      await Promise.all(pending);
    };
    const fresh = sampleGame(1, { date: new Date().toISOString(), durationSec: 1_500, playerCount: 2 });
    const historical = sampleGame(2, { date: new Date(Date.now() - 30 * 60_000).toISOString(), durationSec: 1_500, playerCount: 2 });
    const earlier = sampleGame(3, { date: new Date(Date.now() - 60_000).toISOString(), durationSec: 1_500, playerCount: 2 });
    const resumed = sampleGame(4, { date: new Date().toISOString(), durationSec: 1_500, playerCount: 2, isResumedFromReplay: true });
    try {
      await upload(earlier, resumed, fresh, historical);
      await waitForCalls(2);
      expect(trigger.mock.calls.map(([, game, , , options]) => [game.gameId, options.created]))
        .toEqual([[fresh.gameId, true], [earlier.gameId, true]]);
      await upload(fresh);
      await waitForCalls(3);
      expect(trigger.mock.calls[2][4]).toEqual({ created: false });
      const rows = await h.db.notifications.find({ userId }).toArray();
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(expect.arrayContaining([fresh, earlier].map(game =>
        expect.objectContaining({ kind: "moment.marathon_win", href: `/app/game/${encodeURIComponent(game.gameId)}` }))));
    } finally {
      trigger.mockRestore();
    }
  });

  test("the same event cannot be folded into competing unread groups", async () => {
    const service = h.services.notifications;
    const userId = h.userId("ann");
    for (const groupKey of ["first-group", "second-group"]) {
      await service.notify(userId, { kind: "import.done", title: "Initial event", groupKey });
    }
    const input = { kind: "import.done", title: "Retried delivery", eventKey: "one-source-event" };
    const results = await Promise.all(["first-group", "second-group"].map((groupKey) => service._fold(userId, { ...input, groupKey }, "/app", new Date())));
    expect(results.filter(Boolean)).toHaveLength(1);
    const rows = await h.db.notifications.find({ userId }).toArray();
    expect(rows.map((row) => row.count).sort()).toEqual([1, 2]);
    expect(rows.flatMap((row) => row.deliveryKeys || [])).toHaveLength(1);
  });

  test("round-trips an admin status/reply to only the sender and retries a saved action once", async () => {
    const report = await as("ann", request(h.app).post("/v1/messages")).send({ subject: "Missing chart", message: "My chart did not load." }).expect(201);
    const eventId = report.body.eventId;
    const action = { expectedRevision: 0, requestId: "reply_action_001", status: "looking", reply: "We are checking the chart." };
    await as("bob", request(h.app).patch(`/v1/admin/messages/${eventId}`)).send(action).expect(403);
    await as("admin", request(h.app).patch(`/v1/admin/messages/${eventId}`)).send(action).expect(200);
    await as("ann", request(h.app).post("/v1/me/notifications/read")).send({ all: true });
    await as("admin", request(h.app).patch(`/v1/admin/messages/${eventId}`)).send(action).expect(200);
    expect(await h.db.notifications.countDocuments({ userId: h.userId("ann") })).toBe(2);
    expect((await as("ann", request(h.app).get("/v1/me/notifications/unread-count"))).body.count).toBe(0);
    const mine = await as("ann", request(h.app).get("/v1/messages/mine")).expect(200);
    expect(mine.body.items[0]).toMatchObject({ eventId, status: "looking", revision: 1, replies: [{ message: action.reply }] });
    expect(JSON.stringify(mine.body)).not.toMatch(/clerkUserId|email|userId|context|deliveryKeys/);
    expect((await as("bob", request(h.app).get("/v1/messages/mine"))).body.items).toEqual([]);
    await request(h.app).get("/v1/messages/mine").expect(401);
    await as("admin", request(h.app).patch(`/v1/admin/messages/${eventId}`)).send({ ...action, reply: "Changed payload" }).expect(409);
    await as("admin", request(h.app).patch(`/v1/admin/messages/${eventId}`)).send({ ...action, requestId: "stale_action_002", status: "fixed" }).expect(409);
  });

  test("recovers notification failure after saving a reply without duplicating the reply", async () => {
    const report = await as("ann", request(h.app).post("/v1/messages")).send({ subject: "Reply retry", message: "Please check this issue." });
    const path = `/v1/admin/messages/${report.body.eventId}`;
    const action = { expectedRevision: 0, requestId: "reply_retry_001", reply: "This reply is saved once." };
    const spy = jest.spyOn(h.services.notifications, "notify").mockRejectedValueOnce(new Error("temporary notification failure"));
    await as("admin", request(h.app).patch(path)).send(action).expect(500); spy.mockRestore();
    await as("admin", request(h.app).patch(path)).send(action).expect(200);
    const mine = await as("ann", request(h.app).get("/v1/messages/mine")); expect(mine.body.items[0].replies).toHaveLength(1);
    expect(await h.db.notifications.countDocuments({ userId: h.userId("ann"), kind: "support.reply" })).toBe(1);
  });

  test("keeps successive unread status transitions accurate instead of folding an old status title", async () => {
    const report = await as("ann", request(h.app).post("/v1/messages")).send({ subject: "Status history", message: "Please check this issue." });
    const endpoint = `/v1/admin/messages/${report.body.eventId}`;
    await as("admin", request(h.app).patch(endpoint)).send({ expectedRevision: 0, requestId: "status_looking_001", status: "looking" }).expect(200);
    await as("admin", request(h.app).patch(endpoint)).send({ expectedRevision: 1, requestId: "status_fixed_002", status: "fixed" }).expect(200);
    const rows = await h.db.notifications.find({ userId: h.userId("ann"), kind: "support.status" }).toArray();
    expect(rows.map((row) => row.title).sort()).toEqual(["Report status: Fixed", "Report status: Looking into it"]);
    expect((await as("ann", request(h.app).get("/v1/messages/mine"))).body.items[0].status).toBe("fixed");
  });

  test("a report anonymized during an admin edit cannot receive a reply", async () => {
    const report = await as("ann", request(h.app).post("/v1/messages")).send({ subject: "Erase race", message: "Please check this issue." });
    const eventId = report.body.eventId;
    const update = h.db.adminEvents.findOneAndUpdate.bind(h.db.adminEvents);
    const spy = jest.spyOn(h.db.adminEvents, "findOneAndUpdate").mockImplementationOnce(async (filter, patch, options) => {
      await h.db.adminEvents.updateOne({ eventId }, { $set: { anonymizedAt: new Date() } });
      return update(filter, patch, options);
    });
    try {
      await as("admin", request(h.app).patch(`/v1/admin/messages/${eventId}`)).send({ expectedRevision: 0, requestId: "erase_race_001", reply: "This must not be saved." }).expect(409);
    } finally { spy.mockRestore(); }
    expect((await h.db.adminEvents.findOne({ eventId })).report).toBeUndefined();
    expect(await h.db.notifications.countDocuments({ userId: h.userId("ann") })).toBe(0);
  });
});
