// @ts-nocheck
"use strict";

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());
const { generateKeyPairSync, sign } = require("node:crypto");
const { once } = require("node:events");
const http = require("node:http");
const express = require("express");
const request = require("supertest");
const { createHarness } = require("./helpers/reviewsHarness");
const { BUILD_COMMAND, parseDiscordInteractions } = require("../src/config/discordInteractions");
const { GUIDE_CURRENT_ERA } = require("../src/config/guides");
const { buildNamesForMatchup, buildSlug } = require("../src/config/guideSlugs");
const { sanitiseRequestForLog } = require("../src/middleware/requestLogging");
const { buildDiscordInteractionsRouter } = require("../src/routes/discordInteractions");
const { DiscordBuildCache } = require("../src/services/discordBuildCache");
const { PATCH_ERA_RULE } = require("../src/util/patchEra");
const { register } = require("../scripts/register-discord-build");

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const applicationId = "123456789012345678";
const config = { applicationId, publicKey: Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("hex") };
const path = "/v1/discord/interactions";
const privateText = "NEVER_EXPORT_THIS_FIXTURE";
const computedAt = new Date("2026-11-12T20:00:00Z");
const matchup = "PvT";
const now = () => Math.floor(Date.now() / 1000).toString();
let h;

function signed(app, body, { timestamp = now(), signature, url = path } = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return request(app).post(url).set("Content-Type", "application/json")
    .set("X-Signature-Timestamp", timestamp)
    .set("X-Signature-Ed25519", signature ?? sign(null, Buffer.from(timestamp + raw), privateKey).toString("hex"))
    .send(raw);
}

function command(value = "pvt") {
  return {
    type: 2, application_id: applicationId, id: privateText,
    token: privateText, guild_id: privateText, channel_id: privateText,
    member: { user: { id: privateText, username: privateText } },
    data: { type: 1, name: "build", options: [{ type: 3, name: "matchup", value }] },
  };
}

function row(buildKey, overrides) {
  return {
    buildKey, buildSlug: buildSlug(matchup, buildKey), published: true,
    games: 101, users: 5, wins: 60, winRate: 0.6, ci: { low: 0.50, high: 0.68 },
    examples: [{ userId: privateText, opponentName: privateText, replayId: privateText }],
    ...overrides,
  };
}

beforeAll(async () => {
  h = await createHarness({ config: { discordInteractions: config, guidesEnabled: true, rateLimitPerMinute: 1 } });
});
afterAll(async () => { await h?.close(); });

test("verifies exact raw timestamp and body before decoding, and replies to PING with JSON", async () => {
  const body = '{  "ignored": "Æon", "type": 1 }';
  await signed(h.app, body).expect("Cache-Control", "no-store").expect("Content-Type", /json/).expect(200, { type: 1 });
  const timestamp = now();
  const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString("hex");
  await signed(h.app, body.replace("Æon", "Aeon"), { timestamp, signature }).expect(401);
  await signed(h.app, "{bad").expect(400);
  await signed(h.app, "{bad", { signature: "0".repeat(128) }).expect(401);
  await signed(h.app, body, { timestamp: String(+timestamp - 301) }).expect(401);
  await signed(h.app, body, { timestamp: String(+timestamp + 301) }).expect(401);
  await signed(h.app, body, { timestamp: "invalid" }).expect(401);
  await signed(h.app, body, { signature: "z".repeat(128) }).expect(401);
  await request(h.app).post(path).send({ type: 1 }).expect(401);
  await signed(h.app, { type: 1, application_id: "987654321098765432" }).expect(401);
  await signed(h.app, command()).set("Content-Type", "text/plain").expect(401);
  await signed(h.app, command()).set("Content-Encoding", "gzip").expect(401);
  const oversized = await signed(h.app, command("a".repeat(17_000))).expect(413);
  expect(oversized.text).not.toContain(privateText);
});

