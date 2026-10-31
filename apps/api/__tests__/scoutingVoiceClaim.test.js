// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { LiveGameBroker } = require("../src/services/liveGameBroker");
const { buildMeLiveRouter } = require("../src/routes/agentLive");
const { attachSocketAuth } = require("../src/socket/auth");
const { ScoutingVoiceClaims } = require("../src/services/scoutingVoiceClaims");

function active(gameKey = "game-1", patch = {}) {
  return {
    type: "liveGameState", phase: "match_started", gameKey,
    opponent: { name: "Opponent", race: "Zerg" }, ...patch,
  };
}

function restApp(broker) {
  const app = express();
  app.use(express.json());
  app.use("/v1", buildMeLiveRouter({ broker, auth: (req, _res, next) => {
    const userId = req.get("x-test-user");
    if (userId) req.auth = { userId, source: req.get("x-test-source") || "device" };
    next();
  } }));
  return app;
}

function socketHarness(broker, overrides = {}) {
  let middleware, connect;
  const io = { use: (fn) => { middleware = fn; }, on: (event, fn) => {
    if (event === "connection") connect = fn;
  } };
  const claimScoutingVoice = jest.fn((userId, key) => broker.claimScoutingVoice(userId, key));
  const validateOverlayToken = jest.fn(async () => true);
  attachSocketAuth(io, {
    secretKey: "sk_test",
    resolveOverlayToken: async () => ({ userId: "owner", label: "main", enabledWidgets: ["scouting"] }),
    validateOverlayToken, claimScoutingVoice, ...overrides,
  });
  async function open(auth = {}) {
    const handlers = new Map();
    const socket = {
      handshake: { auth: { overlayToken: "overlay-token", presenceVersion: 1, surface: "widget", widget: "scouting", ...auth } },
      data: {}, connected: true, disconnected: false,
      join: jest.fn(), emit: jest.fn(),
      on: (event, fn) => handlers.set(event, fn),
      disconnect: jest.fn(() => { socket.connected = false; socket.disconnected = true; }),
      fire: (event, ...args) => handlers.get(event)?.(...args),
    };
    await new Promise((resolve, reject) => middleware(socket, (error) => error ? reject(error) : resolve()));
    connect(socket);
    return socket;
  }
  return { open, claimScoutingVoice, validateOverlayToken };
}

async function socketClaim(socket, gameKey = "game-1") {
  const ack = jest.fn();
  await socket.fire("overlay:claimScoutingVoice", { gameKey }, ack);
  expect(ack).toHaveBeenCalledTimes(1);
  return ack.mock.calls[0][0];
}

afterEach(() => jest.restoreAllMocks());

