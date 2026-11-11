// @ts-nocheck
"use strict";

const request = require("supertest");

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const { createHarness } = require("./helpers/reviewsHarness");
const { KEEP } = require("../src/services/streamReports");

let h;
let seq = 0;
const HOUR = 3600_000;
const MONDAY_W47_BERLIN_10 = Date.parse("2026-11-16T09:00:00Z"); // Mon 16 Nov 10:00 in Berlin

function game(userId, date, extra = {}) {
  seq += 1;
  return { userId, gameId: `g${seq}`, date: new Date(date), createdAt: new Date(date), result: "Victory", myRace: "Protoss", map: "Alcyone LE",
    myBuild: "PvZ Stargate", durationSec: 600, myMmr: 4000 + seq, myToonHandle: "2-S2-1-111", opponent: { race: "Zerg", strategy: "Roach push", mmr: 3950, displayName: "SecretOppZed" }, ...extra };
}
const get = (name, path) => request(h.app).get(path).set("authorization", h.bearer(name));

beforeAll(async () => {
  h = await createHarness();
  // Stream tests use their own users: the weekly fixtures sit on fixed dates near today.
  for (const name of ["ann", "bob", "carol", "dan", "eve", "fay", "gus", "hal"]) await h.seedUser(name);
});
afterAll(async () => { await h.close(); });

test("weekly report weeks are local: a game at 00:30 Monday in Berlin belongs to the new week there", async () => {
  await h.db.games.insertMany([game("u_dan", "2026-11-08T23:30:00Z"), game("u_dan", "2026-11-08T22:30:00Z", { result: "Defeat" })]);
  const berlin = await get("dan", "/v1/reports/weekly?week=2026-W46&tz=Europe/Berlin");
  expect(berlin.status).toBe(200);
  expect(berlin.body.totals).toMatchObject({ games: 1, wins: 1, losses: 0, previous: { games: 1, wins: 0, losses: 1 } });
  expect(berlin.body.start).toBe("2026-11-08T23:00:00.000Z");
  const utc = await get("dan", "/v1/reports/weekly?week=2026-W46&tz=UTC");
  expect(utc.body.totals).toMatchObject({ games: 0, previous: { games: 2 } });
  expect((await get("dan", "/v1/reports/weekly?week=2026-W99")).status).toBe(400);
  expect((await get("dan", "/v1/reports/weekly?week=2099-W01")).status).toBe(400);
});

test("weekly facts carry samples: best/worst only from three decided games, matchups against last week", async () => {
  const start = Date.parse("2026-11-02T10:00:00Z");
  const rows = [];
  for (let i = 0; i < 4; i += 1) rows.push(game("u_bob", start + i * HOUR, { map: "Map A", macroScore: 70 + i, top3Leaks: [{ name: "Supply block" }] }));
  for (let i = 0; i < 3; i += 1) rows.push(game("u_bob", start + (5 + i) * HOUR, { map: "Map B", result: i ? "Defeat" : "Victory", opponent: { race: "Terran", strategy: "Bio" } }));
  rows.push(game("u_bob", start + 9 * HOUR, { map: "Map C", result: "Defeat" }));
  rows.push(game("u_bob", start - 7 * 24 * HOUR, { map: "Map A", result: "Defeat" }));
  await h.db.games.insertMany(rows);
  const res = await get("bob", "/v1/reports/weekly?week=2026-W45&tz=UTC");
  expect(res.body.maps.best).toEqual({ name: "Map A", games: 4, wins: 4, losses: 0 });
  expect(res.body.maps.worst).toEqual({ name: "Map B", games: 3, wins: 1, losses: 2 });
  expect(res.body.matchups).toEqual(expect.arrayContaining([{ matchup: "PvZ", games: 5, wins: 4, losses: 1, previous: { games: 1, wins: 0, losses: 1 } }]));
  expect(res.body.macro).toMatchObject({ average: 71.5, games: 4, topLeak: { name: "Supply block", games: 4 }, previous: { average: null } });
  expect(res.body.opponentStrategies[0]).toEqual({ name: "Roach push", games: 5, wins: 4, losses: 1 });
  expect(res.body.mmr[0]).toMatchObject({ account: "Europe", race: "Protoss", games: 8 });
  expect(res.body.totals.sessions).toBe(3); // 90-minute gap: hours 0-3, 5-7, 9
  expect(res.body.navigation).toMatchObject({ previous: "2026-W44", next: "2026-W46" });
  expect(JSON.stringify(res.body)).not.toContain("SecretOppZed");
});