test("a stalled interaction body cannot wait past the inline Discord deadline", async () => {
  const server = h.app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const response = await new Promise((resolve, reject) => {
      const raw = http.request({
        host: "127.0.0.1", port: server.address().port, method: "POST", path,
        headers: {
          "content-type": "application/json", "content-length": 100,
          "x-signature-timestamp": now(), "x-signature-ed25519": "0".repeat(128),
        },
      }, res => { res.resume(); resolve(res); });
      raw.setTimeout(2900, () => raw.destroy(new Error("interaction timed out")));
      raw.once("error", reject);
      raw.write("{");
    });
    expect(response.statusCode).toBe(408);
    expect(response.headers.connection).toBe("close");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("a cold guide cache gives a private reply with the public guide link", async () => {
  const reply = await signed(h.app, command()).expect(200);
  expect(reply.body).toEqual({ type: 4, data: {
    flags: 64, allowed_mentions: { parse: [] },
    content: "Published opener stats are unavailable right now. Check the matchup guide.",
    components: [{ type: 1, components: [
      { type: 2, style: 5, label: "All openers", url: "https://sc2tools.com/guides/pvt" },
      { type: 2, style: 5, label: "Grade my replay", url: "https://sc2tools.com/try" },
    ] }],
  } });
});

test("disabled guides give a private reply without links, using an independent IP bucket", async () => {
  const app = express();
  app.use("/v1", buildDiscordInteractionsRouter(config, null, { maxPerMinute: 1 }));
  await signed(app, command()).expect(200, { type: 4, data: {
    flags: 64, allowed_mentions: { parse: [] }, content: "Build guides are unavailable right now.",
  } });
  await signed(app, { type: 1 }).expect(429);
  const disabled = express();
  disabled.use("/v1", buildDiscordInteractionsRouter(null, null));
  await signed(disabled, { type: 1 }).expect(404);
});

test("only fixed matchups are accepted, with no user-controlled text or URLs", async () => {
  for (const choice of BUILD_COMMAND.options[0].choices) {
    const response = await signed(h.app, command(choice.value)).expect(200);
    expect(response.body.data.components[0].components[0].url).toBe("https://sc2tools.com/guides/" + choice.value);
  }
  for (const choice of ["pvt/evil", "PvT", "https://example.invalid", privateText]) {
    const response = await signed(h.app, command(choice)).expect(200);
    expect(response.body).toEqual({ type: 4, data: {
      flags: 64, allowed_mentions: { parse: [] }, content: "Choose a matchup in the /build command.",
    } });
  }
  await signed(h.app, { ...command(), application_id: "987654321098765432" }).expect(401);
});

test("serves at most five canonical published floor-clearing openers from a completed generation and never reads on command", async () => {
  const stats = h.db.guideStats;
  const cache = h.services.discordBuildCache;
  const names = buildNamesForMatchup(matchup).slice(0, 9);
  expect(names).toHaveLength(9);
  const { ci } = row(names[0]);
  const doc = {
    key: "matchup:" + GUIDE_CURRENT_ERA + ":" + matchup, kind: "matchup", era: GUIDE_CURRENT_ERA,
    matchup, published: true, computedAt, builds: [
      row(names[0], { users: 4, winRate: 1, ci: { low: 0.99, high: 1 } }),
      row(names[1], { games: 30, winRate: 1, ci: { low: 0.99, high: 1 } }),
      row(names[2], { published: false, winRate: 1, ci: { low: 0.99, high: 1 } }),
      row(privateText, { buildSlug: "malicious", winRate: 1, ci: { low: 0.99, high: 1 } }),
      row(names[3], { buildSlug: "fake", winRate: 1, ci: { low: 0.99, high: 1 } }),
      ...names.slice(3).map(name => row(name)),
    ],
  };
  await stats.insertMany([doc, { key: "run", kind: "run", eraRule: PATCH_ERA_RULE, computedAt: new Date(+computedAt - 1000) }]);
  await cache.refresh();
  expect(cache.get(matchup)).toBeUndefined();
  await stats.updateOne({ key: "run" }, { $set: { computedAt } });
  cache.invalidate();
  await cache.refresh();
  const find = jest.spyOn(stats, "find");
  const findOne = jest.spyOn(stats, "findOne");
  try {
    const start = performance.now();
    const response = await signed(h.app, command(), { url: "/v1/DISCORD/interactions/?query=" + privateText }).expect(200);
    expect(performance.now() - start).toBeLessThan(3000);
    expect(response.body.data.flags).toBe(64);
    const [embed] = response.body.data.embeds;
    expect(embed.footer.text).toBe("12-worker ladder · Snapshot 2026-11-12");
    const lines = embed.description.split("\n");
    expect(lines).toHaveLength(5);
    for (const name of names.slice(3, 8)) {
      expect(embed.description).toContain("/guides/pvt/" + buildSlug(matchup, name));
    }
    expect(embed.description).toContain("60.0% wins (50.0% to 68.0% interval, 101 games)");
    expect(JSON.stringify(response.body)).not.toMatch(/NEVER_EXPORT_THIS_FIXTURE|malicious|\/fake\)/);
    expect(cache.get(matchup).openers[0]).toMatchObject({ games: 101, ci });
    expect(Object.keys(cache.get(matchup).openers[0]).sort()).toEqual(["ci", "games", "name", "slug", "winRate"]);
    expect(find).not.toHaveBeenCalled();
    expect(findOne).not.toHaveBeenCalled();
  } finally {
    find.mockRestore();
    findOne.mockRestore();
  }
  let clock = 100;
  const aging = new DiscordBuildCache(stats, { now: () => clock });
  await aging.refresh();
  expect(aging.get(matchup)).toBeDefined();
  clock += 20 * 60_000;
  expect(aging.get(matchup)).toBeUndefined();
  const app = express();
  app.use("/v1", buildDiscordInteractionsRouter(config, aging));
  const expired = await signed(app, command()).expect(200);
  expect(expired.body.data.embeds).toBeUndefined();
  expect(expired.body.data.components[0].components[0].url).toBe("https://sc2tools.com/guides/pvt");
});

test("logs a fixed route without Discord header, query, request ID, IP or body data", () => {
  const url = "/V1/DISCORD/INTERACTIONS/?id=" + privateText;
  expect(sanitiseRequestForLog({
    url, method: "POST", id: privateText, body: command(), socket: { remoteAddress: privateText },
    headers: { "x-signature-ed25519": privateText, "user-agent": privateText },
  })).toEqual({ method: "POST", url: path });
});

test("starts warming immediately, refreshes every ten minutes and stops on shutdown", async () => {
  jest.useFakeTimers();
  const stats = { findOne: jest.fn(async () => null) };
  const cache = new DiscordBuildCache(stats);
  try {
    cache.start();
    cache.start();
    await cache.refresh();
    expect(stats.findOne).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(10 * 60_000 - 1);
    expect(stats.findOne).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(stats.findOne).toHaveBeenCalledTimes(2);
    cache.invalidate();
    await cache.refresh();
    expect(stats.findOne).toHaveBeenCalledTimes(3);
    await cache.stop();
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(stats.findOne).toHaveBeenCalledTimes(3);
  } finally {
    await cache.stop();
    jest.useRealTimers();
  }
});

test("registration defaults offline and the explicit apply upserts one command without exposing credentials", async () => {
  const env = { DISCORD_APPLICATION_ID: applicationId, DISCORD_COMMANDS_ACCESS_TOKEN: privateText };
  expect(parseDiscordInteractions(env)).toBeNull();
  expect(parseDiscordInteractions({ ...env, DISCORD_INTERACTIONS_PUBLIC_KEY: config.publicKey })).toEqual(config);
  const send = jest.fn(async () => ({ ok: true, status: 201 }));
  const dry = JSON.parse(await register([], env, send));
  expect(dry).toMatchObject({ dryRun: true, method: "POST", command: { name: "build", integration_types: [0], contexts: [0] } });
  expect(dry.command.options[0].choices).toHaveLength(9);
  expect(JSON.stringify(dry)).not.toContain(privateText);
  expect(send).not.toHaveBeenCalled();
  const guild = "987654321098765432";
  await expect(register(["--guild", guild, "--apply"], env, send)).resolves.toBe("Registered /build.");
  expect(send).toHaveBeenCalledTimes(1);
  const [url, options] = send.mock.calls[0];
  expect(url).toBe("https://discord.com/api/v10/applications/" + applicationId + "/guilds/" + guild + "/commands");
  expect(options).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: "Bearer " + privateText } });
  expect(JSON.parse(options.body)).not.toHaveProperty("integration_types");
  await expect(register(["--apply"], env, async () => { throw new Error(privateText); }))
    .rejects.toThrow("Discord command registration could not connect.");
});
