// @ts-nocheck
"use strict";

/**
 * TwitchChatBotService — the bot that talks back in chat.
 *
 * Everything runs against a fake WebSocket factory (no network, no
 * Mongo): handshake order, PING/PONG, auth-failure parking, chat →
 * engagement ingest, command replies (race-themed !rank, ChatbotService
 * lines), cooldowns, and engagement-event announcements with dedupe.
 */

const {
  TwitchChatBotService,
  normalizeConfig,
  parseIrcLine,
  COMMAND_COOLDOWN_MS,
} = require("../src/services/twitchChatBot");

class FakeWs {
  constructor() {
    this.sent = [];
    this.listeners = {};
    this.closed = false;
  }
  addEventListener(ev, fn) {
    (this.listeners[ev] = this.listeners[ev] || []).push(fn);
  }
  send(line) {
    this.sent.push(line.trim());
  }
  close() {
    this.closed = true;
  }
  emit(ev, arg) {
    for (const fn of this.listeners[ev] || []) fn(arg);
  }
  serverSays(line) {
    this.emit("message", { data: `${line}\r\n` });
  }
}

const CFG = {
  enabled: true,
  username: "sc2toolsbot",
  token: "abcdefghijklmnop",
  channel: "response",
  replyCommands: true,
  announceOracle: true,
  announceLevelUps: true,
};

const flush = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

