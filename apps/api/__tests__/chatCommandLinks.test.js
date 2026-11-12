// @ts-nocheck
"use strict";

const { GUIDE_CURRENT_ERA, GUIDE_PAGE_MIN_GAMES, GUIDE_PAGE_MIN_USERS } = require("../src/config/guides");
const { createBuildGuideLink, SC2TOOLS_LINK } = require("../src/services/chatCommandLinks");
const { ChatCommandService } = require("../src/services/chatCommandService");
const { sanitizeChatCommands } = require("../src/services/chatCommands");
const { ChatbotService } = require("../src/services/chatbot");

const name = "PvZ - Stargate into Glaives";
const slug = "stargate-into-glaives";
const link = `${SC2TOOLS_LINK}/guides/pvz/${slug}`;
const published = { published: true, overall: {
  games: GUIDE_PAGE_MIN_GAMES, users: GUIDE_PAGE_MIN_USERS, wins: 50, winRate: 0.5, ci: { low: 0.45, high: 0.55 },
} };

test("the optional flag defaults off and rejects non-boolean writes", () => {
  const legacy = sanitizeChatCommands({ builtins: [{ id: "build" }], custom: [{ trigger: "hello", response: "Hi" }] }, true);
  expect(legacy.builtins[0].includeLink).toBe(false);
  expect(legacy.custom[0].includeLink).toBe(false);
  expect(sanitizeChatCommands({ builtins: [{ id: "build", includeLink: true }] }, true).builtins[0].includeLink).toBe(true);
  expect(() => sanitizeChatCommands({ builtins: [{ id: "build", includeLink: "true" }] }, true)).toThrow();
});

test("a published guide uses the canonical catalog slug and is rechecked after an in-flight read", async () => {
  const findOne = jest.fn().mockResolvedValueOnce(published).mockResolvedValueOnce(null);
  const resolve = createBuildGuideLink({ findOne });
  await expect(Promise.all([resolve("PvZ", name), resolve("PvZ", name)])).resolves.toEqual([link, link]);
  expect(findOne).toHaveBeenCalledTimes(1);
  expect(findOne).toHaveBeenCalledWith({ key: `build:${GUIDE_CURRENT_ERA}:PvZ:${slug}`, kind: "build", era: GUIDE_CURRENT_ERA, published: true }, expect.any(Object));
  await expect(resolve("PvZ", name)).resolves.toBeNull();
  expect(findOne).toHaveBeenCalledTimes(2);
});

test("unknown builds, low-sample guides and publication lookup errors produce no URL", async () => {
  const findOne = jest.fn().mockResolvedValueOnce({ ...published, overall: { ...published.overall, users: 1 } }).mockRejectedValueOnce(new Error("Unavailable"));
  const resolve = createBuildGuideLink({ findOne });
  await expect(resolve("PvZ", "https://private.example/player")).resolves.toBeNull();
  expect(findOne).not.toHaveBeenCalled();
  await expect(resolve("PvZ", name)).resolves.toBeNull();
  await expect(resolve("PvZ", name)).resolves.toBeNull();
});

test("the linked build is the build used in the reply rather than a different recorded game", async () => {
  const overlayTokens = { resolve: async () => ({ userId: "owner" }) };
  const games = { findOne: jest.fn(async () => ({ myBuild: name, myRace: "Protoss", opponent: { race: "Zerg" } })) };
  const guideStats = { findOne: jest.fn(async () => published) };
  const chatbot = new ChatbotService({ games, guideStats }, { overlayTokens });
  await expect(chatbot.buildLine("token")).resolves.toContain(name);
  expect(guideStats.findOne).not.toHaveBeenCalled();
  await expect(chatbot.buildReply("token", true)).resolves.toEqual({ text: `Last opener: ${name} (PvZ)`, link });
  const liveGameBroker = { latest: () => ({ myBuild: name, myRace: "Protoss", opponent: { race: "Zerg" } }) };
  const liveChatbot = new ChatbotService({ games, guideStats }, { overlayTokens, liveGameBroker });
  games.findOne.mockClear();
  await expect(liveChatbot.buildReply("token", true)).resolves.toEqual({ text: `Current build: ${name}`, link });
  expect(games.findOne).not.toHaveBeenCalled();
});