test("weekly delivery: Monday 09:00 in the user's zone, claimed once, quiet under five games, opt-out respected", async () => {
  const weekly = h.services.weeklyReports;
  const onWeekly = jest.fn(async () => {});
  weekly.onWeekly = onWeekly;
  await h.db.users.updateOne({ userId: "u_ann" }, { $set: { "preferences.reports": { timezone: "Europe/Berlin" } } });
  await h.db.users.updateOne({ userId: "u_carol" }, { $set: { "preferences.reports": { timezone: "Europe/Berlin", weekly: false } } });
  const w46 = Date.parse("2026-11-10T18:00:00Z");
  await h.db.games.insertMany([...Array.from({ length: 6 }, (_, i) => game("u_ann", w46 + i * HOUR, { result: i % 3 ? "Victory" : "Defeat" })),
    ...Array.from({ length: 6 }, (_, i) => game("u_carol", w46 + i * HOUR))]);
  weekly.now = () => MONDAY_W47_BERLIN_10 - 2 * HOUR; // 08:00 Berlin: too early
  weekly.candidateCache.clear();
  expect((await weekly.sweep()).sent).toBe(0);
  weekly.now = () => MONDAY_W47_BERLIN_10;
  expect((await weekly.sweep()).sent).toBe(1);
  expect((await weekly.sweep()).sent).toBe(0);
  weekly.candidateCache.clear();
  await h.db.users.updateOne({ userId: "u_ann" }, { $unset: { "reports.weeklyWeek": "" } });
  expect((await weekly.sweep()).sent).toBe(0); // re-claimed, but the delivery key keeps the bell at one row
  const rows = await h.db.notifications.find({ kind: "report.weekly" }).toArray();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ userId: "u_ann", title: "Week 46: 6 games, 4–2, +5 MMR", href: "/app/reports/weekly/2026-W46" });
  expect(onWeekly).toHaveBeenCalledWith("u_ann", expect.objectContaining({ week: "2026-W46" }));
  expect((await h.db.users.findOne({ userId: "u_carol" })).reports?.weeklyWeek).toBeUndefined();
  await h.db.games.insertMany(Array.from({ length: 5 }, (_, i) => game("u_dan", w46 + i * HOUR, { createdAt: new Date(w46 + i * HOUR), date: new Date(Date.parse("2026-10-01T00:00:00Z") + i * HOUR) })));
  weekly.candidateCache.clear();
  await weekly.sweep();
  expect((await h.db.users.findOne({ userId: "u_dan" })).reports.weeklyWeek).toBe("2026-W46");
  expect(await h.db.notifications.countDocuments({ userId: "u_dan", kind: "report.weekly" })).toBe(0);
});

test("a failed weekly build gives the week back for the next tick", async () => {
  const weekly = h.services.weeklyReports;
  const build = weekly.build;
  weekly.build = jest.fn(async () => { throw Object.assign(new Error("boom"), { code: "boom" }); });
  weekly.now = () => MONDAY_W47_BERLIN_10 + HOUR;
  weekly.candidateCache.clear();
  await h.db.users.updateOne({ userId: "u_gus" }, { $set: { "preferences.reports": { timezone: "Europe/Berlin" } } });
  await h.db.games.insertMany(Array.from({ length: 5 }, (_, i) => game("u_gus", Date.parse("2026-11-11T10:00:00Z") + i * HOUR)));
  await weekly.sweep();
  expect((await h.db.users.findOne({ userId: "u_gus" })).reports?.weeklyWeek).toBeUndefined();
  weekly.build = build;
  await weekly.sweep();
  expect((await h.db.users.findOne({ userId: "u_gus" })).reports.weeklyWeek).toBe("2026-W46");
  expect(await h.db.notifications.countDocuments({ userId: "u_gus", kind: "report.weekly" })).toBe(1);
});