describe("scouting voice claim broker", () => {
  test("one user gets one readout per game across repeated live ticks, with a new claim for the next game", () => {
    const broker = new LiveGameBroker();
    broker.publish("owner", active());
    expect(broker.claimScoutingVoice("owner", "game-1")).toBe(true);
    broker.publish("owner", active("game-1", { phase: "match_in_progress" }));
    expect(broker.claimScoutingVoice("owner", "game-1")).toBe(false);
    broker.publish("owner", active("game-2"));
    expect(broker.claimScoutingVoice("owner", "game-2")).toBe(true);
    expect(broker.claimScoutingVoice("owner", "game-1")).toBe(false);
  });

  test("claims are isolated between users even when their game keys match", () => {
    const broker = new LiveGameBroker();
    broker.publish("alice", active()); broker.publish("bob", active());
    expect(broker.claimScoutingVoice("alice", "game-1")).toBe(true);
    expect(broker.claimScoutingVoice("bob", "game-1")).toBe(true);
    expect(broker.claimScoutingVoice("charlie", "game-1")).toBe(false);
  });

  test("a loading-screen attempt does not consume the eventual live-game claim", () => {
    const broker = new LiveGameBroker();
    broker.publish("owner", active("game-1", { phase: "match_loading" }));
    expect(broker.claimScoutingVoice("owner", "game-1")).toBe(false);
    broker.publish("owner", active());
    expect(broker.claimScoutingVoice("owner", "game-1")).toBe(true);
  });

  test("a confirmed all-human team roster can claim without a single selected opponent", () => {
    const broker = new LiveGameBroker();
    const players = ["Streamer", "Ally", "Enemy A", "Enemy B"].map(name => ({ type: "user", name }));
    broker.publish("owner", active("team-game", { opponent: null, players }));
    expect(broker.claimScoutingVoice("owner", "team-game")).toBe(true);
    expect(broker.claimScoutingVoice("owner", "team-game")).toBe(false);
    broker.publish("owner", active("ai-game", { opponent: null, players: [...players.slice(0, 3), { type: "computer", name: "AI" }] }));
    expect(broker.claimScoutingVoice("owner", "ai-game")).toBe(false);
  });

  test("a menu transient and resubscription do not repeat an already claimed game", () => {
    const broker = new LiveGameBroker();
    broker.publish("owner", active());
    expect(broker.claimScoutingVoice("owner", "game-1")).toBe(true);
    broker.publish("owner", { type: "liveGameState", phase: "menu" });
    expect(broker.claimScoutingVoice("owner", "game-1")).toBe(false);
    broker.publish("owner", active("game-1", { phase: "match_in_progress" }));
    const unsubscribe = broker.subscribe("owner", () => {}); unsubscribe();
    expect(broker.claimScoutingVoice("owner", "game-1")).toBe(false);
  });

  test.each([
    { phase: "match_ended" }, { phase: "idle" }, { phase: "menu" },
    { isReplay: true }, { synthetic: true }, { opponent: null }, { opponent: { name: "  " } },
  ])("inactive, replay, synthetic, or unidentified envelopes cannot claim: %j", (patch) => {
    const broker = new LiveGameBroker(); broker.publish("owner", active("game-1", patch));
    expect(broker.claimScoutingVoice("owner", "game-1")).toBe(false);
  });

  test.each([undefined, null, 42, {}, [], "", " ", " game-1", "game-1\n", "x".repeat(201)])(
    "malformed game key %j cannot claim or consume a valid claim", (key) => {
      const broker = new LiveGameBroker(); broker.publish("owner", active());
      expect(broker.claimScoutingVoice("owner", key)).toBe(false);
      expect(broker.claimScoutingVoice("owner", "game-1")).toBe(true);
    },
  );

  test("an expired live snapshot cannot grant a claim", () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, "now").mockReturnValue(now);
    const broker = new LiveGameBroker(); broker.publish("owner", active());
    clock.mockReturnValue(now + 31 * 60 * 1000);
    expect(broker.claimScoutingVoice("owner", "game-1")).toBe(false);
  });
});

describe("scouting voice receipt retention", () => {
  test("capacity fails closed without evicting an existing game's duplicate protection", () => {
    const claims = new ScoutingVoiceClaims();
    for (let i = 0; i < 4096; i++) expect(claims.claim("owner", `game-${i}`)).toBe(true);
    expect(claims.claim("owner", "new-game")).toBe(false);
    expect(claims.claim("owner", "game-0")).toBe(false);
    expect(claims.claim("owner", "game-4095")).toBe(false);
  });

  test("receipts survive reconnect-length gaps and expire after 24 hours", () => {
    const now = Date.now(), clock = jest.spyOn(Date, "now").mockReturnValue(now);
    const claims = new ScoutingVoiceClaims();
    expect(claims.claim("owner", "game-1")).toBe(true);
    clock.mockReturnValue(now + 24 * 60 * 60 * 1000 - 1);
    expect(claims.claim("owner", "game-1")).toBe(false);
    clock.mockReturnValue(now + 24 * 60 * 60 * 1000);
    expect(claims.claim("owner", "game-1")).toBe(true);
  });
});

