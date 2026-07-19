// @ts-nocheck
"use strict";

/**
 * /v1/me/chatbot — settings surface for the Twitch chat bot. The
 * core contract: the OAuth token NEVER leaves the API (GET returns
 * hasToken only), and a save without a new token keeps the stored
 * one, so toggling a checkbox can't wipe credentials.
 */

const express = require("express");
const request = require("supertest");
const { buildChatBotSettingsRouter } = require("../src/routes/chatBotSettings");

describe("routes/chatBotSettings", () => {
  let prefs;
  let configured;
  let app;

  beforeEach(() => {
    prefs = {};
    configured = [];
    const users = {
      getPreferences: async (userId, type) => prefs[`${userId}:${type}`] || {},
      updatePreferences: async (userId, type, value) => {
        prefs[`${userId}:${type}`] = value;
        return value;
      },
    };
    const twitchChatBot = {
      status: () => ({ state: "off", channel: null, lastError: null, lastConnectedAt: null }),
      configure: async (userId, cfg) => {
        configured.push({ userId, cfg });
      },
    };
    app = express();
    app.use(express.json());
    app.use(
      "/v1",
      buildChatBotSettingsRouter({
        auth: (req, _res, next) => {
          req.auth = { userId: "u1" };
          next();
        },
        users,
        twitchChatBot,
      }),
    );
  });

  test("PUT stores the config and never echoes the token back", async () => {
    const res = await request(app).put("/v1/me/chatbot").send({
      enabled: true,
      username: "sc2toolsbot",
      token: "oauth:abcdefghijklmnop",
      channel: "response",
      announceLevelUps: false,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enabled: true,
      username: "sc2toolsbot",
      channel: "response",
      hasToken: true,
      announceLevelUps: false,
    });
    expect(JSON.stringify(res.body)).not.toContain("abcdefghijklmnop");
    // Stored WITHOUT the oauth: prefix; bot applied immediately.
    expect(prefs["u1:chatbot"].token).toBe("abcdefghijklmnop");
    expect(configured).toHaveLength(1);
    expect(configured[0].cfg.token).toBe("abcdefghijklmnop");
  });

  test("saving without a token keeps the stored credential", async () => {
    prefs["u1:chatbot"] = {
      enabled: true,
      username: "sc2toolsbot",
      channel: "response",
      token: "storedtoken12345",
      replyCommands: true,
      announceOracle: true,
      announceLevelUps: true,
    };
    const res = await request(app).put("/v1/me/chatbot").send({
      enabled: true,
      username: "sc2toolsbot",
      channel: "response",
      token: "", // untouched password field
      replyCommands: false,
    });
    expect(res.status).toBe(200);
    expect(prefs["u1:chatbot"].token).toBe("storedtoken12345");
    expect(prefs["u1:chatbot"].replyCommands).toBe(false);
    // Mask placeholder also keeps the stored token.
    await request(app).put("/v1/me/chatbot").send({
      enabled: true,
      username: "sc2toolsbot",
      token: "••••••••",
    });
    expect(prefs["u1:chatbot"].token).toBe("storedtoken12345");
  });

  test("enabling without credentials 400s", async () => {
    const res = await request(app).put("/v1/me/chatbot").send({
      enabled: true,
      username: "sc2toolsbot",
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("chatbot_incomplete");
  });

  test("GET returns the masked view with runtime status", async () => {
    prefs["u1:chatbot"] = {
      enabled: true,
      username: "sc2toolsbot",
      channel: "response",
      token: "storedtoken12345",
    };
    const res = await request(app).get("/v1/me/chatbot");
    expect(res.status).toBe(200);
    expect(res.body.hasToken).toBe(true);
    expect(res.body.status).toEqual({
      state: "off",
      channel: null,
      lastError: null,
      lastConnectedAt: null,
    });
    expect(JSON.stringify(res.body)).not.toContain("storedtoken12345");
  });
});
