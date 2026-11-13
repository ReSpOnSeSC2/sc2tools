// @ts-nocheck
"use strict";

const request = require("supertest");
const { createHash } = require("node:crypto");

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const { createHarness } = require("./helpers/reviewsHarness");
const { DiscordWebhooksService } = require("../src/services/discordWebhooks");

const KEY = "ab".repeat(32);
const TOKEN = "Zx9-".repeat(17);
const URL_A = `https://discord.com/api/webhooks/123456789012345678/${TOKEN}`;
const hookUrl = (id) => `https://discord.com/api/webhooks/${id}/${TOKEN}`;
let h; let discord; let calls; let responses;
let seq = 0;

const as = (name) => ({
  get: (path) => request(h.app).get(path).set("authorization", h.bearer(name)),
  post: (path, body) => request(h.app).post(path).set("authorization", h.bearer(name)).send(body),
  patch: (path, body) => request(h.app).patch(path).set("authorization", h.bearer(name)).send(body),
});
function game(userId, extra = {}) {
  seq += 1;
  return { userId, gameId: `dg${seq}`, date: new Date(Date.now() - 60_000), createdAt: new Date(), result: "Victory", myRace: "Protoss", map: "Alcyone LE", myBuild: "Stargate",
    isLadderGame: true, matchFormat: "1v1", myMmr: 4000, myMmrSource: "replay", myToonHandle: "1-S2-1-1", durationSec: 700,
    opponent: { race: "Zerg", mmr: 3990, mmrSource: "replay", displayName: "SecretOppZed" }, ...extra };
}
async function queueFixtureGame(userId, row) {
  const filter = { userId, gameId: row.gameId };
  const result = await h.db.games.updateOne(filter, { $setOnInsert: row }, { upsert: true });
  try { await discord.onFreshGame(userId, { gameId: row.gameId, isLadderGame: row.isLadderGame }); }
  finally { if (result.upsertedCount) await h.db.games.deleteOne(filter); }
}
async function connected(name) {
  const created = await as(name).post("/v1/me/integrations/discord/hooks", { url: URL_A, label: "Clan chat" });
  await as(name).post(`/v1/me/integrations/discord/hooks/${created.body.id}/preview`, {});
  await as(name).patch(`/v1/me/integrations/discord/hooks/${created.body.id}`, { enabled: true }).expect(200);
  return created.body.id;
}

beforeAll(async () => {
  h = await createHarness({ config: { delivery: { webPush: null, discordEncryptionKey: KEY } } });
  for (const name of ["ann", "bob", "cat", "dee", "eve"]) await h.seedUser(name);
  discord = h.services.discordWebhooks;
  discord.fetchImpl = jest.fn(async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift() || { status: 204 };
    return { status: next.status, json: async () => next.body || null, headers: { get: () => null } };
  });
});
beforeEach(async () => {
  calls = []; responses = [];
  discord.now = Date.now; discord.lastTest.clear();
  await h.db.discordOutbox.deleteMany({});
  await h.db.games.deleteMany({});
});
afterAll(async () => { await h.close(); });

test("without the encryption key Discord is unavailable and nothing can be stored", async () => {
  const off = new DiscordWebhooksService(h.db, {});
  expect(off.available).toBe(false);
  expect(await off.list("u_ann")).toEqual({ available: false, privateEmbeds: true, maxHooks: 3, hooks: [] });
  await expect(off.create("u_ann", { url: URL_A })).rejects.toMatchObject({ status: 503 });
  expect(await off.drain()).toEqual({ sent: 0 });
});

test("connecting validates the URL strictly, stores it encrypted and never shows, logs or exports it", async () => {
  for (const url of ["https://evil.test/api/webhooks/1/x", `http://discord.com/api/webhooks/123456/${TOKEN}`, `https://discord.com/api/webhooks/123456/${TOKEN}?x=1`]) {
    const bad = await as("ann").post("/v1/me/integrations/discord/hooks", { url });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain(TOKEN);
  }
  const created = await as("ann").post("/v1/me/integrations/discord/hooks", { url: URL_A, label: "Clan chat" });
  expect(created.body).toMatchObject({ label: "Clan chat", last4: TOKEN.slice(-4), enabled: false, previewed: false, events: { result: true, session: true, weekly: true, milestone: true },
    options: { opponentNames: false, mmr: false, replayLink: false } });
  const stored = await h.db.discordHooks.findOne({ _id: created.body.id });
  expect(stored.enc).toMatchObject({ v: 1 });
  for (const value of [created.text, (await as("ann").get("/v1/me/integrations/discord")).text, JSON.stringify(stored), JSON.stringify(await h.services.gdpr.export("u_ann"))]) {
    expect(value).not.toContain(TOKEN.slice(0, 20));
  }
  const exported = (await h.services.gdpr.export("u_ann")).data.discordHooks[0];
  expect(exported).toMatchObject({ last4: TOKEN.slice(-4), label: "Clan chat" });
  expect(exported).not.toHaveProperty("connectIdentity");
  expect(exported).not.toHaveProperty("connectSlot");
  await as("ann").post("/v1/me/integrations/discord/hooks", { url: hookUrl(12345) }).expect(200);
  await as("ann").post("/v1/me/integrations/discord/hooks", { url: hookUrl(12346) }).expect(200);
  expect((await as("ann").post("/v1/me/integrations/discord/hooks", { url: hookUrl(12347) })).body.error.code).toBe("discord_hook_limit");
  const retry = await as("ann").post("/v1/me/integrations/discord/hooks", { url: URL_A, label: "Changed label" }).expect(200);
  expect(retry.body).toMatchObject({ id: created.body.id, label: "Clan chat" });
});

