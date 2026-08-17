// @ts-nocheck
"use strict";

const {
  createHmac,
  generateKeyPairSync,
  sign,
} = require("crypto");
const express = require("express");
const request = require("supertest");
const {
  PlatformCredentialVault,
  parseTokenEncryptionKey,
  decryptSecret,
} = require("../src/services/platformCredentialVault");
const {
  verifyTwitchWebhook,
  verifyKickWebhook,
  normalizeTwitchEvent,
  normalizeKickEvent,
  normalizeYoutubeSubscriber,
  WebhookVerificationError,
} = require("../src/services/platformWebhooks");
const {
  PlatformEventsService,
} = require("../src/services/platformEvents");
const {
  PlatformIntegrationsService,
} = require("../src/services/platformIntegrations");
const oauth = require("../src/services/platformOauthClients");
const {
  parsePlatformIntegrationsConfig,
} = require("../src/config/loader");
const {
  buildPlatformIntegrationsRouter,
  callbackPage,
} = require("../src/routes/platformIntegrations");

const KEY = Buffer.alloc(32, 7);
const NOW = Date.parse("2026-08-16T12:00:00.000Z");

function fakeVaultDb() {
  const rows = new Map();
  const states = new Map();
  const receipts = new Set();
  const eventRows = [];
  return {
    rows,
    states,
    db: {
      platformConnections: {
        async updateOne(filter, update, options) {
          const key = `${filter.userId}:${filter.platform}`;
          const previous = rows.get(key) || {};
          const matches = (!filter.connected || previous.connected === filter.connected)
            && (!filter.connectionRevision
              || previous.connectionRevision === filter.connectionRevision);
          if (previous.userId && !matches) return { matchedCount: 0 };
          const next = {
            ...previous,
            ...(update.$setOnInsert || {}),
          };
          for (const [field, value] of Object.entries(update.$set || {})) {
            if (field.startsWith("metadata.")) {
              next.metadata = { ...(next.metadata || {}) };
              next.metadata[field.slice("metadata.".length)] = value;
            } else {
              next[field] = value;
            }
          }
          rows.set(key, next);
          return { matchedCount: previous.userId ? 1 : options?.upsert ? 0 : 0 };
        },
        async findOne(filter) {
          if (filter.userId) {
            const row = rows.get(`${filter.userId}:${filter.platform}`) || null;
            if (!row) return null;
            if (filter.connected !== undefined && row.connected !== filter.connected) return null;
            if (filter.connectionRevision
              && row.connectionRevision !== filter.connectionRevision) return null;
            return row;
          }
          return Array.from(rows.values()).find((row) =>
            row.platform === filter.platform
            && row.platformUserId === filter.platformUserId
            && row.connected === true) || null;
        },
        find(filter) {
          let result = Array.from(rows.values()).filter((row) =>
            (!filter.userId || row.userId === filter.userId)
            && (!filter.platform || row.platform === filter.platform)
            && (filter.connected === undefined || row.connected === filter.connected));
          const cursor = {
            project() { return cursor; },
            limit(n) { result = result.slice(0, n); return cursor; },
            async toArray() { return result; },
          };
          return cursor;
        },
        async deleteOne(filter) {
          const key = `${filter.userId}:${filter.platform}`;
          const row = rows.get(key);
          if (filter.connectionRevision
            && row?.connectionRevision !== filter.connectionRevision) {
            return { deletedCount: 0 };
          }
          return { deletedCount: rows.delete(key) ? 1 : 0 };
        },
      },
      platformOauthStates: {
        async insertOne(row) { states.set(row.stateHash, row); },
        async findOneAndDelete(filter) {
          const row = states.get(filter.stateHash);
          if (!row || row.platform !== filter.platform || row.expiresAt <= filter.expiresAt.$gt) return null;
          states.delete(filter.stateHash);
          return row;
        },
      },
      platformWebhookReceipts: {
        async insertOne(row) {
          const key = `${row.platform}:${row.messageId}`;
          if (receipts.has(key)) throw Object.assign(new Error("duplicate"), { code: 11000 });
          receipts.add(key);
        },
      },
      platformEvents: {
        async insertOne(row) {
          if (eventRows.some((item) =>
            item.userId === row.userId
            && item.platform === row.platform
            && item.eventId === row.eventId)) {
            throw Object.assign(new Error("duplicate"), { code: 11000 });
          }
          eventRows.push(row);
        },
        find() {
          return {
            sort() { return this; },
            limit() { return this; },
            async toArray() { return eventRows.map((row) => ({ event: row.event })); },
          };
        },
      },
    },
    eventRows,
  };
}

describe("official platform credential vault", () => {
  test("requires exactly 256 bits and accepts hex/base64", () => {
    expect(parseTokenEncryptionKey(KEY).equals(KEY)).toBe(true);
    expect(parseTokenEncryptionKey(KEY.toString("hex")).equals(KEY)).toBe(true);
    expect(parseTokenEncryptionKey(KEY.toString("base64")).equals(KEY)).toBe(true);
    expect(() => parseTokenEncryptionKey("short")).toThrow(/32 bytes/);
    expect(() => parseTokenEncryptionKey(`${KEY.toString("base64")}!!`))
      .toThrow(/32 bytes/);
  });

  test("encrypts tokens with owner-bound AAD and never exposes them in status", async () => {
    const fake = fakeVaultDb();
    const vault = new PlatformCredentialVault(fake.db, { encryptionKey: KEY, now: () => NOW });
    const status = await vault.saveConnection("user-1", "twitch", {
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      platformUserId: "tw-1",
      platformUserName: "Streamer",
      scopes: ["moderator:read:followers"],
      metadata: { subscriptionsReady: true },
    });
    expect(status).not.toHaveProperty("accessToken");
    expect(status.ready).toBe(true);
    const stored = fake.rows.get("user-1:twitch");
    expect(JSON.stringify(stored)).not.toContain("access-secret");
    expect(decryptSecret(stored.accessToken, KEY, "connection:user-1:twitch:access"))
      .toBe("access-secret");
    expect(() => decryptSecret(stored.accessToken, KEY, "connection:user-2:twitch:access"))
      .toThrow();
    expect((await vault.getConnection("user-1", "twitch")).refreshToken)
      .toBe("refresh-secret");
  });

  test("OAuth state is one-time, expiring, and keeps PKCE verifier encrypted", async () => {
    const fake = fakeVaultDb();
    const vault = new PlatformCredentialVault(fake.db, { encryptionKey: KEY, now: () => NOW });
    const state = await vault.createOauthState({
      userId: "user-1",
      platform: "kick",
      redirectUri: "https://api.sc2tools.com/v1/integrations/kick/callback",
      codeVerifier: "verifier-secret",
    });
    expect(JSON.stringify(Array.from(fake.states.values()))).not.toContain("verifier-secret");
    expect(await vault.consumeOauthState(state, "twitch")).toBeNull();
    expect(await vault.consumeOauthState(state, "kick")).toMatchObject({
      userId: "user-1",
      codeVerifier: "verifier-secret",
    });
    expect(await vault.consumeOauthState(state, "kick")).toBeNull();
  });

  test("webhook receipt claim is atomic and duplicate-safe", async () => {
    const fake = fakeVaultDb();
    const vault = new PlatformCredentialVault(fake.db, { encryptionKey: KEY, now: () => NOW });
    expect(await vault.claimWebhookReceipt("twitch", "message-1")).toBe(true);
    expect(await vault.claimWebhookReceipt("twitch", "message-1")).toBe(false);
  });

  test("YouTube readiness requires a successful latest poll", async () => {
    const fake = fakeVaultDb();
    const vault = new PlatformCredentialVault(fake.db, { encryptionKey: KEY, now: () => NOW });
    await vault.saveConnection("user-1", "youtube", {
      accessToken: "access",
      platformUserId: "channel-1",
      metadata: {
        youtubeInitialized: true,
        lastError: "Authorization was revoked",
      },
    });
    expect((await vault.statuses("user-1"))[0]).toMatchObject({
      connected: true,
      ready: false,
      lastError: "Authorization was revoked",
    });
  });
});