describe("scouting voice claim socket", () => {
  test("multiple tokens and reconnects share a single claim for the authenticated owner", async () => {
    const broker = new LiveGameBroker(); broker.publish("owner", active());
    const h = socketHarness(broker);
    const first = await h.open(), second = await h.open({ overlayToken: "another-token", surface: "all-in-one" });
    expect(await socketClaim(first)).toEqual({ granted: true });
    expect(await socketClaim(second)).toEqual({ granted: false });
    const reconnected = await h.open();
    expect(await socketClaim(reconnected)).toEqual({ granted: false });
    expect(h.claimScoutingVoice).toHaveBeenCalledWith("owner", "game-1");
    expect(h.validateOverlayToken).toHaveBeenCalledWith("owner", "overlay-token");
  });

  test.each([{ controlOnly: true }, { surface: "widget", widget: "opponent" }, { surface: "dock" }])(
    "non-scouting surfaces cannot consume a claim: %j", async (auth) => {
      const broker = new LiveGameBroker(); broker.publish("owner", active());
      const h = socketHarness(broker), socket = await h.open(auth);
      expect(await socketClaim(socket)).toEqual({ granted: false });
      expect(h.claimScoutingVoice).not.toHaveBeenCalled();
      expect(broker.claimScoutingVoice("owner", "game-1")).toBe(true);
    },
  );

  test("a revoked token cannot consume the game's claim after its successful handshake", async () => {
    const broker = new LiveGameBroker(); broker.publish("owner", active());
    const h = socketHarness(broker, { validateOverlayToken: async () => false });
    const socket = await h.open();
    expect(await socketClaim(socket)).toEqual({ granted: false });
    expect(h.claimScoutingVoice).not.toHaveBeenCalled();
    expect(broker.claimScoutingVoice("owner", "game-1")).toBe(true);
  });

  test("a token validation failure denies speech without consuming the claim", async () => {
    const broker = new LiveGameBroker(); broker.publish("owner", active());
    const h = socketHarness(broker, { validateOverlayToken: async () => { throw new Error("lookup_failed"); } });
    expect(await socketClaim(await h.open())).toEqual({ granted: false });
    expect(h.claimScoutingVoice).not.toHaveBeenCalled();
  });

  test("a disconnect during token validation cannot consume a live game's claim", async () => {
    let release;
    const validation = new Promise((resolve) => { release = resolve; });
    const broker = new LiveGameBroker(); broker.publish("owner", active());
    const h = socketHarness(broker, { validateOverlayToken: () => validation });
    const socket = await h.open(), ack = jest.fn();
    const pending = socket.fire("overlay:claimScoutingVoice", { gameKey: "game-1" }, ack);
    socket.connected = false; socket.disconnected = true; release(true);
    await pending;
    expect(h.claimScoutingVoice).not.toHaveBeenCalled();
    expect(broker.claimScoutingVoice("owner", "game-1")).toBe(true);
  });
});

describe("scouting voice native REST and browser socket coordination", () => {
  const path = "/v1/me/live/scouting-voice/claim";

  test.each(["native", "browser"])("the %s winner excludes the other surface for the same match", async (winner) => {
    const broker = new LiveGameBroker(); broker.publish("owner", active());
    const app = restApp(broker), h = socketHarness(broker), socket = await h.open();
    const nativeClaim = async () => (await request(app).post(path).set("x-test-user", "owner").send({ gameKey: "game-1" })).body;
    if (winner === "native") {
      expect(await nativeClaim()).toEqual({ granted: true });
      expect(await socketClaim(socket)).toEqual({ granted: false });
    } else {
      expect(await socketClaim(socket)).toEqual({ granted: true });
      expect(await nativeClaim()).toEqual({ granted: false });
    }
  });

  test("REST requires auth and uses the authenticated identity rather than a supplied userId", async () => {
    const broker = new LiveGameBroker(); broker.publish("owner", active());
    const app = restApp(broker);
    expect((await request(app).post(path).send({ gameKey: "game-1" })).status).toBe(401);
    const spoof = await request(app).post(path).set("x-test-user", "stranger").send({ gameKey: "game-1", userId: "owner" });
    expect(spoof.body).toEqual({ granted: false });
    expect(broker.claimScoutingVoice("owner", "game-1")).toBe(true);
  });

  test("REST rejects malformed keys and an obsolete game cannot consume the current game's claim", async () => {
    const broker = new LiveGameBroker(); broker.publish("owner", active());
    const app = restApp(broker);
    expect((await request(app).post(path).set("x-test-user", "owner").send({ gameKey: "game-1\n" })).status).toBe(400);
    const obsolete = await request(app).post(path).set("x-test-user", "owner").send({ gameKey: "previous-game" });
    expect(obsolete.body).toEqual({ granted: false });
    const current = await request(app).post(path).set("x-test-user", "owner").send({ gameKey: "game-1" });
    expect(current.body).toEqual({ granted: true });
    expect(current.headers["cache-control"]).toContain("no-store");
  });
});
