"use strict";
const express = require("express");
const request = require("supertest");
const { buildChatbotRouter } = require("../src/routes/chatbot");
const { buildMultichatRouter } = require("../src/routes/multichat");
const { buildChatCommandsOwnerRouter } = require("../src/routes/chatCommandsOwner");
const { ChatCommandService } = require("../src/services/chatCommandService");
const { TwitchChatBotService } = require("../src/services/twitchChatBot");
const { CHAT_COMMANDS } = require("../src/services/chatCommands");

const SITE_REPLY = "SC2 Tools analyzes StarCraft II replays and powers stream overlays.";

/** @param {Array<{id:string,enabled:boolean,includeLink?:boolean}>} [builtins] */
function fixture(builtins = []) {
  let now = 100000;
  const overlayTokens = { resolve: jest.fn(async token => token === "owned" ? { userId: "owner" } : null), list: async () => [] };
  const users = { getPreferences: jest.fn(async () => ({ builtins, custom: [{ trigger: "hello", response: "Hi {user}; {record}" }] })) };
  const chatbot = { commandLine: jest.fn(async (_token, command, argument) => `<b>${command}</b> reply${argument ? ` ${argument}` : ""}`) };
  const commands = new ChatCommandService(/** @type {any} */ ({ overlayTokens, users, chatbot, now: () => now }));
  const app = express(); app.use(express.json());
  app.use(buildChatbotRouter(/** @type {any} */ ({ chatbot, commands })));
  app.use(buildMultichatRouter(/** @type {any} */ ({ overlayTokens, users, commands, studio: {}, tiktokRelay: {} })));
  app.use(buildChatCommandsOwnerRouter({ commands, auth: (req, _res, next) => { req.auth = /** @type {any} */ ({ userId: "owner" }); next(); } }));
  const bot = new TwitchChatBotService(/** @type {any} */ ({ db: {}, users, overlayTokens, chatbot, chatCommands: commands, now: () => now }));
  return { app, bot, commands, chatbot, tick: () => { now += 15000; } };
}

describe("registry transport parity", () => {
  test.each(CHAT_COMMANDS.map(command => command.id))("%s has the same plain reply in Nightbot, multichat, Twitch and owner preview", async command => {
    const site = command === "sc2tools";
    const { app, bot, tick } = fixture(site ? [{ id: command, enabled: true }] : []);
    const expected = site ? SITE_REPLY : `${command} reply${command === "winrate" ? " PvZ" : ""}`;
    const argument = command === "winrate" ? "PvZ" : "";
    const nightbot = await request(app).get(`/chatbot/owned/${command}`).query({ args: argument, user: "Viewer" });
    expect(nightbot.status).toBe(200); expect(nightbot.text).toBe(expected);
    expect(nightbot.headers["content-type"]).toContain("text/plain"); expect(nightbot.headers["cache-control"]).toBe("no-store");
    const stream = await request(app).post("/multichat/owned/command").send({ command, argument, platform: "twitch", user: "Viewer" });
    expect(stream.status).toBe(200); expect(stream.body.text).toBe(expected);
    tick(); expect(await bot._answerCommand({ overlayToken: "owned" }, command, "Viewer", argument)).toBe(expected);
    const preview = await request(app).post("/me/chat-commands/try").send({ token: "owned", command, argument, user: "Viewer" });
    expect(preview.status).toBe(200); expect(preview.body.text).toBe(expected);
  });
  test("the opt-in link reaches chat and owner preview while the browser source receives text only", async () => {
    const command = "sc2tools";
    const { app } = fixture([{ id: command, enabled: true, includeLink: true }]);
    const nightbot = await request(app).get(`/chatbot/owned/${command}`);
    expect(nightbot.status).toBe(200);
    expect(nightbot.text).toBe(`${SITE_REPLY} https://sc2tools.com`);
    const stream = await request(app).post("/multichat/owned/command").send({ command, platform: "twitch", user: "Viewer" });
    expect(stream.status).toBe(200);
    expect(stream.body.text).toBe(SITE_REPLY);
    const preview = await request(app).post("/me/chat-commands/try").send({ token: "owned", command });
    expect(preview.status).toBe(200);
    expect(preview.body.text).toBe(nightbot.text);
  });
  test("custom replies have transport parity and Nightbot cooldown returns no chat text", async () => {
    const { app, bot, tick } = fixture();
    const expected = "Hi Viewer; record reply";
    expect((await request(app).get("/chatbot/owned/hello?user=Viewer")).text).toBe(expected);
    expect((await request(app).get("/chatbot/owned/hello?user=Viewer")).status).toBe(204);
    expect((await request(app).post("/multichat/owned/command").send({ command: "hello", user: "Viewer", platform: "kick" })).body.text).toBe(expected);
    tick(); expect(await bot._answerCommand({ overlayToken: "owned" }, "hello", "Viewer")).toBe(expected);
  });
  test("invalid or retired credentials cannot compose replies", async () => {
    const { app, chatbot } = fixture();
    expect((await request(app).get("/chatbot/retired/record")).status).toBe(404);
    expect((await request(app).post("/multichat/retired/command").send({ command: "record", user: "Viewer", platform: "twitch" })).status).toBe(401);
    expect((await request(app).post("/me/chat-commands/try").send({ token: "retired", command: "record" })).status).toBe(404);
    expect(chatbot.commandLine).not.toHaveBeenCalled();
  });
});
