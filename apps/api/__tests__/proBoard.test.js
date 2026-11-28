// @ts-nocheck
"use strict";

/**
 * Pros on Ladder (services/proBoard.js, proBoardShape.js, pulseClient.js,
 * jobs/proBoardRefreshJob.js and routes/proBoard.js) against a fake SC2Pulse:
 * the two gates (ADR 0065), that a visitor never causes a provider call, what
 * a row may carry (ADR 0075), the bounded refresh and the shared pace.
 */

const express = require("express");
const request = require("supertest");
const { ProBoardService, ProBoardError, MAX_HISTORY_CALLS, MAX_PROS, MAX_PLAYERS, STALE_LIMIT_MS, PLAYING_WINDOW_MS } = require("../src/services/proBoard");
const { PulseClient, PulseBusyError, PACE_MS } = require("../src/services/pulseClient");
const { shapeSeen, gamesOf, liveOf, mainRace } = require("../src/services/proBoardShape");
const { buildProBoardRouter } = require("../src/routes/proBoard");
const { buildProBoardRefreshJob } = require("../src/jobs/proBoardRefreshJob");
const { proBoardFromDeps } = require("../src/routes/liveLadderRoutes");
const { LadderVodsService } = require("../src/services/ladderVods");

const NOW = Date.parse("2026-11-28T09:00:00Z");
const minutesAgo = minutes => new Date(NOW - minutes * 60_000).toISOString();

const proMember = (id, nickname, extra = {}) => ({
  character: { id: id * 10, name: `Account${id}#123` },
  account: { battleTag: `Secret${id}#9999` },
  raceGames: { ZERG: 120, TERRAN: 5 },
  proId: id,
  proNickname: nickname,
  proTeam: "TeamX",
  proPlayer: { links: [] },
  ...extra,
});
const team = (member, { rating = 5034, played = 5 } = {}) => ({
  rating,
  lastPlayed: minutesAgo(played),
  league: { type: 6 },
  members: [member],
});
const anon = (id, over) => team({ character: { id, name: `Ladder${id}#1` }, account: { battleTag: `Anon${id}#1` }, raceGames: { PROTOSS: 80 } }, over);

const side = (decision, race, proId) => ({
  participant: { decision, matchId: 7 },
  team: { members: [{ raceGames: { [race]: 30 }, ...(proId ? { proId } : {}), character: { name: "OpponentSecret#1" } }] },
});
const matchRow = (over = {}) => ({
  match: { date: minutesAgo(20), duration: 640, type: "_1V1" },
  map: { name: "Blackrock LE" },
  participants: [side("WIN", "ZERG", 101), side("LOSS", "TERRAN")],
  ...over,
});

/** A fake paced client: answers by path, records every call. */
function fakePulse({ teams = [], history = {}, failTeams = false, failHistory = false } = {}) {
  const calls = [];
  return {
    calls,
    async get(path, query, options) {
      calls.push({ path, query: Object.fromEntries(query), options });
      if (path === "/teams") {
        if (failTeams) throw new Error("pulse_http_500");
        return teams;
      }
      if (failHistory) throw new Error("pulse_http_500");
      return { result: history[query.get("proPlayerId")] ?? [] };
    },
  };
}

const streams = (...channels) => ({
  list: async () => ({ streams: channels.map(([channel, viewers = 10]) => ({ id: channel, platform: "twitch", channel, title: "", language: "en", viewers, startedAt: "", url: `https://www.twitch.tv/${channel}` })) }),
});

const make = (pulse, options = {}) =>
  new ProBoardService({ enabled: true, showNames: true, pulse, now: () => NOW, ...options });

describe("the gates", () => {
  test("with the feature off nothing reaches SC2Pulse and the board is unavailable", async () => {
    const pulse = fakePulse({ teams: [anon(1)] });
    const board = make(pulse, { enabled: false });
    await board.refresh();
    expect(pulse.calls).toEqual([]);
    expect(board.view()).toEqual({ available: false });
    expect(board.isOpen()).toBe(false);
  });

  test("the names gate cannot open on its own", () => {
    expect(make(fakePulse(), { enabled: false, showNames: true }).showNames).toBe(false);
  });

  test("the gates read their environment flags and start off", () => {
    expect(new ProBoardService({ pulse: fakePulse() }).isOpen()).toBe(false);
    process.env.SC2TOOLS_PROS_ON_LADDER_ENABLED = "1";
    try {
      const board = new ProBoardService({ pulse: fakePulse() });
      expect(board.isOpen()).toBe(true);
      expect(board.showNames).toBe(false);
    } finally {
      delete process.env.SC2TOOLS_PROS_ON_LADDER_ENABLED;
    }
  });
});

