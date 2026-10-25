"use strict";
const { CHAT_COMMANDS, sanitizeChatCommands, CommandCooldowns, plainText } = require("../src/services/chatCommands");
const { ChatCommandService } = require("../src/services/chatCommandService");
const { ChatStatsService } = require("../src/services/chatStats");
const { ChatbotService } = require("../src/services/chatbot");

describe("shared chat registry", () => {
  test("contains every planned deterministic reply with distinct aliases", () => {
    expect(CHAT_COMMANDS.map(command => command.id)).toEqual(["opponent", "mmr", "build", "record", "winrate", "streak", "lastgame", "h2h", "peak", "oracle", "uptime"]);
    const names = CHAT_COMMANDS.flatMap(command => [command.id, ...command.aliases]);
    expect(new Set(names).size).toBe(names.length);
  });
  test.each([
    { custom: Array.from({ length: 26 }, (_, n) => ({ trigger: `custom${n}`, response: "Hello" })) },
    { custom: [{ trigger: "rank", response: "Reserved" }] },
    { custom: [{ trigger: "hello", response: "Hi {secret}" }] },
    { custom: [{ trigger: "hello", response: "<script>alert(1)</script>" }] },
    { custom: [{ trigger: "hello", response: "hello\nworld" }] },
    { custom: [{ trigger: "hello", response: "Hello", platforms: ["unknown"] }] },
    { builtins: [{ id: "record", trigger: "other", cooldownSec: 4 }] },
    { builtins: [{ id: "record", trigger: "mmr" }] },
    { builtins: [{ id: "record" }, { id: "record" }] },
  ])("rejects malformed, reserved, markup or oversized preferences", raw => {
    expect(() => sanitizeChatCommands(raw, true)).toThrow();
  });
  test("normalizes safe preferences and discards corrupt legacy custom replies", () => {
    const prefs = sanitizeChatCommands({ custom: [{ trigger: "!HELLO", response: "Hi {user}" }, { trigger: "bad", response: "<b>bad</b>" }] });
    expect(prefs.custom).toHaveLength(1); expect(prefs.custom[0].trigger).toBe("hello");
    expect(plainText("<b>Hi</b>\r\n\u0000viewer")).toBe("Hi viewer");
  });
  test("command aliases share cooldown, viewer keys are platform scoped, and ledger is bounded", () => {
    let now = 1000; const ledger = new CommandCooldowns(() => now);
    expect(ledger.claim("owner", "mmr", 15, "twitch", "One")).toBe(true);
    expect(ledger.claim("owner", "mmr", 15, "kick", "Two")).toBe(false);
    expect(ledger.claim("owner", "record", 15, "twitch", "one")).toBe(false);
    expect(ledger.claim("owner", "record", 15, "kick", "one")).toBe(true);
    now += 15000; expect(ledger.claim("owner", "mmr", 15, "twitch", "one")).toBe(true);
    for (let i = 0; i < 5000; i += 1) ledger.claim(`owner${i}`, "build", 15, "twitch", "one");
    expect(ledger.entries.size).toBeLessThanOrEqual(4096);
  });
});

