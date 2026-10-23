// @ts-nocheck
"use strict";
const express = require("express");
const request = require("supertest");
const { buildScoutingBrief, SCOUTING_BRIEF_MAX_BYTES } = require("../src/services/agentScouting");
const { LiveGameBroker } = require("../src/services/liveGameBroker");
const { buildAgentScoutingRouter } = require("../src/routes/agentScouting");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function envelope(key = "current") {
  return {
    type: "liveGameState", phase: "match_loading", gameKey: key,
    opponent: { name: "Opponent", toonHandle: "1-1-1-42" },
    streamerHistory: {
      oppName: "Opponent", headToHead: { wins: 3, losses: 2 },
      recentGames: [{ result: "Loss", map: "Alcyone", oppBuild: "12 Pool", date: "2026-10-21T12:00:00Z" }],
      favOpening: { name: "12 Pool", share: 0.6, samples: 3, of: 5 },
      bestAnswer: { build: "Hatch First", total: 4, winRate: 0.75 },
      cheeseProbability: 0.6, opponentNotes: { text: "Private note", readAloud: false },
    },
  };
}

describe("private scouting projection and broker", () => {
  test("projects actual cached counts and private note without extra lookups", () => {
    const brief = buildScoutingBrief(envelope());
    expect(brief).toMatchObject({
      gameKey: "current", oppName: "Opponent", pulseId: "1-1-1-42",
      h2h: { w: 3, l: 2 }, lastMet: { at: "2026-10-21T12:00:00.000Z", result: "Loss", map: "Alcyone" },
      forecast: { name: "12 Pool", samples: 3, n: 5, share: 0.6 },
      bestAnswer: { build: "Hatch First", w: 3, l: 1 }, note: "Private note",
      dossierUrl: "/app/opponents/1-1-1-42",
    });
  });
  test("first meeting preserves zero record; missing data never invents a forecast", () => {
    const env = envelope(); env.streamerHistory = { headToHead: { wins: 0, losses: 0 } };
    expect(buildScoutingBrief(env)).toMatchObject({ h2h: { w: 0, l: 0 }, last3: [], lastMet: null, forecast: null, bestAnswer: null, note: "" });
    delete env.streamerHistory;
    expect(buildScoutingBrief(env)).toBeNull();
  });
  test("rejects stale identity, inactive/replay envelopes and oversized keys", () => {
    const env = envelope(); env.streamerHistory.oppName = "Somebody else";
    expect(buildScoutingBrief(env)).toBeNull();
    for (const patch of [{ phase: "menu" }, { isReplay: true }, { gameKey: "x".repeat(301) }]) {
      expect(buildScoutingBrief({ ...envelope(), ...patch })).toBeNull();
    }
  });
  test("an ambiguous display-name match cannot supply another account's record", () => {
    const env = envelope(); env.streamerHistory.opponentIdentityMatched = false;
    expect(buildScoutingBrief(env)).toMatchObject({ h2h: null, last3: [], lastMet: null, forecast: null, bestAnswer: null, cheese: null, note: "Private note" });
  });
  test("bounds hostile multibyte data and does not forward arbitrary fields", () => {
    const env = envelope();
    env.streamerHistory.opponentNotes.text = "🦊".repeat(50_000);
    env.streamerHistory.recentGames = Array.from({ length: 500 }, () => ({ map: "🦊".repeat(1000), oppBuild: "x".repeat(1000), result: "Win" }));
    env.streamerHistory.secret = "never forward";
    const brief = buildScoutingBrief(env);
    expect(brief.last3).toHaveLength(3);
    expect(brief.note.length).toBeLessThanOrEqual(500);
    expect(Buffer.byteLength(JSON.stringify(brief))).toBeLessThanOrEqual(SCOUTING_BRIEF_MAX_BYTES);
    expect(brief.secret).toBeUndefined();
  });
});
describe("private scouting broker delivery", () => {
  test("accepted enrichment emits a brief only to the device room", async () => {
    const events = [];
    const io = { to: (room) => ({ emit: (event, payload) => events.push({ room, event, payload }) }) };
    const broker = new LiveGameBroker({ io, enrich: async (_, env) => ({ ...env, streamerHistory: envelope().streamerHistory }) });
    const env = envelope(); delete env.streamerHistory;
    broker.publish("owner", env);
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ room: "device-user:owner", event: "scouting:brief", payload: { note: "Private note" } });
    expect(broker.latest("owner").streamerHistory).toBeDefined();
  });
  test("an enrichment completed after the next game cannot emit a stale brief", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const emit = jest.fn();
    const broker = new LiveGameBroker({ io: { to: () => ({ emit }) }, enrich: async (_, env) => {
      if (env.gameKey === "old") await gate;
      return { ...env, streamerHistory: envelope().streamerHistory };
    } });
    broker.publish("owner", envelope("old"));
    broker.publish("owner", envelope("new"));
    await flush(); release(); await flush();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][1].gameKey).toBe("new");
  });
});

function setup(source = "device") {
  const broker = { latest: jest.fn(() => envelope()) };
  const opponents = { updateNotes: jest.fn(async () => ({ notes: "new note", notesReadAloud: false, opponentName: "Opponent", pulseCharacterId: "42" })) };
  const overlayLive = { invalidateEnrichmentForOpponent: jest.fn() };
  const app = express(); app.use(express.json());
  app.use("/v1", buildAgentScoutingRouter({ broker, opponents, overlayLive, auth: (req, _, next) => { req.auth = { source, userId: "owner" }; next(); } }));
  return { app, broker, opponents, overlayLive };
}
describe("device-only scouting routes", () => {
  test("cache read is user-scoped, current-key only and private/no-store", async () => {
    const h = setup();
    const response = await request(h.app).get("/v1/agent/live/scouting?gameKey=current");
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(h.broker.latest).toHaveBeenCalledWith("owner");
    expect(h.opponents.updateNotes).not.toHaveBeenCalled();
    expect((await request(h.app).get("/v1/agent/live/scouting?gameKey=previous")).status).toBe(404);
    expect((await request(h.app).get("/v1/agent/live/scouting")).status).toBe(400);
  });
  test("Clerk/browser credentials cannot read or edit through the device API", async () => {
    const h = setup("clerk");
    expect((await request(h.app).get("/v1/agent/live/scouting?gameKey=current")).status).toBe(403);
    expect((await request(h.app).put("/v1/agent/opponents/1-1-1-42/notes").send({ notes: "x", notesReadAloud: false })).status).toBe(403);
    expect(h.broker.latest).not.toHaveBeenCalled(); expect(h.opponents.updateNotes).not.toHaveBeenCalled();
  });
  test("reuses web validation, owner-scoped service and enrichment invalidation", async () => {
    const h = setup(); const url = "/v1/agent/opponents/1-1-1-42/notes";
    expect((await request(h.app).put(url).send({ notes: "x".repeat(501), notesReadAloud: false })).status).toBe(400);
    expect(h.opponents.updateNotes).not.toHaveBeenCalled();
    const response = await request(h.app).put(url).send({ notes: "new note", notesReadAloud: false });
    expect(response.status).toBe(200);
    expect(h.opponents.updateNotes).toHaveBeenCalledWith("owner", "1-1-1-42", { notes: "new note", notesReadAloud: false });
    expect(h.overlayLive.invalidateEnrichmentForOpponent).toHaveBeenCalledWith("owner", "Opponent", "42");
    expect(response.body).toEqual({ notes: "new note", notesReadAloud: false });
  });
});