test("concurrent connects keep one hook per Discord webhook and at most three slots", async () => {
  const userId = await h.seedUser("discordconnect");
  const name = "discordconnect";
  const path = "/v1/me/integrations/discord/hooks";
  const twins = await Promise.all([
    as(name).post(path, { url: URL_A }),
    as(name).post(path, { url: URL_A.replace("discord.com", "ptb.discordapp.com") }),
  ]);
  expect(twins.map(res => res.status)).toEqual([200, 200]);
  expect(new Set(twins.map(res => res.body.id)).size).toBe(1);
  await h.db.discordHooks.updateOne({ userId }, { $unset: { connectIdentity: "", connectSlot: "" } });
  const legacy = await as(name).post(path, { url: URL_A }).expect(200);
  expect(legacy.body.id).toBe(twins[0].body.id);
  const distinct = await Promise.all([12345, 12346, 12347].map(id => as(name).post(path, { url: hookUrl(id) })));
  expect(distinct.map(res => res.status).sort()).toEqual([200, 200, 409]);
  expect(await h.db.discordHooks.countDocuments({ userId })).toBe(3);
});

test("same-owner Agent credentials cannot mutate Discord disclosure or send a test", async () => {
  const userId = await h.seedUser("discorddevice");
  const id = await connected("discorddevice");
  const token = `sc2d_${"d".repeat(43)}`;
  await h.db.deviceTokens.insertOne({ userId, tokenHash: createHash("sha256").update(token).digest("hex"), revokedAt: null });
  const path = `/v1/me/integrations/discord/hooks/${id}`;
  const auth = `Bearer ${token}`;
  const blocked = await request(h.app).patch(path).set("authorization", auth).send({ shareMmr: true, events: { ladderMilestone: true } }).expect(403);
  expect(blocked.body.error.code).toBe("browser_session_required");
  await request(h.app).post(`${path}/test`).set("authorization", auth).expect(403);
  const saved = await h.db.discordHooks.findOne({ _id: id });
  expect(saved.mmrConsent).toBeUndefined();
  expect(saved.events.ladderMilestone).toBe(false);
  expect(calls).toHaveLength(0);
});

test("a channel turns on only after its posts were previewed; previews hide opponent names by default", async () => {
  const created = await as("bob").post("/v1/me/integrations/discord/hooks", { url: URL_A });
  const path = `/v1/me/integrations/discord/hooks/${created.body.id}`;
  expect((await as("bob").patch(path, { enabled: true })).body.error.code).toBe("preview_required");
  await h.db.games.insertOne(game("u_bob"));
  const preview = await as("bob").post(`${path}/preview`, {});
  expect(preview.body.previews.map((row) => row.kind)).toEqual(["result", "session", "weekly", "milestone", "ladderMilestone"]);
  expect(JSON.stringify(preview.body)).not.toContain("SecretOppZed");
  expect(preview.body.previews[0].payload.allowed_mentions).toEqual({ parse: [] });
  expect((await as("bob").patch(path, { enabled: true })).body).toMatchObject({ enabled: true, previewed: true });
  await as("bob").patch(path, { options: { opponentNames: true } }).expect(200);
  await h.db.discordHooks.updateOne({ _id: created.body.id }, { $set: { "options.opponentNames": true, "options.mmr": true } });
  const legacy = await as("bob").post(`${path}/preview`, { kind: "result" });
  expect(JSON.stringify(legacy.body)).not.toMatch(/SecretOppZed|4,000|3,990|Alcyone|Stargate/);
  const oldWrite = await as("bob").patch(path, { options: { mmr: true } }).expect(200);
  expect(oldWrite.body.options.mmr).toBe(false);
  const enabled = await as("bob").patch(path, { shareMmr: true }).expect(200);
  expect(enabled.body.options.mmr).toBe(true);
  const optedIn = await as("bob").post(`${path}/preview`, { kind: "result" });
  expect(JSON.stringify(optedIn.body)).toContain("4,000");
  expect(JSON.stringify(optedIn.body)).not.toMatch(/SecretOppZed|3,990/);
  const oldOff = await as("bob").patch(path, { options: { mmr: false } }).expect(200);
  expect(oldOff.body.options.mmr).toBe(false);
  expect((await as("bob").post(`${path}/preview`, { kind: "nope" })).status).toBe(400);
  expect((await as("ann").patch(path, { enabled: false })).status).toBe(404);
});