describe("official webhook verification and normalization", () => {
  test("accepts a valid Twitch HMAC and rejects tampering/stale timestamps", () => {
    const rawBody = Buffer.from('{"event":{"user_name":"Follower"}}');
    const timestamp = new Date(NOW).toISOString();
    const messageId = "tw-msg";
    const secret = "a-strong-eventsub-secret";
    const signature = `sha256=${createHmac("sha256", secret)
      .update(messageId).update(timestamp).update(rawBody).digest("hex")}`;
    const headers = {
      "twitch-eventsub-message-id": messageId,
      "twitch-eventsub-message-timestamp": timestamp,
      "twitch-eventsub-message-signature": signature,
      "twitch-eventsub-message-type": "notification",
      "twitch-eventsub-subscription-type": "channel.follow",
    };
    expect(verifyTwitchWebhook({ headers, rawBody, secret, nowMs: NOW }))
      .toMatchObject({ messageId, subscriptionType: "channel.follow" });
    expect(() => verifyTwitchWebhook({
      headers,
      rawBody: Buffer.from("{}"),
      secret,
      nowMs: NOW,
    })).toThrow(WebhookVerificationError);
    expect(() => verifyTwitchWebhook({
      headers: { ...headers, "twitch-eventsub-message-timestamp": "2020-01-01T00:00:00Z" },
      rawBody,
      secret,
      nowMs: NOW,
    })).toThrow(/replay window/);
  });

  test("accepts Kick's RSA-SHA256 signed message and rejects mutation", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rawBody = Buffer.from('{"broadcaster":{"user_id":42}}');
    const messageId = "kick-msg";
    const timestamp = new Date(NOW).toISOString();
    const signature = sign(
      "RSA-SHA256",
      Buffer.concat([Buffer.from(`${messageId}.${timestamp}.`), rawBody]),
      privateKey,
    ).toString("base64");
    const headers = {
      "kick-event-message-id": messageId,
      "kick-event-message-timestamp": timestamp,
      "kick-event-signature": signature,
      "kick-event-type": "channel.followed",
      "kick-event-version": "1",
    };
    const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(verifyKickWebhook({ headers, rawBody, publicKey: publicPem, nowMs: NOW }))
      .toMatchObject({ messageId, eventType: "channel.followed" });
    expect(() => verifyKickWebhook({
      headers,
      rawBody: Buffer.from("{}"),
      publicKey: publicPem,
      nowMs: NOW,
    })).toThrow(/signature mismatch/);
  });

  test("normalizes the complete official recognition-event set to ChatEvent", () => {
    expect(normalizeTwitchEvent("channel.follow", {
      event: { user_name: "Alpha", followed_at: new Date(NOW).toISOString() },
    }, "m1")).toMatchObject({
      platform: "twitch",
      kind: "follow",
      user: "Alpha",
      updateKey: `follow:alpha:${Math.floor(NOW / (15 * 60 * 1000))}`,
      updateVersion: 1,
    });
    expect(normalizeKickEvent("channel.reward.redemption.updated", {
      id: "reward-1",
      redeemer: { username: "Beta" },
      reward: { title: "Hydrate", cost: 500 },
    }, "m2")).toMatchObject({ platform: "kick", kind: "reward", amount: "500 points" });
    expect(normalizeKickEvent("channel.followed", {
      follower: { username: "Alpha" },
      created_at: new Date(NOW).toISOString(),
    }, "m3")).toMatchObject({
      platform: "kick",
      kind: "follow",
      updateKey: `follow:alpha:${Math.floor(NOW / (15 * 60 * 1000))}`,
      updateVersion: 1,
    });
    expect(normalizeTwitchEvent("channel.subscribe", {
      event: { user_name: "NewSub", is_gift: false },
    }, "tw-sub")).toMatchObject({
      platform: "twitch",
      kind: "sub",
      official: true,
      dedupeKey: "support:sub:newsub",
    });
    expect(normalizeTwitchEvent("channel.subscribe", {
      event: { user_name: "GiftRecipient", is_gift: true },
    }, "tw-gift-child")).toBeNull();
    expect(normalizeTwitchEvent("channel.subscription.message", {
      event: { user_name: "LoyalSub", cumulative_months: 12 },
    }, "tw-resub")).toMatchObject({
      kind: "resub",
      dedupeKey: "support:resub:loyalsub:12",
    });
    expect(normalizeTwitchEvent("channel.subscription.gift", {
      event: { user_name: "GiftLord", total: 5, is_anonymous: false },
    }, "tw-gift")).toMatchObject({
      kind: "giftsub",
      amount: "5",
      dedupeKey: "support:giftsub:giftlord:5",
    });
    expect(normalizeTwitchEvent("channel.cheer", {
      event: { user_name: "CheerFan", bits: 250, message: "Cheer250 gg" },
    }, "tw-cheer")).toMatchObject({
      kind: "cheer",
      // Exact match with the IRC parser fixture proves both transports build
      // the same semantic fingerprint from Twitch's documented string field.
      dedupeKey: "support:cheer:cheerfan:250:16bz365",
    });
    expect(normalizeTwitchEvent("channel.raid", {
      event: { from_broadcaster_user_name: "Raider", viewers: 42 },
    }, "tw-raid")).toMatchObject({
      kind: "raid",
      amount: "42",
      dedupeKey: "support:raid:raider:42",
    });
    expect(normalizeKickEvent("channel.subscription.new", {
      subscriber: { username: "KickSub" },
    }, "kick-sub")).toMatchObject({
      kind: "sub",
      dedupeKey: "support:sub:kicksub",
    });
    expect(normalizeKickEvent("channel.subscription.renewal", {
      subscriber: { username: "KickLoyal" },
      duration: 7,
    }, "kick-renew")).toMatchObject({
      kind: "resub",
      dedupeKey: "support:resub:kickloyal:7",
    });
    expect(normalizeKickEvent("channel.subscription.gifts", {
      gifter: { username: "KickGifter" },
      giftees: [{ username: "One" }, { username: "Two" }],
    }, "kick-gifts")).toMatchObject({
      kind: "giftsub",
      amount: "2",
      dedupeKey: "support:giftsub:kickgifter:2",
    });
    expect(normalizeKickEvent("kicks.gifted", {
      sender: { username: "KickFan" },
      gift: { name: "Golden KICK", amount: 250 },
    }, "kick-kicks")).toMatchObject({
      kind: "gift",
      amount: "250 KICKs",
    });
    expect(normalizeYoutubeSubscriber({
      id: "sub-1",
      subscriberSnippet: { title: "Gamma" },
      snippet: { publishedAt: new Date(NOW).toISOString() },
    })).toMatchObject({ platform: "youtube", kind: "follow", user: "Gamma" });
  });
});