describe("with names off", () => {
  test("rows hold race, league and a rating rounded to 100; no pro is looked up or named", async () => {
    const pulse = fakePulse({ teams: [team(proMember(101, "Reynor"), { rating: 5034 }), anon(2, { rating: 4960 })] });
    const board = make(pulse, { showNames: false, liveStreams: streams(["reynor"]) });
    await board.refresh();
    const view = board.view();
    expect(pulse.calls).toHaveLength(1);
    expect(pulse.calls[0]).toMatchObject({ path: "/teams", query: { queue: "LOTV_1V1", teamType: "ARRANGED", league: "GRANDMASTER", recent: "true" } });
    expect(view.showNames).toBe(false);
    expect(view.pros).toEqual([]);
    expect(view.players).toEqual([
      { race: "zerg", league: "grandmaster", rating: 5000, playedAt: minutesAgo(5) },
      { race: "protoss", league: "grandmaster", rating: 5000, playedAt: minutesAgo(5) },
    ]);
    const text = JSON.stringify(view);
    for (const secret of ["Reynor", "TeamX", "Secret101", "Account101", "reynor", "twitch.tv"]) expect(text).not.toContain(secret);
  });
});

describe("with names on", () => {
  test("pros are named with their team, live channel and last games; the other players stay anonymous", async () => {
    const pulse = fakePulse({
      teams: [team(proMember(101, "Reynor", { proPlayer: { links: [{ url: "https://www.twitch.tv/ReynorLive" }] } }), { rating: 5034 }), anon(2, { rating: 4960 })],
      history: { 101: [matchRow(), matchRow({ match: { date: minutesAgo(90), duration: 300, type: "_1V1" }, participants: [side("LOSS", "ZERG", 101), side("WIN", "PROTOSS")] })] },
    });
    const board = make(pulse, { liveStreams: streams(["reynor", 5], ["reynorlive", 900]) });
    await board.refresh();
    const view = board.view();
    expect(view.showNames).toBe(true);
    expect(view.pros).toEqual([{
      nickname: "Reynor",
      team: "TeamX",
      race: "zerg",
      league: "grandmaster",
      rating: 5034,
      playedAt: minutesAgo(5),
      live: { platform: "twitch", channel: "reynorlive", url: "https://www.twitch.tv/reynorlive", viewers: 900 },
      games: [
        { map: "Blackrock", opponentRace: "terran", won: true, durationSec: 640, playedAt: minutesAgo(20) },
        { map: "Blackrock", opponentRace: "protoss", won: false, durationSec: 300, playedAt: minutesAgo(90) },
      ],
    }]);
    expect(view.players).toEqual([{ race: "protoss", league: "grandmaster", rating: 5000, playedAt: minutesAgo(5) }]);
    expect(pulse.calls.map(call => call.path)).toEqual(["/teams", "/character-matches"]);
    expect(pulse.calls[1].query).toEqual({ proPlayerId: "101" });
    expect(JSON.stringify(view)).not.toMatch(/OpponentSecret|Secret101|Account101|Anon2|Ladder2/);
  });

  test("a pro who is not live has no channel, and the nickname matches a channel when no link names one", async () => {
    const pulse = fakePulse({ teams: [team(proMember(101, "Reynor")), team(proMember(102, "Serral"), { played: 8 })] });
    const board = make(pulse, { liveStreams: streams(["serral"]) });
    await board.refresh();
    expect(board.view().pros.map(row => [row.nickname, row.live?.channel ?? null])).toEqual([["Reynor", null], ["Serral", "serral"]]);
  });

  test("a live list that fails still gives the board", async () => {
    const warn = jest.fn();
    const board = make(fakePulse({ teams: [team(proMember(101, "Reynor"))] }), { liveStreams: { list: async () => { throw new Error("twitch down"); } }, log: { warn } });
    await board.refresh();
    expect(board.view().pros[0].live).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  test("pros are listed newest first up to the cap, and the rest appear anonymously", async () => {
    const teams = Array.from({ length: MAX_PROS + 3 }, (_, index) => team(proMember(200 + index, `Pro${index}`), { played: index + 1 }));
    const board = make(fakePulse({ teams }));
    await board.refresh();
    const view = board.view();
    expect(view.pros).toHaveLength(MAX_PROS);
    expect(view.pros[0].nickname).toBe("Pro0");
    expect(view.players).toHaveLength(3);
    expect(JSON.stringify(view.players)).not.toContain("Pro1");
  });
});

describe("the refresh is bounded", () => {
  test("at most MAX_HISTORY_CALLS pro histories are fetched in one refresh", async () => {
    const teams = Array.from({ length: MAX_PROS }, (_, index) => team(proMember(300 + index, `Pro${index}`), { played: index + 1 }));
    const pulse = fakePulse({ teams });
    const board = make(pulse);
    await board.refresh();
    expect(pulse.calls.filter(call => call.path === "/character-matches")).toHaveLength(MAX_HISTORY_CALLS);
    expect(board.view().pros).toHaveLength(MAX_PROS);
  });

  test("a pro who has not played since the last look costs no second history call", async () => {
    const pulse = fakePulse({ teams: [team(proMember(101, "Reynor"))], history: { 101: [matchRow()] } });
    const board = make(pulse);
    await board.refresh();
    await board.refresh();
    expect(pulse.calls.map(call => call.path)).toEqual(["/teams", "/character-matches", "/teams"]);
    expect(board.view().pros[0].games).toHaveLength(1);
  });

  test("only teams that played in the last hour, alone, and in Grandmaster are listed, at most MAX_PLAYERS", async () => {
    const old = anon(1, { played: PLAYING_WINDOW_MS / 60_000 + 5 });
    const duo = { ...anon(2), members: [anon(2).members[0], anon(3).members[0]] };
    const wrongLeague = { ...anon(4), league: { type: 5 } };
    const many = Array.from({ length: MAX_PLAYERS + 5 }, (_, index) => anon(10 + index, { played: 1 + (index % 50) }));
    const board = make(fakePulse({ teams: [old, duo, wrongLeague, ...many] }), { showNames: false });
    await board.refresh();
    expect(board.view().players).toHaveLength(MAX_PLAYERS);
  });

  test("a failed teams call keeps the last board until it is too old", async () => {
    let clock = NOW;
    const pulse = fakePulse({ teams: [anon(1)] });
    const board = make(pulse, { showNames: false, now: () => clock });
    expect(() => board.view()).toThrow(ProBoardError);
    await board.refresh();
    pulse.get = async () => { throw new Error("pulse_http_500"); };
    await expect(board.refresh()).rejects.toThrow("pulse_http_500");
    clock += STALE_LIMIT_MS - 1;
    expect(board.view().players).toHaveLength(1);
    clock += 2;
    expect(() => board.view()).toThrow(ProBoardError);
  });

  test("a failed history leaves that pro without games and is not remembered", async () => {
    const warn = jest.fn();
    const pulse = fakePulse({ teams: [team(proMember(101, "Reynor"))], failHistory: true });
    const board = make(pulse, { log: { warn } });
    await board.refresh();
    expect(board.view().pros[0].games).toEqual([]);
    await board.refresh();
    expect(pulse.calls.filter(call => call.path === "/character-matches")).toHaveLength(2);
    expect(warn).toHaveBeenCalled();
  });
  test("a pro whose new games cannot be fetched keeps the last games, and a busy pace is not logged as a failure", async () => {
    const warn = jest.fn();
    const teams = [team(proMember(101, "Reynor"), { played: 30 })];
    const pulse = fakePulse({ teams, history: { 101: [matchRow()] } });
    const board = make(pulse, { log: { warn } });
    await board.refresh();
    teams[0] = team(proMember(101, "Reynor"), { played: 2 });
    const busy = new PulseBusyError();
    const answer = pulse.get;
    pulse.get = async (path, query, options) => { if (path === "/character-matches") throw busy; return answer(path, query, options); };
    await board.refresh();
    expect(board.view().pros[0].games).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("shaping", () => {
  test("mainRace picks the race played most", () => {
    expect(mainRace({ TERRAN: 3, ZERG: 9 })).toBe("zerg");
    expect(mainRace({})).toBeNull();
    expect(mainRace(undefined)).toBeNull();
  });

  test("shapeSeen drops teams without a lone player, a known league, a rating or a time", () => {
    expect(shapeSeen(anon(1), false)).toMatchObject({ race: "protoss", rating: 5034 });
    expect(shapeSeen({ ...anon(1), rating: undefined }, false)).toBeNull();
    expect(shapeSeen({ ...anon(1), lastPlayed: "soon" }, false)).toBeNull();
    expect(shapeSeen({ ...anon(1), members: [] }, false)).toBeNull();
    expect(shapeSeen(null, false)).toBeNull();
  });

  test("a pro is read only when names are on", () => {
    expect(shapeSeen(team(proMember(101, "Reynor")), false).pro).toBeNull();
    expect(shapeSeen(team(proMember(101, "Reynor")), true).pro).toMatchObject({ id: 101, nickname: "Reynor", team: "TeamX", logins: ["reynor"] });
  });

  test("a channel link and the nickname both name logins, links first", () => {
    const member = proMember(101, "Reynor", { proPlayer: { links: [{ url: "https://kick.com/RK_Reynor/about" }, { url: "https://x.com/reynor" }, { url: "https://twitch.tv/Reynor?x=1" }] } });
    expect(shapeSeen(team(member), true).pro.logins).toEqual(["rk_reynor", "reynor"]);
  });

  test("gamesOf keeps 1v1 wins and losses of the pro, newest first, at most three", () => {
    const rows = [
      matchRow({ match: { date: minutesAgo(1), duration: 100, type: "_2V2" } }),
      matchRow({ participants: [side("TIE", "ZERG", 101), side("TIE", "TERRAN")] }),
      matchRow({ participants: [side("WIN", "ZERG"), side("LOSS", "TERRAN")] }),
      matchRow({ match: { date: minutesAgo(2), duration: "long", type: "_1V1" } }),
      matchRow(), matchRow(), matchRow(), matchRow(),
    ];
    const games = gamesOf(rows, 101);
    expect(games).toHaveLength(3);
    expect(games[0]).toEqual({ map: "Blackrock", opponentRace: "terran", won: true, durationSec: 640, playedAt: minutesAgo(20) });
    expect(gamesOf([matchRow({ participants: [side("WIN", "ZERG", 101)] })], 101)[0].opponentRace).toBeNull();
  });

  test("liveOf tries logins in order and ignores other channels", () => {
    const list = [{ channel: "Other", platform: "kick", url: "k", viewers: 1 }, { channel: "Mine", platform: "twitch", url: "t", viewers: 4 }];
    expect(liveOf(["mine", "other"], list)).toEqual({ platform: "twitch", channel: "Mine", url: "t", viewers: 4 });
    expect(liveOf(["nobody"], list)).toBeNull();
  });
});

describe("the shared paced client", () => {
  const body = { ok: true, status: 200, json: async () => [] };

  test("calls leave at least a pace apart, wait only a bounded time, and carry the caller's name", async () => {
    let clock = NOW;
    const sleeps = [];
    const calls = [];
    const pulse = new PulseClient({
      fetchImpl: async (url, init) => { calls.push({ url, init }); return body; },
      now: () => clock,
      sleep: async ms => { sleeps.push(ms); clock += ms; },
    });
    await pulse.get("/teams", new URLSearchParams({ a: "1" }), { maxWaitMs: 5000, userAgent: "x" });
    await pulse.get("/matches", new URLSearchParams(), { maxWaitMs: 5000 });
    expect(sleeps).toEqual([PACE_MS]);
    expect(calls[0].url).toBe("https://sc2pulse.nephest.com/sc2/api/teams?a=1");
    expect(calls[0].init.headers["user-agent"]).toBe("x");
    expect(calls[1].init.headers["user-agent"]).toMatch(/^sc2tools\.com/);
    pulse.nextCallAt = clock + 10 * PACE_MS;
    await expect(pulse.get("/teams", new URLSearchParams(), { maxWaitMs: PACE_MS })).rejects.toMatchObject({ code: "busy" });
  });

  test("an HTTP error is an error, not an empty answer", async () => {
    const pulse = new PulseClient({ fetchImpl: async () => ({ ok: false, status: 503 }) });
    await expect(pulse.get("/teams", new URLSearchParams(), { maxWaitMs: 0 })).rejects.toThrow("pulse_http_503");
  });

  test("the board and the ladder VOD finder take their turns on one client", async () => {
    const board = proBoardFromDeps({ logger: {} }, streams());
    let clock = NOW;
    board.pulse.now = () => clock;
    board.pulse.sleep = async ms => { clock += ms; };
    board.pulse.fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ result: [] }) });
    const finder = new LadderVodsService({ enabled: true, pulse: board.pulse, now: () => clock });
    await finder.search({});
    expect(board.pulse.nextCallAt).toBe(NOW + PACE_MS);
  });
});

describe("the public route", () => {
  const appFor = board => express().use("/v1", buildProBoardRouter({ proBoard: board }));

  test("serves what the timer stored and never calls SC2Pulse itself", async () => {
    const pulse = fakePulse({ teams: [anon(1)] });
    const board = make(pulse, { showNames: false });
    await board.refresh();
    const before = pulse.calls.length;
    const res = await request(appFor(board)).get("/v1/pros-on-ladder");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: true, showNames: false, pros: [] });
    expect(res.headers["cache-control"]).toMatch(/max-age=60/);
    await request(appFor(board)).get("/v1/pros-on-ladder/status");
    expect(pulse.calls).toHaveLength(before);
  });

  test("gate off: unavailable and status closed; before the first refresh: 503 with a retry hint", async () => {
    const off = await request(appFor(make(fakePulse(), { enabled: false }))).get("/v1/pros-on-ladder");
    expect(off.body).toEqual({ available: false });
    expect((await request(appFor(make(fakePulse(), { enabled: false }))).get("/v1/pros-on-ladder/status")).body).toEqual({ available: false, showNames: false });
    const early = await request(appFor(make(fakePulse()))).get("/v1/pros-on-ladder");
    expect(early.status).toBe(503);
    expect(early.headers["retry-after"]).toBe("60");
    expect(early.body.error.code).toBe("pros_on_ladder_unavailable");
    expect((await request(appFor(make(fakePulse()))).get("/v1/pros-on-ladder/status")).body).toEqual({ available: true, showNames: true });
    expect((await request(appFor(make(fakePulse(), { showNames: false }))).get("/v1/pros-on-ladder/status")).body).toEqual({ available: true, showNames: false });
  });

  test("an unexpected failure goes to the error handler", async () => {
    const app = express().use("/v1", buildProBoardRouter({ proBoard: { isOpen: () => true, view: () => { throw new Error("boom"); } } }));
    app.use((err, _req, res, _next) => res.status(500).json({ message: err.message }));
    expect((await request(app).get("/v1/pros-on-ladder")).body.message).toBe("boom");
  });

  test("requires a service", () => {
    expect(() => buildProBoardRouter({})).toThrow("proBoard service required");
  });
});