test("send test posts immediately to the decrypted webhook, once per half minute", async () => {
  const created = await as("cat").post("/v1/me/integrations/discord/hooks", { url: URL_A });
  expect((await as("cat").post(`/v1/me/integrations/discord/hooks/${created.body.id}/test`, {})).body).toEqual({ result: "sent" });
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe(URL_A);
  expect(calls[0].init).toMatchObject({ method: "POST", redirect: "error" });
  expect(JSON.parse(calls[0].init.body).allowed_mentions).toEqual({ parse: [] });
  expect((await as("cat").post(`/v1/me/integrations/discord/hooks/${created.body.id}/test`, {})).status).toBe(429);
});

test("a ranked result is queued once, sent by the drain, and casual games are ignored", async () => {
  await connected("dee");
  const ranked = game("u_dee");
  await queueFixtureGame("u_dee", ranked);
  await queueFixtureGame("u_dee", ranked);
  await queueFixtureGame("u_dee", game("u_dee", { isLadderGame: false }));
  expect(await h.db.discordOutbox.countDocuments({ userId: "u_dee", kind: "result" })).toBe(1);
  expect(await discord.drain()).toEqual({ sent: 1, retried: 0, dropped: 0 });
  expect(JSON.stringify(JSON.parse(calls[0].init.body))).not.toContain("SecretOppZed");
  expect(await h.db.discordOutbox.findOne({ userId: "u_dee" })).toMatchObject({ status: "sent" });
  expect(await h.db.discordOutbox.findOne({ userId: "u_dee", payload: { $exists: true } })).toBeNull();
  await queueFixtureGame("u_dee", ranked);
  expect((await discord.drain()).sent).toBe(0);
  expect(calls).toHaveLength(1);
  expect((await h.db.discordHooks.findOne({ userId: "u_dee" })).lastPostAt).toBeInstanceOf(Date);
});

test("5xx backs off exponentially, 429 honours retry_after, and a post gives up after five attempts", async () => {
  const hookId = (await h.db.discordHooks.findOne({ userId: "u_dee" }))._id;
  const t0 = Date.now(); discord.now = () => t0;
  await discord.enqueue("u_dee", "result", "manual-1", () => ({ content: "x" }));
  responses = [{ status: 502 }];
  expect((await discord.drain()).retried).toBe(1);
  let row = await h.db.discordOutbox.findOne({ hookId });
  expect([row.attempts, row.nextAttemptAt.getTime() - t0]).toEqual([1, 30_000]);
  discord.now = () => t0 + 31_000;
  responses = [{ status: 429, body: { retry_after: 120 } }];
  await discord.drain();
  row = await h.db.discordOutbox.findOne({ hookId });
  expect([row.attempts, row.nextAttemptAt.getTime() - (t0 + 31_000)]).toEqual([2, 120_000]);
  for (let attempt = 3; attempt <= 5; attempt += 1) {
    discord.now = () => t0 + attempt * 3_600_000;
    responses = [{ status: 503 }];
    await discord.drain();
  }
  expect((await h.db.discordOutbox.findOne({ hookId })).status).toBe("failed");
});

test("three consecutive 401/404 answers disable the hook and tell its owner", async () => {
  const hookId = await connected("eve");
  for (const key of ["a", "b", "c"]) await discord.enqueue("u_eve", "result", key, () => ({ content: key }));
  responses = [{ status: 404 }, { status: 401 }, { status: 404 }];
  await discord.drain();
  expect(await h.db.discordHooks.findOne({ _id: hookId })).toMatchObject({ status: "disabled", enabled: false, disabledReason: "webhook_gone", failureCount: 3 });
  expect(await h.db.notifications.countDocuments({ userId: "u_eve", kind: "integration.discord_disabled" })).toBe(1);
  expect(await discord.enqueue("u_eve", "result", "after", () => ({}))).toBe(0);
});

const battleReport = { headline: "A comeback on Alcyone", paragraph: "Down 20 supply at 8:00, even by 11:00." };

async function prepareBattleReport(token) {
  const hook = await h.db.discordHooks.findOne({ userId: "u_dee" });
  const path = `/v1/me/integrations/discord/hooks/${hook._id}`;
  const ranked = game("u_dee");
  await h.db.games.insertOne(ranked);
  await h.db.gameShares.insertOne({ _id: token, userId: "u_dee", gameId: ranked.gameId, revokedAt: null });
  return { path, send: `${path}/battle-report` };
}