test("stream report: computed once per stream, stored without opponent names, listed and readable only by its owner", async () => {
  const streams = h.services.streamReports;
  const start = Date.now() - 3 * HOUR;
  await h.db.games.insertMany([game("u_eve", start + HOUR, { opponent: { race: "Terran", mmr: 4300, displayName: "SecretOppZed" } }),
    game("u_eve", start + 2 * HOUR, { result: "Defeat", buildIntent: { randomizer: { key: "x" } } })]);
  await h.db.overlayTokens.insertOne({ userId: "u_eve", token: "tok-eve" });
  await h.db.multichatPredictions.insertOne({ token: "tok-eve", gameKey: "k1", openedAt: new Date(start + HOUR), settled: true, resolution: "verified", result: "win",
    picks: { "twitch:viewer1": { pick: "win", user: "ViewerOne" }, "twitch:viewer2": { pick: "loss", user: "ViewerTwo" } } });
  await h.db.multichatEngagementEvents.insertOne({ token: "tok-eve", platform: "twitch", msgId: "m1", user: "ViewerOne", userKey: "twitch:viewerone", kind: "sub", atMs: start + HOUR, atDate: new Date() });
  await h.db.multichatClipMoments.insertMany([
    { token: "tok-eve", kind: "manual", atMs: start + HOUR, reason: "Private Dock note" },
    { token: "tok-eve", kind: "game-event", atMs: start + HOUR, reason: "First game won" },
  ]);
  await streams.start("u_eve", start);
  const [first, second] = await Promise.all([streams.end("u_eve"), streams.end("u_eve")]);
  expect([first, second].filter(Boolean)).toHaveLength(1);
  const summary = first || second;
  expect(summary).toMatchObject({ games: 2, wins: 1, losses: 1, endedBy: "manual" });
  const doc = await h.db.streamSessions.findOne({ userId: "u_eve", streamId: summary.id });
  expect(doc).toMatchObject({ randomizer: { games: 1, wins: 0, losses: 1 }, crystalBall: { rounds: 1, picks: 2, correct: 1, viewers: 2, accuracy: null },
    supporters: { events: 1, viewers: 1, top: [1] }, bestWin: { opponentMmr: 4300, matchup: "PvT" } });
  expect(doc.crystalBall.top).toEqual([{ picks: 1, correct: 1 }, { picks: 1, correct: 0 }]);
  expect(doc.clips).toEqual([{ kind: "game-event", minute: 60, offsetSec: 3600, reason: "First game won" }]);
  expect(JSON.stringify(doc)).not.toMatch(/SecretOppZed|ViewerOne|ViewerTwo|Private Dock note/);
  expect(Buffer.byteLength(JSON.stringify(doc))).toBeLessThanOrEqual(5120);
  expect(await h.db.notifications.countDocuments({ userId: "u_eve", kind: "report.stream" })).toBe(1);
  expect((await get("eve", "/v1/reports/streams")).body.items[0]).toMatchObject({ id: summary.id, games: 2 });
  expect((await get("eve", `/v1/reports/streams/${summary.id}`)).body).toMatchObject({ streamId: summary.id, games: 2 });
  expect((await get("bob", `/v1/reports/streams/${summary.id}`)).status).toBe(404);
  expect(await streams.end("u_eve")).toBeNull();
  const vodPath = `/v1/reports/streams/${summary.id}/vod`;
  const attach = (name, url) => request(h.app).put(vodPath).set("authorization", h.bearer(name)).send({ url });
  await attach("bob", "https://www.twitch.tv/videos/42").expect(404);
  await attach("eve", "https://wrong.example/video/42").expect(400);
  expect((await attach("eve", "https://www.twitch.tv/videos/42?t=10m&tracking=private").expect(200)).body).toEqual({ vodUrl: "https://www.twitch.tv/videos/42" });
  expect((await get("eve", `/v1/reports/streams/${summary.id}`)).body.vodUrl).toBe("https://www.twitch.tv/videos/42");
  expect((await attach("eve", null).expect(200)).body).toEqual({ vodUrl: null });
  const { privateSearchHttpOptions } = require("../src/middleware/privateSearchTelemetry");
  expect(privateSearchHttpOptions().ignoreIncomingRequestBody(vodPath)).toBe(true);
});