describe("services/twitchChatBot", () => {
  let sockets;
  let deps;
  let bot;

  beforeEach(() => {
    jest.useFakeTimers();
    sockets = [];
    deps = {
      db: { users: { find: () => ({ limit: () => ({ toArray: async () => [] }) }) } },
      users: {
        getPreferences: jest.fn(async () => ({
          engagement: { rankRace: "terran" },
        })),
      },
      overlayTokens: {
        list: jest.fn(async () => [{ token: "tokA" }]),
        resolve: jest.fn(async () => ({ userId: "u1" })),
      },
      engagement: {
        ingest: jest.fn(async () => ({ accepted: 1 })),
        viewerStats: jest.fn(async () => ({
          user: "Alice",
          found: true,
          xp: 512,
          level: 3,
          nextLevel: 4,
          xpToNext: 148,
          messages: 200,
          oracleScore: 20,
        })),
      },
      chatbot: {
        mmrLine: jest.fn(async () => "Session: 5-2 · +34 MMR (NA 4530)"),
        opponentLine: jest.fn(async () => "Now playing: Printf (Z, 4612)"),
        buildLine: jest.fn(async () => "Last build: Stargate Opener (55%)"),
      },
      wsFactory: () => {
        const ws = new FakeWs();
        sockets.push(ws);
        return ws;
      },
    };
    bot = new TwitchChatBotService(deps);
  });

  afterEach(() => {
    bot.stopAll();
    jest.useRealTimers();
  });

  async function connectBot() {
    await bot.configure("u1", CFG);
    const ws = sockets[sockets.length - 1];
    ws.emit("open");
    ws.serverSays(":tmi.twitch.tv 001 sc2toolsbot :Welcome, GLHF!");
    await flush();
    return ws;
  }

  /** Drain the rate-limited send queue. */
  async function drainSends() {
    for (let i = 0; i < 6; i += 1) {
      jest.advanceTimersByTime(1_500);
      await flush();
    }
  }

  test("handshake sends CAP/PASS/NICK, joins on welcome, reports connected", async () => {
    const ws = await connectBot();
    expect(ws.sent[0]).toBe("CAP REQ :twitch.tv/tags twitch.tv/commands");
    expect(ws.sent[1]).toBe("PASS oauth:abcdefghijklmnop");
    expect(ws.sent[2]).toBe("NICK sc2toolsbot");
    expect(ws.sent[3]).toBe("JOIN #response");
    expect(bot.status("u1")).toMatchObject({ state: "connected", channel: "response" });
  });

  test("answers PING with PONG", async () => {
    const ws = await connectBot();
    ws.serverSays("PING :tmi.twitch.tv");
    expect(ws.sent).toContain("PONG :tmi.twitch.tv");
  });

  test("a failed login parks in auth_failed and never reconnects", async () => {
    await bot.configure("u1", CFG);
    const ws = sockets[0];
    ws.emit("open");
    ws.serverSays(":tmi.twitch.tv NOTICE * :Login authentication failed");
    await flush();
    expect(bot.status("u1").state).toBe("auth_failed");
    expect(ws.closed).toBe(true);
    jest.advanceTimersByTime(10 * 60_000);
    await flush();
    expect(sockets).toHaveLength(1);
  });

  test("a dropped socket reconnects with backoff", async () => {
    const ws = await connectBot();
    ws.emit("close");
    expect(sockets).toHaveLength(1);
    jest.advanceTimersByTime(2_100);
    await flush();
    expect(sockets).toHaveLength(2);
  });

  test("chat messages flow into engagement ingest with the IRC tag id", async () => {
    const ws = await connectBot();
    ws.serverSays(
      "@id=msg-1;display-name=Alice :alice!alice@alice.tmi.twitch.tv PRIVMSG #response :!win",
    );
    await flush();
    expect(deps.engagement.ingest).toHaveBeenCalledWith("tokA", [
      expect.objectContaining({ platform: "twitch", id: "msg-1", user: "Alice", text: "!win" }),
    ]);
  });

  test("!rank replies with the race-themed rank in chat", async () => {
    const ws = await connectBot();
    ws.serverSays(
      "@id=m2;display-name=Alice :alice!alice@a.tmi.twitch.tv PRIVMSG #response :!rank",
    );
    await flush();
    await drainSends();
    const reply = ws.sent.find((l) => l.startsWith("PRIVMSG"));
    // Terran ladder: level 3 = Reaper, next = Hellion.
    expect(reply).toContain("@Alice Reaper (Lv 3) · 512 XP — 148 XP to Hellion");
    expect(reply).toContain("🔮 20 oracle pts");
  });

  test("command cooldown suppresses an immediate repeat", async () => {
    const ws = await connectBot();
    ws.serverSays(
      "@id=m3;display-name=Alice :alice!a@a.tmi.twitch.tv PRIVMSG #response :!mmr",
    );
    await flush();
    ws.serverSays(
      "@id=m4;display-name=Bob :bob!b@b.tmi.twitch.tv PRIVMSG #response :!mmr",
    );
    await flush();
    await drainSends();
    const replies = ws.sent.filter((l) => l.startsWith("PRIVMSG"));
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Session: 5-2");
    // After the cooldown, the same command answers again.
    jest.advanceTimersByTime(COMMAND_COOLDOWN_MS + 100);
    ws.serverSays(
      "@id=m5;display-name=Cara :cara!c@c.tmi.twitch.tv PRIVMSG #response :!mmr",
    );
    await flush();
    await drainSends();
    expect(ws.sent.filter((l) => l.startsWith("PRIVMSG"))).toHaveLength(2);
  });

  test("ignores its own messages entirely", async () => {
    const ws = await connectBot();
    ws.serverSays(
      ":sc2toolsbot!b@b.tmi.twitch.tv PRIVMSG #response :!rank",
    );
    await flush();
    expect(deps.engagement.ingest).not.toHaveBeenCalled();
    await drainSends();
    expect(ws.sent.filter((l) => l.startsWith("PRIVMSG"))).toHaveLength(0);
  });

  test("announces a prediction open once per game (multi-token dedupe)", async () => {
    const ws = await connectBot();
    await bot.handleEngagementEvent("tokA", {
      type: "prediction-open",
      gameKey: "g1",
      opponent: "Serral",
    });
    await bot.handleEngagementEvent("tokB", {
      type: "prediction-open",
      gameKey: "g1",
      opponent: "Serral",
    });
    await drainSends();
    const lines = ws.sent.filter((l) => l.includes("Crystal Ball is OPEN"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("vs Serral");
    expect(lines[0]).toContain("!win or !loss");
  });

  test("announces the settle verdict and level-ups per toggles", async () => {
    const ws = await connectBot();
    await bot.handleEngagementEvent("tokA", {
      type: "prediction-settled",
      gameKey: "g1",
      result: "win",
      tally: { win: 14, loss: 7, total: 21 },
      correctCount: 14,
      pointsEach: 10,
    });
    await bot.handleEngagementEvent("tokA", {
      type: "level-up",
      user: "Alice",
      level: 4,
      rank: "Immortal",
    });
    await drainSends();
    const settled = ws.sent.find((l) => l.includes("Result: WIN"));
    expect(settled).toContain("Chat said 67% WIN — chat was RIGHT!");
    expect(settled).toContain("14 oracles +10 pts");
    // Level-up themed by the streamer's terran ladder (level 4 = Hellion).
    expect(ws.sent.find((l) => l.includes("leveled up"))).toContain(
      "Alice leveled up — Hellion (Lv 4)!",
    );
  });

  test("disabled toggles silence announcements", async () => {
    await bot.configure("u1", {
      ...CFG,
      announceOracle: false,
      announceLevelUps: false,
    });
    const ws = sockets[sockets.length - 1];
    ws.emit("open");
    ws.serverSays(":tmi.twitch.tv 001 sc2toolsbot :Welcome");
    await flush();
    await bot.handleEngagementEvent("tokA", {
      type: "prediction-open",
      gameKey: "g9",
    });
    await bot.handleEngagementEvent("tokA", { type: "level-up", user: "A", level: 2 });
    await drainSends();
    expect(ws.sent.filter((l) => l.startsWith("PRIVMSG"))).toHaveLength(0);
  });

  test("normalizeConfig strips oauth: prefixes and rejects junk", () => {
    const ok = normalizeConfig({
      enabled: true,
      username: "My_Bot",
      token: "oauth:abcdefghij1234",
      channel: "",
    });
    expect(ok.token).toBe("abcdefghij1234");
    expect(ok.channel).toBe("My_Bot"); // defaults to username
    const bad = normalizeConfig({
      enabled: true,
      username: "no spaces allowed",
      token: "short",
    });
    expect(bad.username).toBe("");
    expect(bad.token).toBe("");
  });

  test("parseIrcLine handles tags, prefixes, and trailing", () => {
    const msg = parseIrcLine(
      "@id=abc;display-name=Alice :alice!alice@x.tmi.twitch.tv PRIVMSG #chan :hello :world",
    );
    expect(msg.tags.id).toBe("abc");
    expect(msg.tags["display-name"]).toBe("Alice");
    expect(msg.nick).toBe("alice");
    expect(msg.command).toBe("PRIVMSG");
    expect(msg.params).toEqual(["#chan"]);
    expect(msg.trailing).toBe("hello :world");
    expect(parseIrcLine("PING :tmi.twitch.tv").command).toBe("PING");
  });
});