test("only an explicitly reviewed, owned report and opted-in channel can queue a canonical link", async () => {
  const token = "BattleReport1111";
  const { path, send } = await prepareBattleReport(token);
  const body = { token, headline: "SecretOppZed", paragraph: "SecretOppZed has 3990 MMR", url: "https://other.example/", gameId: "ignore" };
  await request(h.app).post(send).send(body).expect(401);
  await as("bob").post(send, body).expect(404);
  await as("dee").post(send, body).expect(409);
  await as("dee").patch(path, { options: { replayLink: true } }).expect(200);
  await as("dee").post(send, { token: "invalid token" }).expect(400);
  await as("dee").post(send, { ...body, token: "BattleReport2222" }).expect(404);
  expect((await as("dee").post(send, body).expect(200)).body).toEqual({ queued: 1 });
  expect(calls).toHaveLength(0);
  expect((await discord.drain()).sent).toBe(1);
  const message = JSON.parse(calls[0].init.body);
  expect(message.embeds[0]).toMatchObject({
    title: "Shared StarCraft II battle report", description: "Open the report to see the anonymized analysis.", url: `https://sc2tools.com/g/${token}#battle-report`,
  });
  expect(JSON.stringify(message)).not.toMatch(/SecretOppZed|other\.example|ignore/);
  expect((await as("dee").post(send, body).expect(200)).body).toEqual({ queued: 0 });
});

test("revoking a share or withdrawing channel consent blocks queued posts and scrubs their payloads", async () => {
  const token = "BattleReport3333";
  const { path, send } = await prepareBattleReport(token);
  await as("dee").patch(path, { options: { replayLink: true, opponentNames: true }, shareMmr: true }).expect(200);
  await as("dee").post(send, { token, ...battleReport }).expect(200);
  await queueFixtureGame("u_dee", game("u_dee"));
  await h.db.gameShares.updateOne({ _id: token }, { $set: { revokedAt: new Date() } });
  expect(await discord.deliverRow(await h.db.discordOutbox.findOne({ shareToken: token }))).toBe("dropped");
  await as("dee").patch(path, { shareMmr: false }).expect(200);
  expect((await discord.drain()).dropped).toBe(1);
  expect(calls).toHaveLength(0);
  expect(await h.db.discordOutbox.countDocuments({ userId: "u_dee", status: "dropped", payload: { $exists: false } })).toBe(2);
});

test("nothing is posted while the account is being erased", async () => {
  await discord.enqueue("u_dee", "result", "erasing", () => ({ content: "x" }));
  await h.db.users.updateOne({ userId: "u_dee" }, { $set: { _gdprMutation: { id: "x" } } });
  expect((await discord.drain()).dropped).toBe(1);
  expect(calls).toHaveLength(0);
  await h.db.users.updateOne({ userId: "u_dee" }, { $unset: { _gdprMutation: "" } });
});

test("session summaries post once after the session gap, peaks only above a 20-game history", async () => {
  const now = Date.now();
  await h.db.discordHooks.updateOne({ userId: "u_dee" }, { $set: { enabledAt: new Date(now - 6 * 3600_000) } });
  await h.db.games.insertMany([0, 1, 2].map((i) => game("u_dee", { date: new Date(now - (4 - i * 0.5) * 3600_000), myMmr: 4000 + i })));
  expect((await discord.sweepSessions()).queued).toBe(1);
  expect((await discord.sweepSessions()).queued).toBe(0);
  const posted = await h.db.discordOutbox.findOne({ userId: "u_dee", kind: "session" });
  expect(JSON.stringify(posted.payload)).toContain("3–0 in 3 games");
  expect((await discord.drain()).sent).toBe(1);
  expect((await discord.sweepSessions()).queued).toBe(0);
  await h.db.games.insertMany(Array.from({ length: 20 }, (_, i) => game("u_dee", { date: new Date(now - (40 + i) * 3600_000), myMmr: 4050 + i })));
  await queueFixtureGame("u_dee", game("u_dee", { myMmr: 4060 }));
  expect(await h.db.discordOutbox.countDocuments({ userId: "u_dee", kind: "milestone" })).toBe(0);
  const peak = game("u_dee", { myMmr: 4100 });
  await h.db.games.insertOne(peak);
  await queueFixtureGame("u_dee", peak);
  expect(await h.db.discordOutbox.countDocuments({ userId: "u_dee", kind: "milestone" })).toBe(1);
});


async function promotionRecipient(name) {
  await h.seedUser(name);
  await connected(name);
  return "u_" + name;
}

test("promotion uses observed ranks from the same ladder queue and respects hook privacy", async () => {
  const userId = await promotionRecipient("rankup");
  const date = Date.now() - 60_000;
  const ranked = { matchFormat: "1v1", myLadderRace: "Random", myMmr: 4700, date: new Date(date) };
  await h.db.discordHooks.updateOne({ userId }, { $set: { "options.mmr": false, "options.replayLink": true, "options.opponentNames": true } });
  await h.db.games.insertMany([
    game(userId, { ...ranked, date: new Date(date - 120_000), myRace: "Terran", myLeagueId: 4 }),
    game(userId, { ...ranked, date: new Date(date - 60_000), myLadderRace: "Protoss", myLeagueId: 6 }),
  ]);
  const current = game(userId, { ...ranked, myLeagueId: 5 });
  await queueFixtureGame(userId, current);
  const filter = { userId, kind: "milestone" };
  const row = await h.db.discordOutbox.findOne(filter);
  expect(row.payload.embeds[0]).toMatchObject({ title: "Promotion · Master", description: "Diamond → Master · Random", fields: [] });
  expect(row.payload.allowed_mentions).toEqual({ parse: [] });
  expect(JSON.stringify(row.payload)).not.toMatch(/SecretOppZed|4700|https:/);
  await discord.drain();
  expect(await h.db.discordOutbox.findOne(filter)).toMatchObject({ status: "sent" });
  expect((await h.db.discordOutbox.findOne(filter)).payload).toBeUndefined();
  await queueFixtureGame(userId, current);
  expect(await h.db.discordOutbox.countDocuments(filter)).toBe(1);
  expect(await h.db.discordOutbox.countDocuments({ ...filter, status: "queued" })).toBe(0);
});