test("stream reports: four quiet hours close a stream, the newest 100 are kept, and opting out stores nothing", async () => {
  const streams = h.services.streamReports;
  const now = Date.now();
  await h.db.streamSessions.insertMany(Array.from({ length: KEEP }, (_, i) => ({ userId: "u_fay", streamId: `old${String(i).padStart(4, "0")}`, startAt: new Date(now - (200 - i) * 86400_000), endAt: new Date(now - (200 - i) * 86400_000), games: 1 })));
  await h.db.games.insertOne(game("u_fay", now - 3 * HOUR));
  await streams.start("u_fay", now - 6 * HOUR);
  await h.db.games.insertOne(game("u_hal", now - HOUR));
  await streams.start("u_hal", now - 2 * HOUR);
  expect((await streams.closeIdle()).closed).toBe(0); // fay's stream began 6 h ago, but his last game was 3 h ago
  streams.now = () => now + 2 * HOUR;
  expect((await streams.closeIdle()).closed).toBe(1); // five quiet hours for fay, three for hal
  streams.now = Date.now;
  expect(await h.db.streamSessions.countDocuments({ userId: "u_fay" })).toBe(KEEP);
  expect(await h.db.streamSessions.findOne({ userId: "u_fay", streamId: "old0000" })).toBeNull();
  expect((await h.db.streamSessions.find({ userId: "u_fay" }).sort({ startAt: -1 }).limit(1).next()).endedBy).toBe("idle");
  expect((await h.db.users.findOne({ userId: "u_hal" })).streamSession).toBeTruthy();
  await h.db.users.updateOne({ userId: "u_hal" }, { $set: { "preferences.reports": { stream: false } } });
  expect(await streams.end("u_hal")).toBeNull();
  expect((await h.db.users.findOne({ userId: "u_hal" })).streamSession).toBeUndefined();
  expect(await h.db.streamSessions.countDocuments({ userId: "u_hal" })).toBe(0);
});

test("stream closure survives a failed build and a failed notification without changing its original end", async () => {
  await h.seedUser("ivy");
  const streams = h.services.streamReports;
  const end = Date.now();
  await h.db.games.insertOne(game("u_ivy", end - 30 * 60_000));
  await streams.start("u_ivy", end - HOUR);
  const build = jest.spyOn(streams, "build").mockRejectedValueOnce(new Error("read failed"));
  streams.now = () => end;
  try {
    await expect(streams.end("u_ivy")).rejects.toThrow("read failed");
    const pending = await h.db.streamSessions.findOne({ userId: "u_ivy" });
    expect(pending).toMatchObject({ reportState: "building", endAt: new Date(end), endedBy: "manual" });
    expect((await get("ivy", "/v1/reports/streams")).body.items).toEqual([]);
    await get("ivy", `/v1/reports/streams/${pending.streamId}`).expect(404);

    const notify = jest.spyOn(h.services.notifications, "notify").mockRejectedValueOnce(new Error("notice failed"));
    streams.now = () => end + 60_000;
    try {
      expect((await streams.closeIdle()).closed).toBe(0);
      expect(await h.db.streamSessions.findOne({ userId: "u_ivy" })).toMatchObject({ reportState: "notifying", games: 1, endAt: new Date(end) });
      expect((await streams.closeIdle()).closed).toBe(1);
      expect((await streams.closeIdle()).closed).toBe(0);
    } finally { notify.mockRestore(); }
    expect(build).toHaveBeenCalledTimes(2);
    expect(await h.db.notifications.countDocuments({ userId: "u_ivy", kind: "report.stream" })).toBe(1);
    expect((await get("ivy", `/v1/reports/streams/${pending.streamId}`)).body).toMatchObject({ games: 1, endAt: new Date(end).toISOString() });
  } finally {
    streams.now = Date.now;
    build.mockRestore();
  }
});

