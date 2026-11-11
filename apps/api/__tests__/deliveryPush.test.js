// @ts-nocheck
"use strict";

const crypto = require("crypto");
const request = require("supertest");

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const { createHarness } = require("./helpers/reviewsHarness");
const { generateVapidKeys } = require("../src/services/webPushCrypto");
const { PushNotificationsService } = require("../src/services/pushNotifications");
const { CalendarFeedService } = require("../src/services/calendarFeed");
const CALENDAR_KEY = "a1".repeat(32);

const vapid = generateVapidKeys();
let h;
let statuses;
let sends;

function device(name) {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${name}`, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") }, label: "Chrome on Windows" };
}
const as = (name) => ({
  get: (path) => request(h.app).get(path).set("authorization", h.bearer(name)),
  post: (path, body) => request(h.app).post(path).set("authorization", h.bearer(name)).send(body),
  put: (path, body) => request(h.app).put(path).set("authorization", h.bearer(name)).send(body),
  del: (path) => request(h.app).delete(path).set("authorization", h.bearer(name)),
});

beforeAll(async () => {
  h = await createHarness({ config: { delivery: { webPush: { ...vapid, subject: "mailto:owner@example.com" }, discordEncryptionKey: CALENDAR_KEY } } });
  for (const name of ["ann", "bob", "coach", "student", "other"]) await h.seedUser(name);
  h.services.pushNotifications.fetchImpl = jest.fn(async (url, init) => {
    sends.push({ url, init });
    return { status: statuses[url] ?? 201 };
  });
});
beforeEach(async () => {
  statuses = {}; sends = [];
  await h.db.pushSubscriptions.deleteMany({});
  await h.db.notifications.deleteMany({});
  h.services.pushNotifications.lastTest.clear();
});
afterAll(async () => { await h.close(); });

test("push is inert without VAPID keys: nothing subscribes or sends", async () => {
  const inert = new PushNotificationsService(h.db, { config: null, fetchImpl: jest.fn() });
  expect(inert.enabled).toBe(false);
  await expect(inert.subscribe("u_ann", device("x"))).rejects.toMatchObject({ status: 503, code: "push_unavailable" });
  expect(await inert.deliver("u_ann", { kind: "review.new", title: "t" })).toEqual({ sent: 0, removed: 0 });
  expect((await as("ann").get("/v1/me/push")).body).toMatchObject({ enabled: true, publicKey: vapid.publicKey });
});

test("subscription lifecycle: validated, deduplicated per browser, moved between accounts and capped", async () => {
  const one = device("one");
  const saved = await as("ann").post("/v1/me/push/subscriptions", one);
  expect(saved.status).toBe(200);
  await as("ann").post("/v1/me/push/subscriptions", one).expect(200);
  for (const endpoint of ["https://169.254.169.254/latest/meta-data", "http://fcm.googleapis.com/fcm/send/x", "https://fcm.googleapis.com.evil.test/x"]) {
    expect((await as("ann").post("/v1/me/push/subscriptions", { ...one, endpoint })).body.error.code).toBe("invalid_subscription");
  }
  const status = await as("ann").get("/v1/me/push");
  expect(status.body.devices).toHaveLength(1);
  expect(status.body.devices[0]).toMatchObject({ id: saved.body.id, label: "Chrome on Windows", key: saved.body.key });
  expect(JSON.stringify(status.body)).not.toContain("fcm.googleapis.com");
  await as("bob").post("/v1/me/push/subscriptions", one).expect(200);
  expect((await as("ann").get("/v1/me/push")).body.devices).toHaveLength(0);
  for (let i = 0; i < 12; i += 1) await as("ann").post("/v1/me/push/subscriptions", device(`many-${i}`)).expect(200);
  expect(await h.db.pushSubscriptions.countDocuments({ userId: "u_ann" })).toBe(10);
});

test("bell writes fan out to devices for enabled groups only, never for muted kinds, and prune gone endpoints", async () => {
  const live = device("live"); const gone = device("gone");
  await as("ann").post("/v1/me/push/subscriptions", live).expect(200);
  await as("ann").post("/v1/me/push/subscriptions", gone).expect(200);
  statuses[gone.endpoint] = 410;
  const push = h.services.pushNotifications;
  const spy = jest.spyOn(push, "deliver");
  await as("ann").put("/v1/me/preferences/notifications", { muted: ["review.reply"] }).expect(200);
  expect(await h.services.notifications.notify("u_ann", { kind: "review.reply", title: "Muted reply" })).toBeNull();
  expect(spy).not.toHaveBeenCalled();
  const row = await h.services.notifications.notify("u_ann", { kind: "review.new", title: "New review", href: "/reviews/x" });
  expect(spy).toHaveBeenCalledTimes(1);
  await spy.mock.results[0].value;
  spy.mockRestore();
  expect(sends.map((s) => s.url).sort()).toEqual([gone.endpoint, live.endpoint].sort());
  const headers = sends[0].init.headers;
  expect(headers.Authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
  expect(headers["Content-Encoding"]).toBe("aes128gcm");
  expect(sends[0].init.redirect).toBe("error");
  expect(await h.db.pushSubscriptions.countDocuments({ userId: "u_ann" })).toBe(1);
  expect((await h.db.pushSubscriptions.findOne({ endpoint: live.endpoint })).lastOkAt).toBeInstanceOf(Date);
  sends = [];
  await as("ann").put("/v1/me/push/preferences", { groups: ["coaching-reminders"] }).expect(200);
  expect(await push.deliver("u_ann", row)).toEqual({ sent: 0, removed: 0 });
  expect(await push.deliver("u_ann", { _id: "n2", kind: "coaching.reminder", title: "Session soon" })).toEqual({ sent: 1, removed: 0 });
  expect((await as("ann").put("/v1/me/push/preferences", { groups: "coaching" })).status).toBe(400);
});

test("split push choices preserve legacy settings and allow separate goal and unlink controls", async () => {
  await as("bob").post("/v1/me/push/subscriptions", device("split")).expect(200);
  await h.db.users.updateOne({ userId: "u_bob" }, { $set: { "preferences.push": { groups: ["desktop", "other"] } } });
  const status = await as("bob").get("/v1/me/push").expect(200);
  expect(status.body.groups).toEqual(expect.arrayContaining(["desktop", "other", "goals", "agent-unlinked"]));
  expect(status.body.available).toEqual(expect.arrayContaining([
    { id: "goals", label: "Goal met" }, { id: "agent-unlinked", label: "Desktop app unlinked" },
  ]));
  const push = h.services.pushNotifications;
  await as("bob").put("/v1/me/push/preferences", { groups: ["desktop", "goals"] }).expect(200);
  expect(await push.deliver("u_bob", { kind: "agent.unlinked", title: "Desktop app unlinked" })).toMatchObject({ sent: 0 });
  expect(await push.deliver("u_bob", { kind: "goal_met", title: "Goal met" })).toMatchObject({ sent: 1 });
  await as("bob").put("/v1/me/push/preferences", { groups: ["agent-unlinked"] }).expect(200);
  expect(await push.deliver("u_bob", { kind: "agent.unlinked", title: "Desktop app unlinked" })).toMatchObject({ sent: 1 });
  expect(await push.deliver("u_bob", { kind: "goal_met", title: "Goal met" })).toMatchObject({ sent: 0 });
});

test("this browser can turn push off, remove a device, rotate its subscription and send a test", async () => {
  const a = device("a"); const b = device("b"); const next = device("a-rotated");
  const savedA = await as("ann").post("/v1/me/push/subscriptions", a);
  await as("ann").post("/v1/me/push/subscriptions", b).expect(200);
  expect((await as("ann").post("/v1/me/push/test", {})).body).toEqual({ sent: 2, removed: 0 });
  expect((await as("ann").post("/v1/me/push/test", {})).status).toBe(429);
  expect((await request(h.app).post("/v1/push/subscription-change").send({ oldEndpoint: a.endpoint, subscription: next })).body).toEqual({ rotated: true });
  expect((await request(h.app).post("/v1/push/subscription-change").send({ oldEndpoint: "https://fcm.googleapis.com/fcm/send/unknown", subscription: device("z") })).body).toEqual({ rotated: false });
  expect((await request(h.app).post("/v1/push/subscription-change").send({ oldEndpoint: next.endpoint, subscription: { ...next, endpoint: "https://evil.test/x" } })).status).toBe(400);
  expect((await h.db.pushSubscriptions.findOne({ _id: savedA.body.id })).endpoint).toBe(next.endpoint);
  expect((await as("ann").post("/v1/me/push/unsubscribe", { endpoint: b.endpoint })).body).toEqual({ removed: 1 });
  expect((await as("bob").del(`/v1/me/push/subscriptions/${savedA.body.id}`)).body).toEqual({ removed: 0 });
  expect((await as("ann").del(`/v1/me/push/subscriptions/${savedA.body.id}`)).body).toEqual({ removed: 1 });
  expect(await h.db.pushSubscriptions.countDocuments({ userId: "u_ann" })).toBe(0);
});

test("account export includes the caller's own push devices", async () => {
  await as("ann").post("/v1/me/push/subscriptions", device("export")).expect(200);
  const archive = await h.services.gdpr.export("u_ann");
  expect(archive.data.pushSubscriptions).toHaveLength(1);
  expect(archive.data.pushSubscriptions[0]).toMatchObject({ endpoint: "https://fcm.googleapis.com/fcm/send/export", label: "Chrome on Windows" });
  expect(archive.data.pushSubscriptions[0].endpointHash).toBeUndefined();
});

async function seedCalendar() {
  const now = Date.now();
  await h.db.coaching.deleteMany({ _id: /^calendar:/ });
  await h.db.coaching.insertOne({ _id: "calendar:c1", coachUserId: "u_coach", coachName: "Coach Kim", bookings: [
    { id: "b-own", studentUserId: "u_student", studentName: "Secret Student", status: "booked", startAt: new Date(now + 23 * 3600_000), endAt: new Date(now + 24 * 3600_000), createdAt: new Date(now - 3 * 86400_000) },
    { id: "b-other", studentUserId: "u_other", studentName: "Other Student", status: "cancelled", startAt: new Date(now + 48 * 3600_000), endAt: new Date(now + 49 * 3600_000), createdAt: new Date(now - 86400_000) },
  ] });
}

test("calendar feed: secret link shown once, bookings only, no student names, regenerate and revoke", async () => {
  await seedCalendar();
  const created = await as("student").post("/v1/me/calendar-feed", {});
  expect(created.body.path).toMatch(/^\/v1\/calendar\/[\w-]{43}\.ics$/);
  expect((await as("student").get("/v1/me/calendar-feed")).body).toMatchObject({ active: true });
  expect(JSON.stringify((await as("student").get("/v1/me/calendar-feed")).body)).not.toContain(created.body.path.slice(13, 40));
  const stored = await h.db.users.findOne({ userId: "u_student" });
  expect(JSON.stringify(stored.calendarFeed)).not.toContain(created.body.path.slice(13, 56));
  const feed = await request(h.app).get(created.body.path);
  expect(feed.status).toBe(200);
  expect(feed.headers["content-type"]).toMatch(/^text\/calendar/);
  expect(feed.headers["cache-control"]).toBe("private, no-store");
  expect(feed.text).toContain("UID:b-own@sc2tools.com");
  expect(feed.text).toContain("SUMMARY:Coaching session with Coach Kim");
  expect(feed.text).not.toMatch(/b-other|Secret Student|Other Student/);
  const coach = await request(h.app).get((await as("coach").post("/v1/me/calendar-feed", {})).body.path);
  expect(coach.text).toContain("UID:b-other@sc2tools.com");
  expect(coach.text).toContain("STATUS:CANCELLED");
  expect(coach.text).not.toMatch(/Secret Student|Other Student/);
  const rotated = await as("student").post("/v1/me/calendar-feed", {});
  expect((await request(h.app).get(created.body.path)).status).toBe(404);
  expect((await request(h.app).get(rotated.body.path)).status).toBe(200);
  await as("student").del("/v1/me/calendar-feed").expect(200);
  expect((await request(h.app).get(rotated.body.path)).status).toBe(404);
  expect((await request(h.app).get("/v1/calendar/not-a-secret.ics")).status).toBe(404);
});

test("account export recovers only the caller's active encrypted calendar secret", async () => {
  const { body } = await as("ann").post("/v1/me/calendar-feed", {}).expect(200);
  const secret = body.path.split("/").at(-1).slice(0, -4);
  const stored = (await h.db.users.findOne({ userId: "u_ann" })).calendarFeed;
  expect(stored.secretBox).toMatchObject({ data: expect.any(String), tag: expect.any(String) });
  expect(JSON.stringify(stored)).not.toContain(secret);

  const legacy = await as("ann").get("/v1/me/export").expect(200);
  expect(legacy.headers["cache-control"]).toBe("private, no-store");
  expect(legacy.body.user.calendarFeed).toEqual({ hash: stored.hash, createdAt: stored.createdAt.toISOString(), secret });
  const ndjson = await as("ann").get("/v1/me/export?format=ndjson").expect(200);
  const user = ndjson.text.trim().split("\n").map(JSON.parse).find((record) => record.type === "user");
  expect(user.row.calendarFeed).toEqual(legacy.body.user.calendarFeed);
  expect((await as("bob").get("/v1/me/export").expect(200)).text).not.toContain(secret);

  const deviceToken = `sc2d_${"r".repeat(43)}`;
  await h.db.deviceTokens.insertOne({ userId: "u_ann", tokenHash: crypto.createHash("sha256").update(deviceToken).digest("hex"), revokedAt: null });
  const deviceExport = (path) => request(h.app).get(path).set("authorization", `Bearer ${deviceToken}`).expect(200);
  const deviceJson = await deviceExport("/v1/me/export");
  expect(deviceJson.body.user.calendarFeed).toEqual({ hash: stored.hash, createdAt: stored.createdAt.toISOString() });
  const deviceNdjson = await deviceExport("/v1/me/export?format=ndjson");
  const deviceUser = deviceNdjson.text.trim().split("\n").map(JSON.parse).find((record) => record.type === "user");
  expect(deviceUser.row.calendarFeed).toEqual(deviceJson.body.user.calendarFeed);

  const { calendarFeed } = h.services;
  expect(calendarFeed.exportRecord("u_bob", stored)).toEqual({ hash: stored.hash, createdAt: stored.createdAt });
  expect(calendarFeed.exportRecord("u_ann", { ...stored, hash: "bad" })).toEqual({ hash: "bad", createdAt: stored.createdAt });
  expect(new CalendarFeedService(h.db).exportRecord("u_ann", stored)).not.toHaveProperty("secretBox");

  const rotated = await as("ann").post("/v1/me/calendar-feed", {}).expect(200);
  const current = await as("ann").get("/v1/me/export").expect(200);
  expect(rotated.body.path).toContain(current.body.user.calendarFeed.secret);
  expect(current.text).not.toContain(secret);
  await as("ann").del("/v1/me/calendar-feed").expect(200);
  expect((await as("ann").get("/v1/me/export").expect(200)).body.user).not.toHaveProperty("calendarFeed");
});

test("a hash-only feed keeps working and revocation fences a read already loading bookings", async () => {
  const legacy = new CalendarFeedService(h.db);
  const { path } = await legacy.rotate("u_ann");
  const secret = path.split("/").at(-1).slice(0, -4);
  expect((await as("ann").get("/v1/me/export").expect(200)).body.user.calendarFeed)
    .toEqual({ hash: expect.any(String), createdAt: expect.any(String) });
  expect(await legacy.feed(secret)).toContain("BEGIN:VCALENDAR");
  const loaded = jest.spyOn(legacy, "events").mockImplementationOnce(async () => {
    await legacy.revoke("u_ann");
    return [];
  });
  expect(await legacy.feed(secret)).toBeNull();
  expect(loaded).toHaveBeenCalledTimes(1);
});

test("coaching reminders reach coach and student once per window", async () => {
  await seedCalendar();
  expect((await h.services.coachingReminders.sweep()).sent).toBe(2);
  expect((await h.services.coachingReminders.sweep()).sent).toBe(0);
  const rows = await h.db.notifications.find({ kind: "coaching.reminder" }).toArray();
  expect(rows.map((row) => row.userId).sort()).toEqual(["u_coach", "u_student"]);
  expect(rows[0]).toMatchObject({ title: "Coaching session in 24 hours", href: "/coaching" });
});