test("promotion is skipped for an unrated observation gap, another account, or a downward change", async () => {
  const userId = await promotionRecipient("ranksame");
  const date = Date.now() - 60_000;
  const ranked = { matchFormat: "1v1", date: new Date(date), myMmr: 6000 };
  await h.db.games.insertMany([
    game(userId, { ...ranked, date: new Date(date - 120_000), myLeagueId: 3 }),
    game(userId, { ...ranked, date: new Date(date - 60_000) }),
    game(userId, { ...ranked, date: new Date(date - 60_000), myLeagueId: 6, myToonHandle: "1-S2-1-2" }),
  ]);
  await queueFixtureGame(userId, game(userId, { ...ranked, myLeagueId: 5 }));
  await queueFixtureGame(userId, game(userId, { ...ranked, myLeagueId: 5, myToonHandle: "1-S2-1-2" }));
  await queueFixtureGame(userId, game(userId, { ...ranked, myLeagueId: 5, myToonHandle: "1-S2-1-3" }));
  expect(await h.db.discordOutbox.countDocuments({ userId, kind: "milestone" })).toBe(0);
});

test("stored ladder bell headlines require separate opt-in and still honor mutes at dispatch", async () => {
  const userId = await promotionRecipient("ladderbell");
  const hook = await h.db.discordHooks.findOne({ userId });
  const path = `/v1/me/integrations/discord/hooks/${hook._id}`;
  const milestone = { kind: "moment.crossed_mmr_mark", title: "Recorded 5000 MMR", body: "SecretOppZed", href: "/app/game/private-id", eventKey: "milestone-1" };
  const notifications = h.services.notifications;
  const sink = jest.spyOn(discord, "onLadderMilestone");
  const owner = { userId };
  try {
    await notifications.notify(userId, milestone);
    expect(sink).not.toHaveBeenCalled();
    await h.db.users.updateOne(owner, { $set: { "preferences.notifications.milestones": true } });
    await notifications.notify(userId, milestone);
    await sink.mock.results.at(-1).value;
    expect(await h.db.discordOutbox.countDocuments(owner)).toBe(0);

    await as("ladderbell").patch(path, { events: { ladderMilestone: true } }).expect(200);
    await notifications.notify(userId, { ...milestone, title: "Private headline", eventKey: "milestone-2" });
    await sink.mock.results.at(-1).value;
    expect(await h.db.discordOutbox.countDocuments(owner)).toBe(0);

    await notifications.notify(userId, { ...milestone, eventKey: "milestone-3" });
    await sink.mock.results.at(-1).value;
    await notifications.notify(userId, { ...milestone, eventKey: "milestone-3" });
    const queued = await h.db.discordOutbox.findOne(owner);
    expect(await h.db.discordOutbox.countDocuments(owner)).toBe(1);
    expect(queued).toMatchObject({ kind: "ladderMilestone", payload: { embeds: [{ title: "Recorded rating milestone" }] } });
    expect(JSON.stringify(queued.payload)).not.toMatch(/SecretOppZed|5000|private-id/);
    await h.db.users.updateOne(owner, { $set: { "preferences.notifications.muted": [milestone.kind] } });
    expect(await discord.deliverRow(queued)).toBe("dropped");
    expect(calls).toHaveLength(0);
  } finally { sink.mockRestore(); }
});

test("weekly Discord receipts prevent replay after the first post was drained", async () => {
  const userId = await promotionRecipient("weeklyreceipt");
  const report = { week: "2026-W46", totals: { games: 5, wins: 3, losses: 2, hours: 2, sessions: 1 } };
  await discord.onWeekly(userId, report);
  expect((await discord.drain()).sent).toBe(1);
  await discord.onWeekly(userId, report);
  expect((await discord.drain()).sent).toBe(0);
  const receipt = await h.db.discordOutbox.findOne({ userId, kind: "weekly" });
  expect(receipt.status).toBe("sent");
  expect(receipt.payload).toBeUndefined();
  expect(receipt.expiresAt).toBeInstanceOf(Date);
});