function fixture(prefs = {}) {
  const chatbot = {
    commandLine: jest.fn(async () => "Unlinked build"),
    buildReply: jest.fn(async () => ({ text: "x".repeat(450), link })),
  };
  const service = new ChatCommandService({ overlayTokens: { resolve: async () => ({ userId: "owner" }) },
    users: { getPreferences: async () => prefs }, chatbot, now: () => 1000 });
  return { service, chatbot };
}

test("only explicit chat opt-in reserves room for the full URL in a 380-character line", async () => {
  const legacy = fixture();
  expect((await legacy.service.answer("token", { command: "build" })).text).toBe("Unlinked build");
  expect(legacy.chatbot.buildReply).not.toHaveBeenCalled();
  const { service, chatbot } = fixture({ builtins: [{ id: "build", includeLink: true }] });
  expect((await service.answer("token", { command: "build", onStream: true })).text).toBe("Unlinked build");
  expect(chatbot.buildReply).not.toHaveBeenCalled();
  const answer = await service.answer("token", { command: "build" });
  expect(answer.text).toHaveLength(380);
  expect(answer.text.endsWith(`… ${link}`)).toBe(true);
});

test("clipping before the URL leaves whole emoji at the boundary", async () => {
  const { service, chatbot } = fixture({ builtins: [{ id: "build", includeLink: true }] });
  const prefix = "x".repeat(380 - link.length - 3);
  chatbot.buildReply.mockResolvedValue({ text: `${prefix}😀 later`, link });
  await expect(service.answer("token", { command: "build" })).resolves.toMatchObject({ text: `${prefix}… ${link}` });
});

test("!sc2tools is disabled by default, and a saved custom reply keeps precedence", async () => {
  const disabled = fixture({ builtins: [{ id: "sc2tools", includeLink: true }] });
  expect((await disabled.service.answer("token", { command: "sc2tools" })).status).toBe("disabled");
  const legacy = { builtins: [{ id: "sc2tools", trigger: "toolsite", enabled: true, includeLink: true }],
    custom: [{ trigger: "!SC2TOOLS", response: "My custom reply" }] };
  expect(sanitizeChatCommands(legacy, true).custom).toHaveLength(1);
  expect(() => sanitizeChatCommands({ custom: [...legacy.custom, ...legacy.custom] }, true)).toThrow();
  const { service } = fixture(legacy);
  expect((await service.answer("token", { command: "sc2tools" })).text).toBe("My custom reply");
  expect((await service.answer("token", { command: "toolsite" })).text.endsWith(SC2TOOLS_LINK)).toBe(true);
});

test("a legacy builtin alias keeps its saved settings when !sc2tools is introduced", async () => {
  const alias = { id: "mmr", trigger: "sc2tools", enabled: true, cooldownSec: 25 };
  const prefs = { builtins: [{ id: "sc2tools", enabled: true, includeLink: true }, alias] };
  expect(sanitizeChatCommands(prefs, true).builtins[1]).toMatchObject(alias);
  const { service, chatbot } = fixture(prefs);
  await expect(service.answer("token", { command: "sc2tools" })).resolves.toMatchObject({ command: "mmr", text: "Unlinked build" });
  expect(chatbot.commandLine).toHaveBeenCalledWith("token", "mmr", "");
});

test("linked replies share a cooldown across commands and platforms while owner preview stays exact", async () => {
  const { service } = fixture({ builtins: [{ id: "build", includeLink: true }, { id: "sc2tools", enabled: true, includeLink: true }] });
  expect((await service.answer("token", { command: "sc2tools" }, { previewOwner: "owner" })).text.endsWith(SC2TOOLS_LINK)).toBe(true);
  expect((await service.answer("token", { command: "build", platform: "twitch" })).text.endsWith(link)).toBe(true);
  expect((await service.answer("token", { command: "sc2tools", platform: "kick" })).text).not.toContain(SC2TOOLS_LINK);
});