test("publishes only an opted-in aggregate report and invalidates the old address after opt-out or deletion", async () => {
  const name = "publicstream";
  const userId = "u_publicstream";
  const slug = "stream-player-0123456789";
  const streamId = "sample01";
  await h.seedUser(name, { displayName: "Stream Player" });
  await h.db.streamSessions.insertOne({
    userId, streamId, games: 3, wins: 2, losses: 1, hours: 1.5, startAt: new Date("2026-11-10T22:42:31.000Z"),
    endAt: new Date("2026-11-11T00:12:31.000Z"), createdAt: new Date(), bestWin: { gameId: "private-game-id", opponentMmr: 4242 },
    matchups: [{ name: "PvZ", games: 3, wins: 2, losses: 1 }, { name: "SecretOppZed", games: 1 }],
    mmr: { delta: 22, account: "Private account" }, clips: [{ minute: 5, reason: "Viewer private message" }],
  });
  const publishPath = `/v1/reports/streams/${streamId}/sharing`;
  const publish = (enabled, actor = name) => request(h.app).patch(publishPath).set("authorization", h.bearer(actor)).send({ enabled });
  const pref = (stream) => request(h.app).put("/v1/me/preferences/reports").set("authorization", h.bearer(name)).send({ stream });
  await request(h.app).patch(publishPath).send({ enabled: true }).expect(401);
  await publish(true, "bob").expect(404);
  await publish(true).expect(409);
  await h.db.users.updateOne({ userId }, { $set: { publicProfile: { enabled: true }, replaySharing: { slug, enabled: false } } });
  const [first, repeated] = await Promise.all([publish(true).expect(200), publish(true).expect(200)]);
  expect(first.body).toEqual(repeated.body);
  expect(first.body.href).toMatch(/^\/players\/stream-player-0123456789\/streams\/[\w-]{16}$/);
  expect(first.body.href).not.toContain(streamId);
  const address = `/v1/public${first.body.href}`;
  const shared = await request(h.app).get(address).expect(200);
  expect(shared.headers["cache-control"]).toBe("private, no-store");
  expect(shared.body).toEqual({ player: "Stream Player", slug, date: "2026-11-10", games: 3, wins: 2, losses: 1, hours: 1.5, mmrDelta: 22,
    matchups: [{ name: "PvZ", games: 3, wins: 2, losses: 1 }] });
  expect(shared.text).not.toMatch(/private-game-id|Private account|Viewer private message|SecretOppZed|22:42:31|4242/);

  await pref(false).expect(200);
  await request(h.app).get(address).expect(404);
  await pref(true).expect(200);
  await request(h.app).get(address).expect(404);
  const again = await publish(true).expect(200);
  expect(again.body.href).not.toBe(first.body.href);
  const next = `/v1/public${again.body.href}`;
  await request(h.app).get(next).expect(200);
  const { SECTION_KEYS } = require("../src/util/publicPlayerConfig");
  const sections = Object.fromEntries(SECTION_KEYS.map((key) => [key, false]));
  const profile = (enabled, revision) => request(h.app).put("/v1/me/public-profile").set("authorization", h.bearer(name)).send({ enabled, revision, slug, ...sections });
  await profile(false, 0).expect(200);
  await request(h.app).get(next).expect(404);
  await profile(true, 1).expect(200);
  await request(h.app).get(next).expect(404);
  const renewed = `/v1/public${(await publish(true).expect(200)).body.href}`;
  await request(h.app).get(renewed).expect(200);
  await publish(false).expect(200);
  await request(h.app).get(renewed).expect(404);
  const deletion = `/v1/public${(await publish(true).expect(200)).body.href}`;
  await h.db.users.updateOne({ userId }, { $set: { _gdprMutation: { id: "deleting" } } });
  await request(h.app).get(deletion).expect(404);
  await h.db.users.deleteOne({ userId });
  await request(h.app).get(deletion).expect(404);
});

test("Today links the last completed report Monday through Wednesday in the saved time zone", () => {
  const { todayReportWeek } = require("../src/services/reportPreferences");
  const wednesdayUtc = Date.parse("2026-11-12T02:00:00.000Z");
  const newYork = { timezone: "America/New_York" };
  expect(todayReportWeek(newYork, wednesdayUtc)).toBe("2026-W45");
  expect(todayReportWeek({ timezone: "UTC" }, wednesdayUtc)).toBeNull();
  expect(todayReportWeek({ ...newYork, weekly: false }, wednesdayUtc)).toBeNull();
});