test("retries a failed Discord enqueue from the stored bell row without repeating socket or push delivery", async () => {
  const name = "discordsinkretry";
  const userId = await promotionRecipient(name);
  const hook = await h.db.discordHooks.findOne({ userId });
  await as(name).patch(`/v1/me/integrations/discord/hooks/${hook._id}`, { events: { ladderMilestone: true } }).expect(200);
  await h.db.users.updateOne({ userId }, { $set: { "preferences.notifications.milestones": true } });
  const notifications = h.services.notifications;
  const socket = jest.spyOn(notifications, "_push");
  const push = jest.spyOn(notifications.push, "deliver");
  const insert = jest.spyOn(h.db.discordOutbox, "insertOne").mockRejectedValueOnce(new Error("fixture lost outbox write"));
  const input = { kind: "moment.win_streak", title: "5 wins in a row", eventKey: "stored-streak" };
  try {
    await expect(notifications.notify(userId, input)).rejects.toThrow("fixture lost outbox write");
    expect(await h.db.notifications.countDocuments({ userId, discordPending: true })).toBe(1);
    expect(await h.db.discordOutbox.countDocuments({ userId })).toBe(0);
    await expect(notifications.notify(userId, { ...input, title: "10 wins in a row" })).resolves.toBeNull();
    await expect(notifications.notify(userId, input)).resolves.toBeNull();
    expect(await h.db.notifications.countDocuments({ userId })).toBe(1);
    expect(await h.db.notifications.countDocuments({ userId, discordPending: true })).toBe(0);
    expect(await h.db.discordOutbox.countDocuments({ userId })).toBe(1);
    expect(await h.db.discordOutbox.findOne({ userId })).toMatchObject({ payload: { embeds: [{ title: "5 wins in a row" }] } });
    expect(socket).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledTimes(2);
  } finally { socket.mockRestore(); push.mockRestore(); insert.mockRestore(); }
});


test("ranked ingest uses committed eligibility and excludes raw build names and private ratings", async () => {
  const userId = await promotionRecipient("rankupload");
  const date = Date.now() - 30_000;
  const prior = game(userId, { date: new Date(date - 60_000), matchFormat: "1v1", myLeagueId: 4 });
  await h.db.games.insertOne(prior);
  const incoming = game(userId, { date: new Date(date), matchFormat: "1v1", myLeagueId: 5, myMmrSource: "replay" });
  delete incoming.userId;
  delete incoming.createdAt;
  const enqueue = jest.spyOn(discord, "onFreshGame");
  const bind = jest.spyOn(h.services.buildIntents, "bindIngestedGame").mockImplementationOnce(async (owner, replay) => {
    await h.db.games.updateOne({ userId: owner, gameId: replay.gameId }, { $set: { myBuild: "Effective opener" } });
  });
  try {
    const response = await as("rankupload").post("/v1/games", { games: [incoming] });
    expect(response.status).toBe(202);
    expect(enqueue).toHaveBeenCalledWith(userId, { gameId: incoming.gameId, isLadderGame: true });
    await enqueue.mock.results[0].value;
    expect(await h.db.games.findOne({ userId, gameId: incoming.gameId })).toMatchObject({ myLeagueId: 5, myBuild: "Effective opener" });
    const result = await h.db.discordOutbox.findOne({ userId, kind: "result" });
    expect(result.payload.embeds[0].fields).toEqual([{ name: "Opponent", value: "Zerg", inline: true }]);
    expect(JSON.stringify(result.payload)).not.toMatch(/SecretOppZed|Effective opener|3,990|4,000/);
    expect(await h.db.discordOutbox.findOne({ userId, kind: "milestone" })).toMatchObject({
      payload: { embeds: [expect.objectContaining({ title: "Promotion · Master", fields: [] })] },
    });
  } finally { bind.mockRestore(); enqueue.mockRestore(); }
});

test("the ingest delivery lookup requires an eligible replay owned by the recipient", async () => {
  const userId = await promotionRecipient("ingestowner");
  const other = game("u_bob");
  const hidden = game(userId, { excluded: true });
  await h.db.games.insertMany([other, hidden]);
  for (const gameId of [other.gameId, hidden.gameId]) await discord.onFreshGame(userId, { gameId, isLadderGame: true });
  expect(await h.db.discordOutbox.countDocuments({ userId })).toBe(0);
});


test("a result or promotion never includes an unproven rating", async () => {
  const userId = await promotionRecipient("ratingprovenance");
  const now = Date.now() - 60_000;
  await h.db.games.insertOne(game(userId, { myLeagueId: 4, date: new Date(now - 60_000) }));
  await queueFixtureGame(userId, game(userId, { myLeagueId: 5, myMmr: 7321, myMmrSource: "unavailable", date: new Date(now),
    opponent: { race: "Zerg", mmr: 7123, mmrSource: "pulse", displayName: "Unverified opponent" } }));
  const rows = await h.db.discordOutbox.find({ userId }).toArray();
  const result = rows.find(row => row.kind === "result").payload.embeds[0];
  expect(result.fields).toContainEqual({ name: "Opponent", value: "Zerg", inline: true });
  expect(result.fields.some(field => field.name === "MMR")).toBe(false);
  const promotion = rows.find(row => row.kind === "milestone").payload.embeds[0];
  expect(promotion).toMatchObject({ title: "Promotion · Master", fields: [] });
  expect(JSON.stringify(rows)).not.toMatch(/7,321|7,123/);
});

