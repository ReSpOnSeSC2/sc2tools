// @ts-nocheck
"use strict";

/**
 * Coverage for the overlay socket's connect-replay + resync /
 * heartbeat handlers in ``socket/auth.js``.
 *
 * The Browser Source's Socket.io client auto-reconnects after a
 * transient drop; on each (re-)connect the cloud must replay the
 * three current snapshots — ``overlay:liveGame`` (with synthetic
 * prelude when the cached envelope is past the loading screen),
 * ``overlay:live``, and ``overlay:session`` — without an extra round
 * trip. The client also fires periodic ``overlay:heartbeat`` pings
 * the cloud answers with the current gameKey so the client can
 * detect a state drift.
 */

const {
  attachSocketAuth,
  RESYNC_MIN_INTERVAL_MS,
} = require("../src/socket/auth");

function setupIo() {
  let mw = null;
  let onConnect = null;
  return {
    use(fn) {
      mw = fn;
    },
    on(event, fn) {
      if (event === "connection") onConnect = fn;
    },
    runHandshake(handshake) {
      const socket = makeSocket(handshake);
      return new Promise((resolve, reject) => {
        mw(socket, (err) => (err ? reject(err) : resolve(socket)));
      });
    },
    runConnect(socket) {
      onConnect(socket);
    },
  };
}

function makeSocket(handshake) {
  const emitted = [];
  const eventHandlers = new Map();
  return {
    handshake,
    data: {},
    rooms: [],
    emitted,
    join(room) {
      this.rooms.push(room);
    },
    emit(event, payload) {
      emitted.push({ event, payload });
    },
    on(event, fn) {
      eventHandlers.set(event, fn);
    },
    fire(event, ...args) {
      const fn = eventHandlers.get(event);
      if (fn) fn(...args);
    },
    eventHandlers,
  };
}

describe("attachSocketAuth (overlay) — connect replay", () => {
  test("on connect, replays prelude + envelope + overlayLive from resolveLiveSnapshot", async () => {
    const io = setupIo();
    const liveSnap = {
      prelude: {
        type: "liveGameState",
        phase: "match_loading",
        gameKey: "k",
        synthetic: true,
      },
      envelope: {
        type: "liveGameState",
        phase: "match_in_progress",
        gameKey: "k",
      },
      overlayLive: { gameKey: "g-prior", oppName: "Past Opponent" },
      gameKey: "k",
    };
    attachSocketAuth(io, {
      secretKey: "sk_test",
      resolveOverlayToken: async () => ({
        userId: "u1",
        label: "main",
        enabledWidgets: ["opponent"],
      }),
      resolveLiveSnapshot: () => liveSnap,
    });
    const socket = await io.runHandshake({
      auth: { overlayToken: "tok-1" },
    });
    io.runConnect(socket);
    await new Promise((r) => setImmediate(r));

    const events = socket.emitted.map((e) => e.event);
    // Prelude THEN envelope THEN overlayLive.
    const liveGameIdx = events.findIndex((e) => e === "overlay:liveGame");
    const overlayLiveIdx = events.findIndex((e) => e === "overlay:live");
    expect(liveGameIdx).toBeGreaterThanOrEqual(0);
    expect(overlayLiveIdx).toBeGreaterThan(liveGameIdx);
    const liveGameEvents = socket.emitted.filter(
      (e) => e.event === "overlay:liveGame",
    );
    expect(liveGameEvents).toHaveLength(2);
    expect(liveGameEvents[0].payload.synthetic).toBe(true);
    expect(liveGameEvents[1].payload.phase).toBe("match_in_progress");
    const liveEvent = socket.emitted.find((e) => e.event === "overlay:live");
    expect(liveEvent.payload.oppName).toBe("Past Opponent");
  });

  test("connect with no live snapshot at all just emits the existing config + session", async () => {
    const io = setupIo();
    attachSocketAuth(io, {
      secretKey: "sk_test",
      resolveOverlayToken: async () => ({
        userId: "u1",
        label: "main",
        enabledWidgets: ["opponent"],
      }),
      resolveSession: async () => ({ wins: 0, losses: 0, games: 0 }),
      resolveLiveSnapshot: () => null,
    });
    const socket = await io.runHandshake({
      auth: { overlayToken: "tok-1" },
    });
    io.runConnect(socket);
    await new Promise((r) => setImmediate(r));

    const events = socket.emitted.map((e) => e.event);
    expect(events).toContain("overlay:config");
    expect(events).toContain("overlay:session");
    expect(events).not.toContain("overlay:liveGame");
    expect(events).not.toContain("overlay:live");
  });
});

