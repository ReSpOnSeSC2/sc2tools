// @ts-nocheck
"use strict";

const request = require("supertest");

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const { createHarness } = require("./helpers/reviewsHarness");
const { DiscordWebhooksService } = require("../src/services/discordWebhooks");

const KEY = "ab".repeat(32);
const TOKEN = "Zx9-".repeat(17);
const URL_A = `https://discord.com/api/webhooks/123456789012345678/${TOKEN}`;
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
    isLadderGame: true, myMmr: 4000, myToonHandle: "1-S2-1-1", durationSec: 700, opponent: { race: "Zerg", mmr: 3990, displayName: "SecretOppZed" }, ...extra };
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
  expect(await off.list("u_ann")).toEqual({ available: false, maxHooks: 3, hooks: [] });
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
    options: { opponentNames: false, mmr: true, replayLink: false } });
  const stored = await h.db.discordHooks.findOne({ _id: created.body.id });
  expect(stored.enc).toMatchObject({ v: 1 });
  for (const value of [created.text, (await as("ann").get("/v1/me/integrations/discord")).text, JSON.stringify(stored), JSON.stringify(await h.services.gdpr.export("u_ann"))]) {
    expect(value).not.toContain(TOKEN.slice(0, 20));
  }
  expect((await h.services.gdpr.export("u_ann")).data.discordHooks[0]).toMatchObject({ last4: TOKEN.slice(-4), label: "Clan chat" });
  await as("ann").post("/v1/me/integrations/discord/hooks", { url: URL_A }).expect(200);
  await as("ann").post("/v1/me/integrations/discord/hooks", { url: URL_A }).expect(200);
  expect((await as("ann").post("/v1/me/integrations/discord/hooks", { url: URL_A })).body.error.code).toBe("discord_hook_limit");
});

test("a channel turns on only after its posts were previewed; previews hide opponent names by default", async () => {
  const created = await as("bob").post("/v1/me/integrations/discord/hooks", { url: URL_A });
  const path = `/v1/me/integrations/discord/hooks/${created.body.id}`;
  expect((await as("bob").patch(path, { enabled: true })).body.error.code).toBe("preview_required");
  await h.db.games.insertOne(game("u_bob"));
  const preview = await as("bob").post(`${path}/preview`, {});
  expect(preview.body.previews.map((row) => row.kind)).toEqual(["result", "session", "weekly", "milestone"]);
  expect(JSON.stringify(preview.body)).not.toContain("SecretOppZed");
  expect(preview.body.previews[0].payload.allowed_mentions).toEqual({ parse: [] });
  expect((await as("bob").patch(path, { enabled: true })).body).toMatchObject({ enabled: true, previewed: true });
  await as("bob").patch(path, { options: { opponentNames: true } }).expect(200);
  expect(JSON.stringify((await as("bob").post(`${path}/preview`, { kind: "result" })).body)).toContain("SecretOppZed");
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
  await discord.onFreshGame("u_dee", ranked);
  await discord.onFreshGame("u_dee", ranked);
  await discord.onFreshGame("u_dee", game("u_dee", { isLadderGame: false }));
  expect(await h.db.discordOutbox.countDocuments({ userId: "u_dee", kind: "result" })).toBe(1);
  expect(await discord.drain()).toEqual({ sent: 1, retried: 0, dropped: 0 });
  expect(JSON.stringify(JSON.parse(calls[0].init.body))).not.toContain("SecretOppZed");
  expect(await h.db.discordOutbox.countDocuments({})).toBe(0);
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

test("the battle report hook queues one post with only an sc2tools.com link", async () => {
  const report = { gameId: "br-1", headline: "A comeback on Alcyone", paragraph: "Down 20 supply at 8:00, even by 11:00.", url: "https://sc2tools.com/p/me/replays/br-1" };
  expect(await discord.onBattleReport("u_dee", report)).toBe(1);
  expect(await discord.onBattleReport("u_dee", report)).toBe(0);
  const row = await h.db.discordOutbox.findOne({ userId: "u_dee", kind: "result" });
  expect(row.payload.embeds[0]).toMatchObject({ title: "A comeback on Alcyone", url: report.url });
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
  await h.db.games.insertMany(Array.from({ length: 20 }, (_, i) => game("u_dee", { date: new Date(now - (40 + i) * 3600_000), myMmr: 4050 + i })));
  await discord.onFreshGame("u_dee", game("u_dee", { myMmr: 4060 }));
  expect(await h.db.discordOutbox.countDocuments({ userId: "u_dee", kind: "milestone" })).toBe(0);
  const peak = game("u_dee", { myMmr: 4100 });
  await h.db.games.insertOne(peak);
  await discord.onFreshGame("u_dee", peak);
  expect(await h.db.discordOutbox.countDocuments({ userId: "u_dee", kind: "milestone" })).toBe(1);
});