test("a ranked result shows its starting rating without a delta and a peak uses matching replay-rated games", async () => {
  const userId = await promotionRecipient("ratingcohort");
  const hook = await h.db.discordHooks.findOne({ userId });
  await as("ratingcohort").patch(`/v1/me/integrations/discord/hooks/${hook._id}`, { shareMmr: true }).expect(200);
  const now = Date.now() - 30_000;
  const historic = Array.from({ length: 19 }, (_, i) => game(userId, {
    date: new Date(now - (i + 3) * 1000), myToonHandle: "1-s2-1-1", myRace: "Terran", myLadderRace: "R", myMmr: 4220 - i,
  }));
  const offQueue = { myRace: "Protoss", myLadderRace: "Random", date: new Date(now - 1000) };
  await h.db.games.insertMany([...historic,
    game(userId, { ...offQueue, myMmr: 8100, myMmrSource: undefined }),
    game(userId, { ...offQueue, myMmr: 8101, myToonHandle: "1-S2-1-2" }),
    game(userId, { ...offQueue, myMmr: 8102, myLadderRace: "Protoss" }),
    game(userId, { ...offQueue, myMmr: 8103, isLadderGame: false }),
    game(userId, { ...offQueue, myMmr: 8104, matchFormat: "2v2", playerCount: 4 }),
    game(userId, { ...offQueue, myMmr: 8105, excluded: true }),
  ]);
  await queueFixtureGame(userId, game(userId, { date: new Date(now), myMmr: 4250, myLadderRace: "Random" }));
  expect(await h.db.discordOutbox.countDocuments({ userId, kind: "milestone" })).toBe(0);
  expect((await h.db.discordOutbox.findOne({ userId, kind: "result" })).payload.embeds[0].fields).toContainEqual({ name: "Recorded starting MMR", value: "4,250", inline: true });
  await h.db.games.insertOne(game(userId, { ...offQueue, date: new Date(now - 2000), myMmr: 4230 }));
  await queueFixtureGame(userId, game(userId, { date: new Date(now), myMmr: 4260, myLadderRace: "rand" }));
  expect((await h.db.discordOutbox.findOne({ userId, kind: "milestone" })).payload.embeds[0]).toMatchObject({
    title: "New Random MMR peak", description: "4,260 MMR (previous best 4,230)",
  });
});

test("retires legacy payloads across kinds and keeps their dedupe receipts without blocking new posts", async () => {
  const userId = await promotionRecipient("legacydiscord");
  for (const kind of ["result", "session", "weekly", "milestone"]) {
    await discord.enqueue(userId, kind, `legacy:${kind}`, () => ({ embeds: [{ title: "SecretOppZed", url: "https://private.test" }] }));
  }
  await h.db.discordOutbox.updateMany({ userId }, { $unset: { embedPolicy: "" } });
  await queueFixtureGame(userId, game(userId));
  expect(await discord.drain()).toMatchObject({ sent: 1, dropped: 4 });
  expect(calls).toHaveLength(1);
  expect(JSON.stringify(JSON.parse(calls[0].init.body))).not.toMatch(/SecretOppZed|private\.test/);
  expect(await h.db.discordOutbox.countDocuments({ userId, status: "dropped", payload: { $exists: false }, dedupeKey: { $exists: true } })).toBe(4);
  expect(await discord.enqueue(userId, "weekly", "legacy:weekly", () => ({}))).toBe(0);
});

async function changeInsideDispatchLease(row, change) {
  const leaseMethod = discord.withLease.bind(discord);
  const spy = jest.spyOn(discord, "withLease").mockImplementationOnce((userId, work) => leaseMethod(userId, async lease => {
    expect((await h.db.users.findOne({ userId }))._dataMutations).not.toHaveLength(0);
    await change();
    return work(lease);
  }));
  try { return await discord.deliverRow(row); } finally { spy.mockRestore(); }
}

test("withdrawn MMR consent retires pending ratings even when opted in again before dispatch", async () => {
  const userId = await promotionRecipient("discordprivacy");
  const hook = await h.db.discordHooks.findOne({ userId });
  const path = `/v1/me/integrations/discord/hooks/${hook._id}`;
  await as("discordprivacy").patch(path, { shareMmr: true }).expect(200);
  await queueFixtureGame(userId, game(userId));
  const queued = await h.db.discordOutbox.findOne({ userId });
  expect(JSON.stringify(queued.payload)).toContain("4,000");
  const outcome = await changeInsideDispatchLease(queued, async () => {
    await as("discordprivacy").patch(path, { shareMmr: false }).expect(200);
    await as("discordprivacy").patch(path, { shareMmr: true }).expect(200);
  });
  expect(outcome).toBe("dropped");
  expect(calls).toHaveLength(0);
  const receipt = await h.db.discordOutbox.findOne({ _id: queued._id });
  expect(receipt).toMatchObject({ status: "dropped", dedupeKey: queued.dedupeKey });
  expect(receipt.payload).toBeUndefined();
});