describe("command dispatch", () => {
  /** @param {Record<string,any>} [prefs] */
  const fixture = (prefs = {}) => {
    const deps = { overlayTokens: { resolve: jest.fn(async () => ({ userId: "owner" })) }, users: { getPreferences: jest.fn(async () => prefs) },
      chatbot: { commandLine: jest.fn(async (_token, command, arg) => `<b>${command}</b> ${arg || "value"}`) }, now: () => 1000 };
    return { service: new ChatCommandService(/** @type {any} */ (deps)), deps };
  };
  test("builtin alias and arguments reach one composer with plain clipped text", async () => {
    const { service, deps } = fixture();
    expect(await service.answer("token", { command: "session" })).toEqual({ status: "reply", command: "mmr", text: "mmr value" });
    expect(deps.chatbot.commandLine).toHaveBeenCalledWith("token", "mmr", "");
    expect((await service.answer("token", { command: "mmr" }))?.status).toBe("cooldown");
    expect((await service.answer("token", { command: "winrate", argument: "PvZ" }))?.text).toBe("winrate PvZ");
  });
  test("preview matches saved settings and text without consuming live cooldown", async () => {
    const { service } = fixture({ custom: [{ trigger: "hello", response: "Hi {user}: {record} + {record}", platforms: ["kick"], cooldownSec: 5 }] });
    const input = { command: "hello", platform: "kick", user: "<b>Alice</b>" };
    const preview = await service.answer("token", input, { previewOwner: "owner" });
    expect(preview?.text).toBe("Hi Alice: record value + record value");
    expect(await service.answer("token", input)).toEqual(preview);
    expect((await service.answer("token", input))?.status).toBe("cooldown");
    expect(await service.answer("token", input, { previewOwner: "another" })).toBeNull();
  });
  test("disabled and platform/on-stream controls are enforced before data composition", async () => {
    const { service, deps } = fixture({ builtins: [{ id: "mmr", enabled: false }], custom: [{ trigger: "hello", response: "Hi", platforms: ["kick"], answerOnStream: false }] });
    expect((await service.answer("token", { command: "mmr" }))?.status).toBe("disabled");
    expect((await service.answer("token", { command: "hello", platform: "twitch" }))?.status).toBe("disabled");
    expect((await service.answer("token", { command: "hello", platform: "kick", onStream: true }))?.status).toBe("disabled");
    expect(deps.chatbot.commandLine).not.toHaveBeenCalled();
  });
  test("revocation during composition suppresses the result", async () => {
    const { service, deps } = fixture(); deps.overlayTokens.resolve.mockResolvedValueOnce({ userId: "owner" }).mockResolvedValueOnce(/** @type {any} */ (null));
    expect(await service.answer("token", { command: "record" })).toBeNull();
  });
});

describe("bounded recorded stats", () => {
  const now = Date.parse("2026-10-25T12:00:00Z");
  const row = (/** @type {string} */ date, /** @type {string} */ outcome, mmr = 4000, region = "1") => ({ date: new Date(date), result: outcome, myRace: "Protoss", myMmr: mmr, myToonHandle: `${region}-S2-1-42`, map: "Map", opponent: { race: "Zerg", displayName: "Enemy" } });
  const service = new ChatStatsService(/** @type {any} */ ({}), { now: () => now, seasons: { cachedCurrent: region => region === "NA" ? /** @type {any} */ ({ battlenetId: 70, start: "2026-10-01" }) : null } });
  test("counts UTC day/matchup and excludes ties from decided rate denominators", () => {
    const value = service._summarize([row("2026-10-25T10:00Z", "Victory"), row("2026-10-25T09:00Z", "Tie"), row("2026-10-24", "Defeat")], false);
    expect(value.record).toContain("1W-0L"); expect(value.record).toContain("PvZ 1W-0L");
    expect(value.winrates.pvz).toContain("50% (1W-1L; n=2)"); expect(value.streak).toBe("Recorded streak: 1W.");
  });
  test("peak never mixes ratings from different regions", () => {
    const value = service._summarize([row("2026-10-25", "Win", 4000), row("2026-10-24", "Win", 6000, "2")], false);
    expect(value.peak).toBe("Recorded season 70 peak on NA: 4000 MMR (n=1 rated games).");
  });
  test("withholds incomplete safety-limited season/30-day samples", () => {
    const value = service._summarize([row("2026-10-25T10:00Z", "Win")], true);
    expect(value.winrates.all).toContain("history exceeds safety limit"); expect(value.peak).toContain("history exceeds safety limit");
    expect(value.record).toContain("history exceeds safety limit");
  });
});

test("watching a replay cannot replace the actual last opponent or build in chat replies", async () => {
  const row = { myBuild: "Recorded build", opponent: { displayName: "Recorded enemy" }, result: "Victory" };
  const service = new ChatbotService(/** @type {any} */ ({ games: { findOne: async () => row }, opponents: { findOne: async () => null } }), {
    overlayTokens: /** @type {any} */ ({ resolve: async () => ({ userId: "owner" }) }),
    games: /** @type {any} */ ({ list: async () => ({ items: [row] }) }),
    liveGameBroker: /** @type {any} */ ({ latest: () => ({ phase: "match_in_progress", isReplay: true, opponent: { name: "Replay enemy" }, myBuild: "Replay build" }), latestOverlayLive: () => null }),
  });
  expect(await service.opponentLine("token")).toContain("Recorded enemy");
  expect(await service.opponentLine("token")).not.toContain("Replay enemy");
  expect(await service.buildLine("token")).toContain("Recorded build");
});