describe("official OAuth and delivery contracts", () => {
  test("denied OAuth callback consumes state before rendering the error page", async () => {
    const abandonOauth = jest.fn(async () => true);
    const complete = jest.fn();
    const app = express();
    app.use(buildPlatformIntegrationsRouter({
      auth: (_req, _res, next) => next(),
      integrations: { abandonOauth, complete },
      returnUrl: "https://sc2tools.com/settings#overlay",
    }));

    const response = await request(app)
      .get("/integrations/twitch/callback")
      .query({ error: "access_denied", state: "pending-state" });

    expect(response.status).toBe(400);
    expect(abandonOauth).toHaveBeenCalledWith("twitch", "pending-state");
    expect(complete).not.toHaveBeenCalled();
    expect(response.text).not.toContain("pending-state");
  });

  test("provider-denied OAuth consumes only that provider's one-time state", async () => {
    const fake = fakeVaultDb();
    const service = new PlatformIntegrationsService(fake.db, {
      config: {
        enabled: true,
        encryptionKey: KEY,
        twitch: {
          clientId: "twitch-client",
          clientSecret: "twitch-secret",
          redirectUri: "https://api.sc2tools.com/v1/integrations/twitch/callback",
          callbackUrl: "https://api.sc2tools.com/v1/webhooks/twitch/eventsub",
          webhookSecret: "strong-eventsub-secret",
        },
        kick: {
          clientId: "kick-client",
          clientSecret: "kick-secret",
          redirectUri: "https://api.sc2tools.com/v1/integrations/kick/callback",
        },
        youtube: null,
      },
      now: () => NOW,
      overlayTokens: { list: async () => [] },
    });
    const twitch = await service.begin("user-1", "twitch");
    const state = new URL(twitch.authorizeUrl).searchParams.get("state");

    expect(await service.abandonOauth("kick", state)).toBe(false);
    expect(await service.abandonOauth("twitch", state)).toBe(true);
    expect(await service.abandonOauth("twitch", state)).toBe(false);
  });

  test("verified Twitch webhook resolves its owner, persists, emits once, and dedupes retry", async () => {
    const fake = fakeVaultDb();
    const emitted = [];
    const secret = "a-strong-eventsub-secret";
    const service = new PlatformIntegrationsService(fake.db, {
      config: {
        enabled: true,
        encryptionKey: KEY,
        twitch: {
          clientId: "client",
          clientSecret: "secret",
          redirectUri: "https://api.sc2tools.com/v1/integrations/twitch/callback",
          callbackUrl: "https://api.sc2tools.com/v1/webhooks/twitch/eventsub",
          webhookSecret: secret,
        },
        kick: null,
        youtube: null,
      },
      now: () => NOW,
      overlayTokens: { list: async () => [{ token: "overlay-1" }] },
      io: { to: (room) => ({ emit: (name, payload) => emitted.push({ room, name, payload }) }) },
    });
    await service.vault.saveConnection("user-1", "twitch", {
      accessToken: "token",
      platformUserId: "broadcaster-1",
      platformUserName: "Streamer",
      metadata: { subscriptionsReady: true },
    });
    const rawBody = Buffer.from(JSON.stringify({
      subscription: {
        type: "channel.follow",
        condition: { broadcaster_user_id: "broadcaster-1" },
      },
      event: {
        user_name: "Follower",
        followed_at: new Date(NOW).toISOString(),
      },
    }));
    const timestamp = new Date(NOW).toISOString();
    const messageId = "webhook-1";
    const signature = `sha256=${createHmac("sha256", secret)
      .update(messageId).update(timestamp).update(rawBody).digest("hex")}`;
    const headers = {
      "twitch-eventsub-message-id": messageId,
      "twitch-eventsub-message-timestamp": timestamp,
      "twitch-eventsub-message-signature": signature,
      "twitch-eventsub-message-type": "notification",
      "twitch-eventsub-subscription-type": "channel.follow",
    };
    expect(await service.handleTwitchWebhook(headers, rawBody)).toEqual({ status: 204 });
    expect(fake.eventRows).toHaveLength(1);
    expect(emitted).toEqual([
      expect.objectContaining({
        room: "overlay:overlay-1",
        name: "overlay:platformEvent",
        payload: expect.objectContaining({ kind: "follow", user: "Follower" }),
      }),
    ]);
    expect(await service.handleTwitchWebhook(headers, rawBody)).toEqual({ status: 204 });
    expect(fake.eventRows).toHaveLength(1);
    expect(emitted).toHaveLength(1);
  });

  test("authorization URLs carry exact callbacks, states, scopes, and Kick PKCE", () => {
    const twitch = new URL(oauth.buildTwitchAuthorizeUrl({
      clientId: "tw-client",
      clientSecret: "x",
      redirectUri: "https://api.sc2tools.com/v1/integrations/twitch/callback",
    }, "state-1"));
    expect(twitch.searchParams.get("state")).toBe("state-1");
    expect(twitch.searchParams.get("scope")).toContain("moderator:read:followers");
    expect(twitch.searchParams.get("scope")).toContain("channel:read:redemptions");
    expect(twitch.searchParams.get("scope")).toContain("channel:read:subscriptions");
    expect(twitch.searchParams.get("scope")).toContain("bits:read");
    const pair = oauth.createPkcePair();
    const kick = new URL(oauth.buildKickAuthorizeUrl({
      clientId: "kick-client",
      clientSecret: "x",
      redirectUri: "https://api.sc2tools.com/v1/integrations/kick/callback",
    }, "state-2", pair.challenge));
    expect(kick.searchParams.get("code_challenge_method")).toBe("S256");
    expect(kick.searchParams.get("code_challenge")).toBe(pair.challenge);
  });

  test("official subscription manifests use the documented types and conditions", () => {
    expect(oauth.TWITCH_EVENT_TYPES.map(({ type, version }) => ({ type, version })))
      .toEqual([
        { type: "channel.follow", version: "2" },
        { type: "channel.channel_points_custom_reward_redemption.add", version: "1" },
        { type: "channel.channel_points_automatic_reward_redemption.add", version: "2" },
        { type: "channel.subscribe", version: "1" },
        { type: "channel.subscription.message", version: "1" },
        { type: "channel.subscription.gift", version: "1" },
        { type: "channel.cheer", version: "1" },
        { type: "channel.raid", version: "1" },
      ]);
    expect(oauth.TWITCH_EVENT_TYPES.at(-1).condition("broadcaster-1"))
      .toEqual({ to_broadcaster_user_id: "broadcaster-1" });
    expect(oauth.KICK_EVENT_TYPES).toEqual([
      { name: "channel.followed", version: 1 },
      { name: "channel.subscription.new", version: 1 },
      { name: "channel.subscription.renewal", version: 1 },
      { name: "channel.subscription.gifts", version: 1 },
      { name: "kicks.gifted", version: 1 },
      { name: "channel.reward.redemption.updated", version: 1 },
    ]);
  });

  test("Twitch reconcile reuses only active subscriptions on the configured callback", async () => {
    const callbackUrl = "https://api.sc2tools.com/v1/webhooks/twitch/eventsub";
    const existing = oauth.TWITCH_EVENT_TYPES.map((spec) => ({
      type: spec.type,
      version: spec.version,
      condition: spec.condition("broadcaster-1"),
      status: "enabled",
      transport: { method: "webhook", callback: callbackUrl },
    }));
    const reuseFetch = jest.fn(async () => jsonResponse({ data: existing, pagination: {} }));
    await expect(oauth.reconcileTwitchEventSubscriptions({
      broadcasterUserId: "broadcaster-1",
      appAccessToken: "app-token",
      clientId: "client",
      callbackUrl,
      webhookSecret: "a-strong-eventsub-secret",
      fetchImpl: reuseFetch,
    })).resolves.toMatchObject({ created: [] });
    expect(reuseFetch).toHaveBeenCalledTimes(1);
    expect(new URL(reuseFetch.mock.calls[0][0]).searchParams.get("user_id"))
      .toBe("broadcaster-1");

    const requests = [];
    const replaceFetch = jest.fn(async (_url, init = {}) => {
      requests.push(init);
      if (!init.method) {
        return jsonResponse({
          data: existing.map((row) => ({
            ...row,
            transport: { ...row.transport, callback: "https://old.example/webhook" },
          })),
          pagination: {},
        });
      }
      const body = JSON.parse(init.body);
      return jsonResponse({
        data: [{ ...body, status: "webhook_callback_verification_pending" }],
      });
    });
    await oauth.reconcileTwitchEventSubscriptions({
      broadcasterUserId: "broadcaster-1",
      appAccessToken: "app-token",
      clientId: "client",
      callbackUrl,
      webhookSecret: "a-strong-eventsub-secret",
      fetchImpl: replaceFetch,
    });
    expect(requests.filter((init) => init.method === "POST"))
      .toHaveLength(oauth.TWITCH_EVENT_TYPES.length);
  });

  test("Kick reconnect lists subscriptions and creates only missing event types", async () => {
    const requests = [];
    const fetchImpl = async (_url, init = {}) => {
      requests.push(init);
      if (!init.method) {
        return jsonResponse({
          data: [{ event: "channel.followed", version: 1, method: "webhook" }],
        });
      }
      const body = JSON.parse(init.body);
      return jsonResponse({ data: body.events });
    };
    const result = await oauth.subscribeKickEvents("token", fetchImpl);
    expect(requests).toHaveLength(2);
    expect(JSON.parse(requests[1].body)).toEqual({
      events: oauth.KICK_EVENT_TYPES.slice(1),
      method: "webhook",
    });
    expect(result).toMatchObject({
      existing: [{ event: "channel.followed", version: 1, method: "webhook" }],
      created: oauth.KICK_EVENT_TYPES.slice(1),
    });
  });

  test("Kick reconnect skips POST when all required events already exist", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({
      data: oauth.KICK_EVENT_TYPES.map((event) => ({
        event: event.name,
        version: event.version,
        method: "webhook",
      })),
    }));
    await expect(oauth.subscribeKickEvents("token", fetchImpl)).resolves.toMatchObject({
      created: [],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("Kick setup rejects a partial per-event subscription failure", async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(jsonResponse({
        data: oauth.KICK_EVENT_TYPES.map((event) => ({
          ...event,
          ...(event.name === "channel.reward.redemption.updated"
            ? { error: "not allowed" }
            : { subscription_id: `ok-${event.name}` }),
        })),
      }));
    await expect(oauth.subscribeKickEvents("token", fetchImpl))
      .rejects.toThrow(/channel\.reward\.redemption\.updated: not allowed/);
  });

  test("periodic Kick health refreshes an expiring token and restores missing subscriptions", async () => {
    const fake = fakeVaultDb();
    const refreshKickToken = jest.fn(async () => ({
      accessToken: "refreshed-access",
      refreshToken: "rotated-refresh",
      expiresAt: new Date(NOW + 3_600_000),
      scopes: oauth.KICK_SCOPES,
    }));
    const subscribeKickEvents = jest.fn(async () => ({ existing: [], created: [] }));
    const service = new PlatformIntegrationsService(fake.db, {
      config: {
        enabled: true,
        encryptionKey: KEY,
        twitch: null,
        kick: {
          clientId: "kick-client",
          clientSecret: "kick-secret",
          redirectUri: "https://api.sc2tools.com/v1/integrations/kick/callback",
        },
        youtube: null,
      },
      now: () => NOW,
      overlayTokens: { list: async () => [] },
      oauth: { ...oauth, refreshKickToken, subscribeKickEvents },
    });
    await service.vault.saveConnection("user-1", "kick", {
      accessToken: "expired-access",
      refreshToken: "refresh-token",
      expiresAt: new Date(NOW - 1),
      platformUserId: "kick-user",
      platformUserName: "Streamer",
      metadata: { subscriptionsReady: false, lastError: "delivery stopped" },
    });
    await expect(service.reconcileProviderHealthOnce()).resolves.toEqual({ checked: 1 });
    expect(refreshKickToken).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "kick-client" }),
      "refresh-token",
      expect.any(Function),
    );
    expect(subscribeKickEvents).toHaveBeenCalledWith(
      "refreshed-access",
      expect.any(Function),
    );
    expect(await service.vault.getConnection("user-1", "kick"))
      .toMatchObject({
        accessToken: "refreshed-access",
        refreshToken: "rotated-refresh",
        ready: true,
        lastError: null,
      });
  });

  test("Twitch health validates on startup and hourly while reconciling more often", async () => {
    const fake = fakeVaultDb();
    let now = NOW;
    const validateTwitchUserToken = jest.fn(async () => ({
      userId: "broadcaster-1",
      userName: "Streamer",
      scopes: oauth.TWITCH_SCOPES,
      expiresInSeconds: 14_400,
    }));
    const getTwitchAppToken = jest.fn(async () => "app-token");
    const reconcileTwitchEventSubscriptions = jest.fn(async () => ({ existing: [], created: [] }));
    const service = new PlatformIntegrationsService(fake.db, {
      config: {
        enabled: true,
        encryptionKey: KEY,
        twitch: {
          clientId: "twitch-client",
          clientSecret: "twitch-secret",
          redirectUri: "https://api.sc2tools.com/v1/integrations/twitch/callback",
          callbackUrl: "https://api.sc2tools.com/v1/webhooks/twitch/eventsub",
          webhookSecret: "strong-eventsub-secret",
        },
        kick: null,
        youtube: null,
      },
      now: () => now,
      overlayTokens: { list: async () => [] },
      oauth: {
        ...oauth,
        validateTwitchUserToken,
        getTwitchAppToken,
        reconcileTwitchEventSubscriptions,
      },
    });
    await service.vault.saveConnection("user-1", "twitch", {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      platformUserId: "broadcaster-1",
      platformUserName: "Streamer",
      scopes: oauth.TWITCH_SCOPES,
      metadata: {
        subscriptionsReady: false,
        // A recent timestamp from another process must not skip this
        // process's startup validation.
        lastTokenValidatedAt: new Date(now),
      },
    });

    await expect(service.reconcileProviderHealthOnce()).resolves.toEqual({ checked: 1 });
    expect(validateTwitchUserToken).toHaveBeenCalledTimes(1);
    expect(reconcileTwitchEventSubscriptions).toHaveBeenCalledTimes(1);
    now += 30 * 60 * 1000;
    await service.reconcileProviderHealthOnce();
    expect(validateTwitchUserToken).toHaveBeenCalledTimes(1);
    expect(reconcileTwitchEventSubscriptions).toHaveBeenCalledTimes(2);
    now += 31 * 60 * 1000;
    await service.reconcileProviderHealthOnce();
    expect(validateTwitchUserToken).toHaveBeenCalledTimes(2);
    expect(await service.vault.getConnection("user-1", "twitch"))
      .toMatchObject({ ready: true, lastError: null, scopes: oauth.TWITCH_SCOPES });
  });

  test("Twitch health refreshes a 401 token, verifies identity/scopes, and CAS-stores it", async () => {
    const fake = fakeVaultDb();
    const validateTwitchUserToken = jest.fn()
      .mockRejectedValueOnce(new oauth.PlatformOauthError("twitch_token_validate", "expired", 401))
      .mockResolvedValueOnce({
        userId: "broadcaster-1",
        userName: "Streamer",
        scopes: oauth.TWITCH_SCOPES,
        expiresInSeconds: 7_200,
      });
    const refreshTwitchToken = jest.fn(async () => ({
      accessToken: "refreshed-access",
      refreshToken: "rotated-refresh",
      expiresAt: new Date(NOW + 7_200_000),
      scopes: [],
    }));
    const reconcileTwitchEventSubscriptions = jest.fn(async () => ({ existing: [], created: [] }));
    const service = new PlatformIntegrationsService(fake.db, {
      config: {
        enabled: true,
        encryptionKey: KEY,
        twitch: {
          clientId: "twitch-client",
          clientSecret: "twitch-secret",
          redirectUri: "https://api.sc2tools.com/v1/integrations/twitch/callback",
          callbackUrl: "https://api.sc2tools.com/v1/webhooks/twitch/eventsub",
          webhookSecret: "strong-eventsub-secret",
        },
        kick: null,
        youtube: null,
      },
      now: () => NOW,
      overlayTokens: { list: async () => [] },
      oauth: {
        ...oauth,
        validateTwitchUserToken,
        refreshTwitchToken,
        getTwitchAppToken: async () => "app-token",
        reconcileTwitchEventSubscriptions,
      },
    });
    await service.vault.saveConnection("user-1", "twitch", {
      accessToken: "expired-access",
      refreshToken: "refresh-token",
      platformUserId: "broadcaster-1",
      platformUserName: "Streamer",
      scopes: oauth.TWITCH_SCOPES,
      metadata: { subscriptionsReady: false },
    });

    await service.reconcileProviderHealthOnce();
    expect(refreshTwitchToken).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "twitch-client" }),
      "refresh-token",
      expect.any(Function),
    );
    expect(validateTwitchUserToken).toHaveBeenNthCalledWith(
      2,
      "refreshed-access",
      expect.any(Function),
    );
    expect(await service.vault.getConnection("user-1", "twitch"))
      .toMatchObject({
        accessToken: "refreshed-access",
        refreshToken: "rotated-refresh",
        platformUserId: "broadcaster-1",
        scopes: oauth.TWITCH_SCOPES,
        ready: true,
      });
    expect(reconcileTwitchEventSubscriptions).toHaveBeenCalledTimes(1);

    // A rotated token is never trusted merely because refresh succeeded: its
    // validated identity must still be the stored broadcaster.
    validateTwitchUserToken
      .mockRejectedValueOnce(new oauth.PlatformOauthError("twitch_token_validate", "expired", 401))
      .mockResolvedValueOnce({
        userId: "different-broadcaster",
        scopes: oauth.TWITCH_SCOPES,
        expiresInSeconds: 7_200,
      });
    await service.vault.saveConnection("user-2", "twitch", {
      accessToken: "other-expired-access",
      refreshToken: "other-refresh-token",
      platformUserId: "broadcaster-2",
      scopes: oauth.TWITCH_SCOPES,
      metadata: { subscriptionsReady: true },
    });
    await service.reconcileProviderHealthOnce();
    expect(await service.vault.getConnection("user-2", "twitch")).toBeNull();
    expect(reconcileTwitchEventSubscriptions).toHaveBeenCalledTimes(2);
  });

  test("Twitch health discards only the invalid revision when reauthorization is definitive", async () => {
    const fake = fakeVaultDb();
    const reconcileTwitchEventSubscriptions = jest.fn();
    const service = new PlatformIntegrationsService(fake.db, {
      config: {
        enabled: true,
        encryptionKey: KEY,
        twitch: {
          clientId: "twitch-client",
          clientSecret: "twitch-secret",
          redirectUri: "https://api.sc2tools.com/v1/integrations/twitch/callback",
          callbackUrl: "https://api.sc2tools.com/v1/webhooks/twitch/eventsub",
          webhookSecret: "strong-eventsub-secret",
        },
        kick: null,
        youtube: null,
      },
      now: () => NOW,
      overlayTokens: { list: async () => [] },
      oauth: {
        ...oauth,
        validateTwitchUserToken: async () => {
          throw new oauth.PlatformOauthError("twitch_token_validate", "expired", 401);
        },
        getTwitchAppToken: async () => "app-token",
        reconcileTwitchEventSubscriptions,
      },
    });
    await service.vault.saveConnection("user-1", "twitch", {
      accessToken: "invalid-access",
      platformUserId: "broadcaster-1",
      scopes: oauth.TWITCH_SCOPES,
      metadata: { subscriptionsReady: true },
    });

    await expect(service.reconcileProviderHealthOnce()).resolves.toEqual({ checked: 1 });
    expect(await service.vault.getConnection("user-1", "twitch")).toBeNull();
    expect(reconcileTwitchEventSubscriptions).not.toHaveBeenCalled();
  });

  test("Twitch health retains a valid grant but requests reconnect for newly required scopes", async () => {
    const fake = fakeVaultDb();
    const reconcileTwitchEventSubscriptions = jest.fn();
    const oldScopes = ["moderator:read:followers", "channel:read:redemptions"];
    const service = new PlatformIntegrationsService(fake.db, {
      config: {
        enabled: true,
        encryptionKey: KEY,
        twitch: {
          clientId: "twitch-client",
          clientSecret: "twitch-secret",
          redirectUri: "https://api.sc2tools.com/v1/integrations/twitch/callback",
          callbackUrl: "https://api.sc2tools.com/v1/webhooks/twitch/eventsub",
          webhookSecret: "strong-eventsub-secret",
        },
        kick: null,
        youtube: null,
      },
      now: () => NOW,
      overlayTokens: { list: async () => [] },
      oauth: {
        ...oauth,
        validateTwitchUserToken: async () => ({
          userId: "broadcaster-1",
          scopes: oldScopes,
          expiresInSeconds: 3_600,
        }),
        getTwitchAppToken: async () => "app-token",
        reconcileTwitchEventSubscriptions,
      },
    });
    await service.vault.saveConnection("user-1", "twitch", {
      accessToken: "valid-old-scope-access",
      refreshToken: "refresh-token",
      platformUserId: "broadcaster-1",
      scopes: oldScopes,
      metadata: { subscriptionsReady: true },
    });

    await service.reconcileProviderHealthOnce();
    expect(await service.vault.getConnection("user-1", "twitch"))
      .toMatchObject({
        connected: true,
        ready: false,
        scopes: oldScopes,
        lastError: expect.stringContaining("channel:read:subscriptions"),
      });
    expect(reconcileTwitchEventSubscriptions).not.toHaveBeenCalled();
  });

  test("Twitch validation cadence remains hourly when health interval is misconfigured higher", async () => {
    const fake = fakeVaultDb();
    const setIntervalSpy = jest.spyOn(global, "setInterval")
      .mockImplementation(() => ({ unref: jest.fn() }));
    const clearIntervalSpy = jest.spyOn(global, "clearInterval").mockImplementation(() => {});
    const service = new PlatformIntegrationsService(fake.db, {
      config: {
        enabled: true,
        encryptionKey: KEY,
        providerHealthIntervalMs: 6 * 60 * 60 * 1000,
        twitch: {
          clientId: "twitch-client",
          clientSecret: "twitch-secret",
          redirectUri: "https://api.sc2tools.com/v1/integrations/twitch/callback",
          callbackUrl: "https://api.sc2tools.com/v1/webhooks/twitch/eventsub",
          webhookSecret: "strong-eventsub-secret",
        },
        kick: null,
        youtube: null,
      },
      now: () => NOW,
      overlayTokens: { list: async () => [] },
    });
    try {
      service.start();
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60 * 60 * 1000);
      await service.stop();
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  test("provider revocation calls use the official request contracts", async () => {
    const requests = [];
    const fetchImpl = jest.fn(async (url, init) => {
      requests.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        headers: { get: () => "0" },
        text: async () => "",
      };
    });
    await oauth.revokeTwitchToken({ clientId: "tw-client" }, "tw-token", fetchImpl);
    await oauth.revokeKickToken("kick-token", fetchImpl);
    await oauth.revokeYoutubeToken("google-refresh", fetchImpl);
    expect(requests[0]).toMatchObject({
      url: "https://id.twitch.tv/oauth2/revoke",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      },
    });
    expect(new URLSearchParams(requests[0].init.body).get("client_id")).toBe("tw-client");
    expect(new URLSearchParams(requests[0].init.body).get("token")).toBe("tw-token");
    expect(new URL(requests[1].url).searchParams.get("token")).toBe("kick-token");
    expect(requests[1].init.body).toBeUndefined();
    expect(new URLSearchParams(requests[2].init.body).get("token"))
      .toBe("google-refresh");
  });

  test("Kick refresh uses the official rotating refresh-token form contract", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
      scope: "user:read channel:read events:subscribe",
    }));
    await expect(oauth.refreshKickToken({
      clientId: "kick-client",
      clientSecret: "kick-secret",
      redirectUri: "https://api.sc2tools.com/v1/integrations/kick/callback",
    }, "old-refresh", fetchImpl)).resolves.toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh",
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://id.kick.com/oauth/token");
    const form = new URLSearchParams(init.body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("client_id")).toBe("kick-client");
    expect(form.get("client_secret")).toBe("kick-secret");
    expect(form.get("refresh_token")).toBe("old-refresh");
  });

  test("Twitch refresh uses the official refresh-token form contract", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
      scope: oauth.TWITCH_SCOPES,
    }));
    await expect(oauth.refreshTwitchToken({
      clientId: "twitch-client",
      clientSecret: "twitch-secret",
      redirectUri: "https://api.sc2tools.com/v1/integrations/twitch/callback",
    }, "old-refresh", fetchImpl)).resolves.toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      scopes: oauth.TWITCH_SCOPES,
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://id.twitch.tv/oauth2/token");
    const form = new URLSearchParams(init.body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("client_id")).toBe("twitch-client");
    expect(form.get("client_secret")).toBe("twitch-secret");
    expect(form.get("refresh_token")).toBe("old-refresh");
  });

  test("disconnect deletes local credentials even when upstream revocation fails", async () => {
    const fake = fakeVaultDb();
    const revokeTwitchToken = jest.fn(async () => {
      throw new Error("provider unavailable");
    });
    const service = new PlatformIntegrationsService(fake.db, {
      config: {
        enabled: true,
        encryptionKey: KEY,
        twitch: {
          clientId: "client",
          clientSecret: "secret",
          webhookSecret: "a-strong-eventsub-secret",
          callbackUrl: "https://api.sc2tools.com/v1/webhooks/twitch/eventsub",
          redirectUri: "https://api.sc2tools.com/v1/integrations/twitch/callback",
        },
        kick: null,
        youtube: null,
      },
      overlayTokens: { list: async () => [] },
      oauth: { ...oauth, revokeTwitchToken },
    });
    await service.vault.saveConnection("user-1", "twitch", {
      accessToken: "access-token",
      platformUserId: "broadcaster-1",
      platformUserName: "Streamer",
    });
    await expect(service.disconnect("user-1", "twitch")).resolves.toBe(true);
    expect(revokeTwitchToken).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "client" }),
      "access-token",
      expect.any(Function),
    );
    expect(fake.rows.has("user-1:twitch")).toBe(false);
  });

  test("switching or reconnecting Twitch retires each replaced grant", async () => {
    const fake = fakeVaultDb();
    const revokeTwitchToken = jest.fn(async () => {});
    const reconcileTwitchEventSubscriptions = jest.fn(async () => ({ existing: [], created: [] }));
    const service = new PlatformIntegrationsService(fake.db, {
      config: {
        enabled: true,
        encryptionKey: KEY,
        twitch: {
          clientId: "client",
          clientSecret: "secret",
          webhookSecret: "a-strong-eventsub-secret",
          callbackUrl: "https://api.sc2tools.com/v1/webhooks/twitch/eventsub",
          redirectUri: "https://api.sc2tools.com/v1/integrations/twitch/callback",
        },
        kick: null,
        youtube: null,
      },
      overlayTokens: { list: async () => [] },
      oauth: {
        ...oauth,
        revokeTwitchToken,
        getTwitchAppToken: async () => "app-token",
        reconcileTwitchEventSubscriptions,
      },
    });
    await service.vault.saveConnection("user-1", "twitch", {
      accessToken: "old-token",
      platformUserId: "old-broadcaster",
      platformUserName: "Old",
    });
    const install = (accessToken) => service._installConnection({
      userId: "user-1",
      platform: "twitch",
      provider: service.config.twitch,
      token: { accessToken, scopes: oauth.TWITCH_SCOPES },
      identity: { userId: "new-broadcaster", userName: "New" },
    });
    await install("new-token");
    await install("newer-token");
    expect(revokeTwitchToken).toHaveBeenCalledTimes(2);
    expect(revokeTwitchToken).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ clientId: "client" }),
      "old-token",
      expect.any(Function),
    );
    expect(revokeTwitchToken).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ clientId: "client" }),
      "new-token",
      expect.any(Function),
    );
    expect((await service.vault.getConnection("user-1", "twitch")))
      .toMatchObject({ platformUserId: "new-broadcaster", accessToken: "newer-token" });
    expect(reconcileTwitchEventSubscriptions).toHaveBeenCalledTimes(2);
  });

  test("OAuth result page only links to an HTTPS configured return URL", () => {
    expect(callbackPage("twitch", true, "", "https://sc2tools.com/settings#overlay"))
      .toContain('href="https://sc2tools.com/settings#overlay"');
    expect(callbackPage("twitch", true, "", "javascript:alert(1)"))
      .not.toContain("javascript:");
  });

  test("YouTube poll seeds history, then emits each newly public subscriber once", async () => {
    const fake = fakeVaultDb();
    let items = [{
      id: "old-sub",
      subscriberSnippet: { title: "Existing viewer" },
      snippet: { publishedAt: new Date(NOW - 60_000).toISOString() },
    }];
    const service = new PlatformIntegrationsService(fake.db, {
      config: {
        enabled: true,
        encryptionKey: KEY,
        twitch: null,
        kick: null,
        youtube: {
          clientId: "google-client",
          clientSecret: "google-secret",
          redirectUri: "https://api.sc2tools.com/v1/integrations/youtube/callback",
        },
      },
      now: () => NOW,
      overlayTokens: { list: async () => [] },
      oauth: {
        ...oauth,
        listYoutubeRecentSubscribers: async () => items,
      },
    });
    await service.vault.saveConnection("user-1", "youtube", {
      accessToken: "token",
      refreshToken: "refresh",
      expiresAt: new Date(NOW + 3_600_000),
      platformUserId: "channel-1",
      platformUserName: "Streamer",
      metadata: { youtubeInitialized: false, youtubeSeenIds: [] },
    });
    await service.pollYoutubeOnce();
    expect(fake.eventRows).toHaveLength(0);
    expect((await service.statuses("user-1")).platforms.find((row) => row.platform === "youtube").ready)
      .toBe(true);
    items = [{
      id: "new-sub",
      subscriberSnippet: { title: "New viewer" },
      snippet: { publishedAt: new Date(NOW + 1_000).toISOString() },
    }, ...items];
    await service.pollYoutubeOnce();
    await service.pollYoutubeOnce();
    expect(fake.eventRows).toHaveLength(1);
    expect(fake.eventRows[0].event).toMatchObject({
      platform: "youtube",
      kind: "follow",
      user: "New viewer",
    });
  });

  test("a stale YouTube poll cannot publish or overwrite a reconnected account", async () => {
    const fake = fakeVaultDb();
    const service = new PlatformIntegrationsService(fake.db, {
      config: {
        enabled: true,
        encryptionKey: KEY,
        twitch: null,
        kick: null,
        youtube: {
          clientId: "google-client",
          clientSecret: "google-secret",
          redirectUri: "https://api.sc2tools.com/v1/integrations/youtube/callback",
        },
      },
      now: () => NOW,
      overlayTokens: { list: async () => [] },
      oauth: {
        ...oauth,
        listYoutubeRecentSubscribers: async () => [{
          id: "old-account-new-sub",
          subscriberSnippet: { title: "Wrong account viewer" },
          snippet: { publishedAt: new Date(NOW).toISOString() },
        }],
      },
    });
    await service.vault.saveConnection("user-1", "youtube", {
      accessToken: "old-token",
      refreshToken: "old-refresh",
      expiresAt: new Date(NOW + 3_600_000),
      platformUserId: "old-channel",
      platformUserName: "Old",
      metadata: { youtubeInitialized: true, youtubeSeenIds: [] },
    });
    const stale = {
      ...(await service.vault.getConnection("user-1", "youtube")),
      userId: "user-1",
    };
    await service.vault.saveConnection("user-1", "youtube", {
      accessToken: "new-token",
      refreshToken: "new-refresh",
      expiresAt: new Date(NOW + 3_600_000),
      platformUserId: "new-channel",
      platformUserName: "New",
      metadata: { youtubeInitialized: true, youtubeSeenIds: ["kept"] },
    });
    await service._pollYoutubeConnection(stale);
    expect(fake.eventRows).toHaveLength(0);
    expect(await service.vault.getConnection("user-1", "youtube"))
      .toMatchObject({
        platformUserId: "new-channel",
        accessToken: "new-token",
        metadata: { youtubeInitialized: true, youtubeSeenIds: ["kept"] },
      });
  });

  test("shutdown aborts an in-flight YouTube provider request", async () => {
    const fake = fakeVaultDb();
    const fetchImpl = jest.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }));
    const service = new PlatformIntegrationsService(fake.db, {
      config: {
        enabled: true,
        encryptionKey: KEY,
        twitch: null,
        kick: null,
        youtube: {
          clientId: "google-client",
          clientSecret: "google-secret",
          redirectUri: "https://api.sc2tools.com/v1/integrations/youtube/callback",
        },
      },
      fetchImpl,
      overlayTokens: { list: async () => [] },
    });
    await service.vault.saveConnection("user-1", "youtube", {
      accessToken: "token",
      refreshToken: "refresh",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      platformUserId: "channel-1",
      platformUserName: "Streamer",
      metadata: { youtubeInitialized: true, youtubeSeenIds: [] },
    });
    const poll = service.pollYoutubeOnce();
    await new Promise((resolve) => setImmediate(resolve));
    await expect(service.stop()).resolves.toBeUndefined();
    await expect(poll).resolves.toEqual({ checked: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("config is disabled safely, all-or-none, and key-gated", () => {
    expect(parsePlatformIntegrationsConfig({}).enabled).toBe(false);
    expect(() => parsePlatformIntegrationsConfig({ TWITCH_CLIENT_ID: "id" }))
      .toThrow(/must be set together/);
    expect(() => parsePlatformIntegrationsConfig({
      TWITCH_CLIENT_ID: "id",
      TWITCH_CLIENT_SECRET: "secret",
      TWITCH_EVENTSUB_SECRET: "long-enough-secret",
    })).toThrow(/PLATFORM_TOKEN_ENCRYPTION_KEY/);
    const cfg = parsePlatformIntegrationsConfig({
      TWITCH_CLIENT_ID: "id",
      TWITCH_CLIENT_SECRET: "secret",
      TWITCH_EVENTSUB_SECRET: "long-enough-secret",
      PLATFORM_TOKEN_ENCRYPTION_KEY: KEY.toString("hex"),
    });
    expect(cfg.twitch.callbackUrl).toBe("https://api.sc2tools.com/v1/webhooks/twitch/eventsub");
    expect(() => parsePlatformIntegrationsConfig({
      TWITCH_CLIENT_ID: "id",
      TWITCH_CLIENT_SECRET: "secret",
      TWITCH_EVENTSUB_SECRET: "too-short",
      PLATFORM_TOKEN_ENCRYPTION_KEY: KEY.toString("hex"),
    })).toThrow(/10 to 100 printable ASCII/);
    expect(() => parsePlatformIntegrationsConfig({
      TWITCH_CLIENT_ID: "id",
      TWITCH_CLIENT_SECRET: "secret",
      TWITCH_EVENTSUB_SECRET: `valid-secret${String.fromCharCode(10)}`,
      PLATFORM_TOKEN_ENCRYPTION_KEY: KEY.toString("hex"),
    })).toThrow(/printable ASCII/);
  });

  test("persists before socket fan-out, dedupes, and replays without sound", async () => {
    const rows = [];
    const emitted = [];
    let replayFilter = null;
    const collection = {
      async insertOne(row) {
        if (rows.some((item) => item.eventId === row.eventId)) {
          throw Object.assign(new Error("duplicate"), { code: 11000 });
        }
        rows.push(row);
      },
      find(filter) {
        replayFilter = filter;
        return {
          sort() { return this; },
          limit() { return this; },
          async toArray() { return rows.map((row) => ({ event: row.event })); },
        };
      },
    };
    const service = new PlatformEventsService(
      { platformEvents: collection },
      {
        now: () => NOW,
        overlayTokens: { list: async () => [{ token: "overlay-1" }] },
        io: { to: (room) => ({ emit: (name, payload) => emitted.push({ room, name, payload, persisted: rows.length }) }) },
      },
    );
    // Provider occurrence time can predate the replay window; receipt time is
    // what determines whether an event was missed by a disconnected overlay.
    const event = { platform: "twitch", id: "e1", kind: "follow", user: "Alpha", detail: "followed", atMs: NOW - 30 * 60 * 1000 };
    expect(await service.publish("user-1", event)).toBe(true);
    expect(emitted[0]).toMatchObject({ room: "overlay:overlay-1", name: "overlay:platformEvent", persisted: 1 });
    expect(await service.publish("user-1", event)).toBe(false);
    expect(emitted).toHaveLength(1);
    expect(await service.recentForUser("user-1")).toEqual([
      expect.objectContaining({ id: "e1", replayed: true }),
    ]);
    expect(replayFilter).toEqual({
      userId: "user-1",
      receivedAt: { $gte: new Date(NOW - 15 * 60 * 1000) },
    });
  });
});

function jsonResponse(body, status = 200) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => String(Buffer.byteLength(text)) },
    text: async () => text,
  };
}
