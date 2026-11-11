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
    isLadderGame: true, matchFormat: "1v1", myMmr: 4000, myMmrSource: "replay", myToonHandle: "1-S2-1-1", durationSec: 700,
    opponent: { race: "Zerg", mmr: 3990, mmrSource: "replay", displayName: "SecretOppZed" }, ...extra };
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
  expect(await h.db.discordOutbox.findOne({ userId: "u_dee" })).toMatchObject({ status: "sent" });
  expect(await h.db.discordOutbox.findOne({ userId: "u_dee", payload: { $exists: true } })).toBeNull();
  await discord.onFreshGame("u_dee", ranked);
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
  const body = { token, ...battleReport, url: "https://other.example/", gameId: "ignore" };
  await request(h.app).post(send).send(body).expect(401);
  await as("bob").post(send, body).expect(404);
  await as("dee").post(send, body).expect(409);
  await as("dee").patch(path, { options: { replayLink: true } }).expect(200);
  await as("dee").post(send, { ...body, paragraph: "x".repeat(751) }).expect(400);
  await as("dee").post(send, { ...body, token: "BattleReport2222" }).expect(404);
  expect((await as("dee").post(send, body).expect(200)).body).toEqual({ queued: 1 });
  expect(calls).toHaveLength(0);
  expect((await discord.drain()).sent).toBe(1);
  const message = JSON.parse(calls[0].init.body);
  expect(message.embeds[0]).toMatchObject({
    title: battleReport.headline, description: battleReport.paragraph, url: `https://sc2tools.com/g/${token}#battle-report`,
  });
  expect(JSON.stringify(message)).not.toMatch(/SecretOppZed|other\.example|ignore/);
  expect((await as("dee").post(send, body).expect(200)).body).toEqual({ queued: 0 });
});