describe("the refresh job", () => {
  const logger = () => { const log = { warn: jest.fn(), info: jest.fn() }; log.child = () => log; return log; };

  test("does nothing while the gate is off", async () => {
    const proBoard = { isOpen: () => false, refresh: jest.fn() };
    const job = buildProBoardRefreshJob({ proBoard, logger: logger() });
    job.start();
    await job.stop();
    expect(proBoard.refresh).not.toHaveBeenCalled();
  });

  test("with the gate on it refreshes at start and on the timer, and a failure is logged, not thrown", async () => {
    jest.useFakeTimers();
    try {
      const log = logger();
      const proBoard = { isOpen: () => true, refresh: jest.fn().mockRejectedValueOnce(new Error("pulse down")).mockResolvedValue(undefined) };
      const job = buildProBoardRefreshJob({ proBoard, logger: log, intervalMs: 1000 });
      job.start();
      job.start();
      await jest.advanceTimersByTimeAsync(2100);
      expect(proBoard.refresh).toHaveBeenCalledTimes(3);
      expect(log.warn).toHaveBeenCalledWith({ err: "pulse down" }, "proBoard_refresh_error");
      await job.stop();
      await jest.advanceTimersByTimeAsync(5000);
      expect(proBoard.refresh).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  test("requires its dependencies", () => {
    expect(() => buildProBoardRefreshJob({ logger: {} })).toThrow("proBoard required");
    expect(() => buildProBoardRefreshJob({ proBoard: {} })).toThrow("logger required");
  });
});