describe("attachSocketAuth (overlay) — overlay:resync", () => {
  test("re-emits all three current snapshots on demand", async () => {
    const io = setupIo();
    const sessionCalls = [];
    let snap = {
      prelude: null,
      envelope: { type: "liveGameState", phase: "match_loading", gameKey: "k1" },
      overlayLive: null,
      gameKey: "k1",
    };
    attachSocketAuth(io, {
      secretKey: "sk_test",
      resolveOverlayToken: async () => ({
        userId: "u1",
        label: "main",
        enabledWidgets: ["opponent"],
      }),
      resolveSession: async (userId, tz) => {
        sessionCalls.push({ userId, tz });
        return { wins: 1, losses: 2, games: 3 };
      },
      resolveLiveSnapshot: () => snap,
    });
    const socket = await io.runHandshake({
      auth: { overlayToken: "tok-1", timezone: "UTC" },
    });
    io.runConnect(socket);
    await new Promise((r) => setImmediate(r));
    const initialSessionCalls = sessionCalls.length;
    const initialEmits = socket.emitted.length;

    // Update the snapshot — the next resync should pick this up.
    snap = {
      prelude: {
        type: "liveGameState",
        phase: "match_loading",
        gameKey: "k2",
        synthetic: true,
      },
      envelope: {
        type: "liveGameState",
        phase: "match_in_progress",
        gameKey: "k2",
      },
      overlayLive: { oppName: "Foe", gameKey: "k2" },
      gameKey: "k2",
    };
    socket.fire("overlay:resync");
    await new Promise((r) => setImmediate(r));
    expect(sessionCalls.length).toBe(initialSessionCalls + 1);
    const newEmits = socket.emitted.slice(initialEmits);
    const newEvents = newEmits.map((e) => e.event);
    expect(newEvents).toContain("overlay:liveGame");
    expect(newEvents).toContain("overlay:live");
    expect(newEvents).toContain("overlay:session");
    // Both prelude and envelope were emitted.
    const newLiveGameEmits = newEmits.filter(
      (e) => e.event === "overlay:liveGame",
    );
    expect(newLiveGameEmits).toHaveLength(2);
    expect(newLiveGameEmits[0].payload.synthetic).toBe(true);
    expect(newLiveGameEmits[1].payload.gameKey).toBe("k2");
  });

  test("rate-limits resync to once per 2 s per socket", async () => {
    const io = setupIo();
    const sessionCalls = [];
    attachSocketAuth(io, {
      secretKey: "sk_test",
      resolveOverlayToken: async () => ({
        userId: "u1",
        label: "main",
        enabledWidgets: [],
      }),
      resolveSession: async () => {
        sessionCalls.push(1);
        return { wins: 0, losses: 0, games: 0 };
      },
      resolveLiveSnapshot: () => ({
        prelude: null,
        envelope: null,
        overlayLive: null,
        gameKey: null,
      }),
    });
    const socket = await io.runHandshake({
      auth: { overlayToken: "tok-1" },
    });
    io.runConnect(socket);
    await new Promise((r) => setImmediate(r));
    sessionCalls.length = 0;

    // Three resync requests within 2 s — only the first must
    // trigger a resolveSession call.
    socket.fire("overlay:resync");
    await new Promise((r) => setImmediate(r));
    socket.fire("overlay:resync");
    await new Promise((r) => setImmediate(r));
    socket.fire("overlay:resync");
    await new Promise((r) => setImmediate(r));
    expect(sessionCalls).toHaveLength(1);

    // Push the clock past the rate-limit window — resync becomes
    // accepted again.
    socket.data.lastResyncMs = Date.now() - RESYNC_MIN_INTERVAL_MS - 1;
    socket.fire("overlay:resync");
    await new Promise((r) => setImmediate(r));
    expect(sessionCalls).toHaveLength(2);
  });
});

describe("attachSocketAuth (overlay) — overlay:heartbeat", () => {
  test("replies with the broker's current gameKey", async () => {
    const io = setupIo();
    attachSocketAuth(io, {
      secretKey: "sk_test",
      resolveOverlayToken: async () => ({
        userId: "u1",
        label: "main",
        enabledWidgets: [],
      }),
      resolveLiveSnapshot: () => ({
        prelude: null,
        envelope: null,
        overlayLive: null,
        gameKey: "current-key",
      }),
    });
    const socket = await io.runHandshake({
      auth: { overlayToken: "tok-1" },
    });
    io.runConnect(socket);
    await new Promise((r) => setImmediate(r));
    const initialEmits = socket.emitted.length;
    socket.fire("overlay:heartbeat");
    const reply = socket.emitted.slice(initialEmits).find(
      (e) => e.event === "overlay:heartbeat",
    );
    expect(reply).toBeDefined();
    expect(reply.payload.gameKey).toBe("current-key");
    expect(typeof reply.payload.ts).toBe("number");
  });

  test("replies with gameKey:null when no live state is cached", async () => {
    const io = setupIo();
    attachSocketAuth(io, {
      secretKey: "sk_test",
      resolveOverlayToken: async () => ({
        userId: "u1",
        label: "main",
        enabledWidgets: [],
      }),
      resolveLiveSnapshot: () => ({
        prelude: null,
        envelope: null,
        overlayLive: null,
        gameKey: null,
      }),
    });
    const socket = await io.runHandshake({
      auth: { overlayToken: "tok-1" },
    });
    io.runConnect(socket);
    await new Promise((r) => setImmediate(r));
    const initialEmits = socket.emitted.length;
    socket.fire("overlay:heartbeat");
    const reply = socket.emitted.slice(initialEmits).find(
      (e) => e.event === "overlay:heartbeat",
    );
    expect(reply.payload.gameKey).toBeNull();
  });

  test("a thrown resolveLiveSnapshot doesn't crash the heartbeat reply", async () => {
    const io = setupIo();
    attachSocketAuth(io, {
      secretKey: "sk_test",
      resolveOverlayToken: async () => ({
        userId: "u1",
        label: "main",
        enabledWidgets: [],
      }),
      resolveLiveSnapshot: () => {
        throw new Error("boom");
      },
    });
    const socket = await io.runHandshake({
      auth: { overlayToken: "tok-1" },
    });
    io.runConnect(socket);
    await new Promise((r) => setImmediate(r));
    const initialEmits = socket.emitted.length;
    expect(() => socket.fire("overlay:heartbeat")).not.toThrow();
    const reply = socket.emitted.slice(initialEmits).find(
      (e) => e.event === "overlay:heartbeat",
    );
    expect(reply).toBeDefined();
    expect(reply.payload.gameKey).toBeNull();
  });
});