test("turning a channel off and on retires its prior activation without retiring new posts", async () => {
  const userId = await promotionRecipient("discordactivation");
  const hook = await h.db.discordHooks.findOne({ userId });
  const path = `/v1/me/integrations/discord/hooks/${hook._id}`;
  const first = game(userId);
  await queueFixtureGame(userId, first);
  const queued = await h.db.discordOutbox.findOne({ userId });
  const retired = discord.retireQueued.bind(discord);
  const spy = jest.spyOn(discord, "retireQueued").mockImplementationOnce(async (oldHook) => {
    await as("discordactivation").patch(path, { enabled: true }).expect(200);
    await queueFixtureGame(userId, game(userId));
    return retired(oldHook);
  });
  try { await as("discordactivation").patch(path, { enabled: false }).expect(200); }
  finally { spy.mockRestore(); }
  expect(await h.db.discordOutbox.findOne({ _id: queued._id })).toMatchObject({ status: "dropped", dedupeKey: queued.dedupeKey });
  expect(await h.db.discordOutbox.countDocuments({ userId, status: "queued" })).toBe(1);
  expect((await discord.drain()).sent).toBe(1);
  await queueFixtureGame(userId, first);
  expect(await h.db.discordOutbox.countDocuments({ userId, status: "queued" })).toBe(0);
});

test("automatic results never link the public replay archive, even with link consent", async () => {
  const userId = await promotionRecipient("discordarchive");
  await h.db.discordHooks.updateOne({ userId }, { $set: { "options.replayLink": true } });
  await h.db.users.updateOne({ userId }, { $set: { replaySharing: { enabled: true, slug: "account-replay" } } });
  const row = game(userId, { gameId: "private-game-id" });
  await queueFixtureGame(userId, row);
  const queued = await h.db.discordOutbox.findOne({ userId });
  expect(queued.payload.embeds[0].url).toBeUndefined();
  expect(queued.payload.embeds[0].timestamp).toBeUndefined();
  expect(await discord.deliverRow(queued)).toBe("sent");
  expect(JSON.stringify(JSON.parse(calls[0].init.body))).not.toMatch(/account-replay|private-game-id/);
  expect((await h.db.discordOutbox.findOne({ _id: queued._id })).payload).toBeUndefined();
});

test("a battle report revoked during the game lookup cannot be dispatched", async () => {
  const userId = await promotionRecipient("discordshare");
  const hook = await h.db.discordHooks.findOne({ userId });
  await h.db.discordHooks.updateOne({ userId }, { $set: { "options.replayLink": true } });
  const ranked = game(userId);
  const token = "BattleReport9876";
  await h.db.games.insertOne(ranked);
  await h.db.gameShares.insertOne({ _id: token, userId, gameId: ranked.gameId, revokedAt: null });
  expect(await discord.queueBattleReport(userId, hook._id, { token, ...battleReport })).toEqual({ queued: 1 });
  const queued = await h.db.discordOutbox.findOne({ userId });
  const find = h.db.games.findOne.bind(h.db.games);
  const spy = jest.spyOn(h.db.games, "findOne").mockImplementationOnce(async (filter, options) => {
    const gameRow = await find(filter, options);
    await h.db.gameShares.updateOne({ _id: token }, { $set: { revokedAt: new Date() } });
    return gameRow;
  });
  try { expect(await discord.deliverRow(queued)).toBe("dropped"); } finally { spy.mockRestore(); }
  expect(calls).toHaveLength(0);
  const receipt = await h.db.discordOutbox.findOne({ _id: queued._id });
  expect(receipt).toMatchObject({ status: "dropped", dedupeKey: queued.dedupeKey });
  expect(receipt.shareToken).toBeUndefined();
  expect(receipt.payload).toBeUndefined();
});

test("disabling a channel during the final share read prevents the provider handoff", async () => {
  const name = "discordlateoff";
  const userId = await promotionRecipient(name);
  const hook = await h.db.discordHooks.findOne({ userId });
  const path = `/v1/me/integrations/discord/hooks/${hook._id}`;
  await as(name).patch(path, { options: { replayLink: true } }).expect(200);
  const ranked = game(userId);
  const token = "BattleReport6543";
  await h.db.games.insertOne(ranked);
  await h.db.gameShares.insertOne({ _id: token, userId, gameId: ranked.gameId, revokedAt: null });
  expect(await discord.queueBattleReport(userId, hook._id, { token })).toEqual({ queued: 1 });
  const queued = await h.db.discordOutbox.findOne({ userId });
  const findShare = h.db.gameShares.findOne.bind(h.db.gameShares);
  const read = jest.spyOn(h.db.gameShares, "findOne").mockImplementation(async (filter, options) => {
    const share = await findShare(filter, options);
    if (options?.projection?._id === 1) await as(name).patch(path, { enabled: false }).expect(200);
    return share;
  });
  try { expect(await discord.deliverRow(queued)).toBe("dropped"); } finally { read.mockRestore(); }
  expect(calls).toHaveLength(0);
});