test("revoking a share or withdrawing channel consent blocks queued posts and scrubs their payloads", async () => {
  const token = "BattleReport3333";
  const { path, send } = await prepareBattleReport(token);
  await as("dee").patch(path, { options: { replayLink: true, opponentNames: true } }).expect(200);
  await as("dee").post(send, { token, ...battleReport }).expect(200);
  await discord.onFreshGame("u_dee", game("u_dee"));
  await h.db.gameShares.updateOne({ _id: token }, { $set: { revokedAt: new Date() } });
  expect(await discord.deliverRow(await h.db.discordOutbox.findOne({ shareToken: token }))).toBe("dropped");
  await as("dee").patch(path, { options: { opponentNames: false } }).expect(200);
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
  await discord.onFreshGame("u_dee", game("u_dee", { myMmr: 4060 }));
  expect(await h.db.discordOutbox.countDocuments({ userId: "u_dee", kind: "milestone" })).toBe(0);
  const peak = game("u_dee", { myMmr: 4100 });
  await h.db.games.insertOne(peak);
  await discord.onFreshGame("u_dee", peak);
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
  await discord.onFreshGame(userId, current);
  const filter = { userId, kind: "milestone" };
  const row = await h.db.discordOutbox.findOne(filter);
  expect(row.payload.embeds[0]).toMatchObject({ title: "Promotion · Master", description: "Diamond → Master · Random", fields: [] });
  expect(row.payload.allowed_mentions).toEqual({ parse: [] });
  expect(JSON.stringify(row.payload)).not.toMatch(/SecretOppZed|4700|https:/);
  await discord.drain();
  expect(await h.db.discordOutbox.findOne(filter)).toMatchObject({ status: "sent" });
  expect((await h.db.discordOutbox.findOne(filter)).payload).toBeUndefined();
  await discord.onFreshGame(userId, current);
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
  await discord.onFreshGame(userId, game(userId, { ...ranked, myLeagueId: 5 }));
  await discord.onFreshGame(userId, game(userId, { ...ranked, myLeagueId: 5, myToonHandle: "1-S2-1-2" }));
  await discord.onFreshGame(userId, game(userId, { ...ranked, myLeagueId: 5, myToonHandle: "1-S2-1-3" }));
  expect(await h.db.discordOutbox.countDocuments({ userId, kind: "milestone" })).toBe(0);
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


test("ranked ingest stores and queues the replay-observed own league", async () => {
  const userId = await promotionRecipient("rankupload");
  const date = Date.now() - 30_000;
  const prior = game(userId, { date: new Date(date - 60_000), matchFormat: "1v1", myLeagueId: 4 });
  await h.db.games.insertOne(prior);
  const incoming = game(userId, { date: new Date(date), matchFormat: "1v1", myLeagueId: 5, myMmrSource: "replay" });
  delete incoming.userId;
  delete incoming.createdAt;
  const enqueue = jest.spyOn(discord, "onFreshGame");
  try {
    const response = await as("rankupload").post("/v1/games", { games: [incoming] });
    expect(response.status).toBe(202);
    expect(enqueue).toHaveBeenCalledWith(userId, expect.objectContaining({ myLeagueId: 5 }));
    await enqueue.mock.results[0].value;
    expect(await h.db.games.findOne({ userId, gameId: incoming.gameId })).toMatchObject({ myLeagueId: 5 });
    expect(await h.db.discordOutbox.findOne({ userId, kind: "milestone" })).toMatchObject({
      payload: { embeds: [expect.objectContaining({ title: "Promotion · Master" })] },
    });
  } finally { enqueue.mockRestore(); }
});


test("a result or promotion never includes an unproven rating", async () => {
  const userId = await promotionRecipient("ratingprovenance");
  const now = Date.now() - 60_000;
  await h.db.games.insertOne(game(userId, { myLeagueId: 4, date: new Date(now - 60_000) }));
  await discord.onFreshGame(userId, game(userId, { myLeagueId: 5, myMmr: 7321, myMmrSource: "unavailable", date: new Date(now),
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
  await discord.onFreshGame(userId, game(userId, { date: new Date(now), myMmr: 4250, myLadderRace: "Random" }));
  expect(await h.db.discordOutbox.countDocuments({ userId, kind: "milestone" })).toBe(0);
  expect((await h.db.discordOutbox.findOne({ userId, kind: "result" })).payload.embeds[0].fields).toContainEqual({ name: "MMR", value: "4,250", inline: true });
  await h.db.games.insertOne(game(userId, { ...offQueue, date: new Date(now - 2000), myMmr: 4230 }));
  await discord.onFreshGame(userId, game(userId, { date: new Date(now), myMmr: 4260, myLadderRace: "rand" }));
  expect((await h.db.discordOutbox.findOne({ userId, kind: "milestone" })).payload.embeds[0]).toMatchObject({
    title: "New Random MMR peak", description: "4,260 MMR (previous best 4,230)",
  });
});

test("legacy results are still posted after rating fields are removed, and unverifiable peak claims are retired", async () => {
  const userId = await promotionRecipient("legacydiscord");
  await discord.enqueue(userId, "result", "legacy-result", () => ({ embeds: [{ title: "Victory", fields: [
    { name: "MMR", value: "8,100 (+12)" }, { name: "Opponent", value: "Zerg · 7,890 MMR" }, { name: "Build", value: "Stargate" },
  ] }] }));
  await discord.enqueue(userId, "result", "legacy-plain", () => ({ content: "A plain result" }));
  await discord.enqueue(userId, "milestone", "legacy-peak", () => ({ embeds: [{ title: "Old MMR peak", description: "8,100 MMR" }] }));
  await h.db.discordOutbox.updateMany({ userId }, { $unset: { ratingPolicy: "" } });
  expect(await discord.drain()).toMatchObject({ sent: 2, dropped: 1 });
  expect(calls.map(call => JSON.parse(call.init.body))).toEqual(expect.arrayContaining([
    { content: "A plain result" }, { embeds: [{ title: "Victory", fields: [
      { name: "Opponent", value: "Zerg" }, { name: "Build", value: "Stargate" },
    ] }] },
  ]));
  expect(await h.db.discordOutbox.countDocuments({ userId, payload: { $exists: false }, dedupeKey: { $exists: true } })).toBe(3);
});

test("a queued proven result keeps ratings while dropping an inferred current-game delta", async () => {
  const userId = await promotionRecipient("oldpregame");
  await discord.enqueue(userId, "result", "previously-queued-result", () => ({ embeds: [{ title: "Victory", fields: [
    { name: "MMR", value: "4,100 (−14)" }, { name: "Opponent", value: "Zerg · 4,050 MMR" },
  ] }] }));
  expect(await discord.drain()).toMatchObject({ sent: 1 });
  expect(JSON.parse(calls[0].init.body)).toEqual({ embeds: [{ title: "Victory", fields: [
    { name: "MMR", value: "4,100" }, { name: "Opponent", value: "Zerg · 4,050 MMR" },
  ] }] });
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

test("rechecks hook privacy after taking the erasure lease", async () => {
  const userId = await promotionRecipient("discordprivacy");
  await h.db.discordHooks.updateOne({ userId }, { $set: { "options.opponentNames": true } });
  await discord.onFreshGame(userId, game(userId));
  const queued = await h.db.discordOutbox.findOne({ userId });
  expect(JSON.stringify(queued.payload)).toContain("SecretOppZed");
  const outcome = await changeInsideDispatchLease(queued, () => h.db.discordHooks.updateOne({ userId }, { $set: { "options.opponentNames": false } }));
  expect(outcome).toBe("dropped");
  expect(calls).toHaveLength(0);
  const receipt = await h.db.discordOutbox.findOne({ _id: queued._id });
  expect(receipt).toMatchObject({ status: "dropped", dedupeKey: queued.dedupeKey });
  expect(receipt.payload).toBeUndefined();
});

test("rechecks public archive consent after taking the erasure lease and removes its link", async () => {
  const userId = await promotionRecipient("discordarchive");
  await h.db.discordHooks.updateOne({ userId }, { $set: { "options.replayLink": true } });
  await h.db.users.updateOne({ userId }, { $set: { replaySharing: { enabled: true, slug: "account-replay" } } });
  await discord.onFreshGame(userId, game(userId));
  const queued = await h.db.discordOutbox.findOne({ userId });
  expect(queued.payload.embeds[0].url).toContain("account-replay");
  const outcome = await changeInsideDispatchLease(queued, () => h.db.users.updateOne({ userId }, { $set: { "replaySharing.enabled": false } }));
  expect(outcome).toBe("sent");
  expect(calls).toHaveLength(1);
  expect(JSON.parse(calls[0].init.body).embeds[0].url).toBeUndefined();
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
