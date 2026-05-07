// @ts-nocheck
"use strict";

/**
 * Coverage for the overlay-flavour of ``attachSocketAuth``.
 *
 * The OBS Browser Source connects with ``auth.overlayToken`` and
 * (optionally) ``auth.timezone``. The handshake middleware must:
 *
 *   - reject when the token does not resolve
 *   - stash the timezone on ``socket.data.timezone`` so subsequent
 *     session-aggregate emits anchor "today" to the streamer's wall
 *     clock
 *   - on connect, push the per-token enabled-widgets config and the
 *     today's-session aggregate so the panel is populated before any
 *     ``overlay:live`` payload arrives
 */

const { attachSocketAuth } = require("../src/socket/auth");

function setupIo() {
  /** @type {Function|null} */
  let mw = null;
  /** @type {Function|null} */
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

describe("attachSocketAuth (overlay)", () => {
  test("rejects when no resolveOverlayToken is wired", async () => {
    const io = setupIo();
    attachSocketAuth(io, {
      secretKey: "sk_test",
    });
    await expect(
      io.runHandshake({ auth: { overlayToken: "tok-1" } }),
    ).rejects.toThrow("overlay_unsupported");
  });

  test("rejects when the token cannot be resolved", async () => {
    const io = setupIo();
    attachSocketAuth(io, {
      secretKey: "sk_test",
      resolveOverlayToken: async () => null,
    });
    await expect(
      io.runHandshake({ auth: { overlayToken: "tok-bad" } }),
    ).rejects.toThrow("invalid_overlay_token");
  });

  test("captures auth.timezone when the OBS source sends it", async () => {
    const io = setupIo();
    attachSocketAuth(io, {
      secretKey: "sk_test",
      resolveOverlayToken: async () => ({
        userId: "u1",
        label: "test",
        enabledWidgets: ["session"],
      }),
    });
    const socket = await io.runHandshake({
      auth: {
        overlayToken: "tok-1",
        timezone: "America/Los_Angeles",
      },
    });
    expect(socket.data.kind).toBe("overlay");
    expect(socket.data.overlayToken).toBe("tok-1");
    expect(socket.data.overlayUserId).toBe("u1");
    expect(socket.data.timezone).toBe("America/Los_Angeles");
  });

  test("ignores empty / oversized timezone strings to avoid abuse", async () => {
    const io = setupIo();
    attachSocketAuth(io, {
      secretKey: "sk_test",
      resolveOverlayToken: async () => ({
        userId: "u1",
        label: "test",
      }),
    });
    const empty = await io.runHandshake({
      auth: { overlayToken: "tok-1", timezone: "" },
    });
    expect(empty.data.timezone).toBeUndefined();
    const tooLong = await io.runHandshake({
      auth: { overlayToken: "tok-1", timezone: "x".repeat(200) },
    });
    expect(tooLong.data.timezone).toBeUndefined();
  });

  test("on connect, joins the rooms and emits config + session", async () => {
    const io = setupIo();
    /** @type {Array<[string, string|undefined]>} */
    const sessionCalls = [];
    attachSocketAuth(io, {
      secretKey: "sk_test",
      resolveOverlayToken: async () => ({
        userId: "u1",
        label: "test",
        enabledWidgets: ["session", "opponent"],
      }),
      resolveSession: async (userId, timezone) => {
        sessionCalls.push([userId, timezone]);
        return { wins: 3, losses: 1, games: 4 };
      },
    });
    const socket = await io.runHandshake({
      auth: { overlayToken: "tok-1", timezone: "America/Los_Angeles" },
    });
    io.runConnect(socket);
    // resolveOverlayToken/resolveSession are async — wait for the
    // microtask queue to drain so their .then handlers run.
    await new Promise((r) => setImmediate(r));

    expect(socket.rooms).toContain("overlay:tok-1");
    expect(socket.rooms).toContain("user:u1");

    const events = socket.emitted.map((e) => e.event);
    expect(events).toContain("overlay:config");
    expect(events).toContain("overlay:session");

    const cfg = socket.emitted.find((e) => e.event === "overlay:config");
    expect(cfg.payload.enabledWidgets).toEqual(["session", "opponent"]);

    const session = socket.emitted.find((e) => e.event === "overlay:session");
    expect(session.payload).toEqual({ wins: 3, losses: 1, games: 4 });

    expect(sessionCalls).toHaveLength(1);
    expect(sessionCalls[0]).toEqual(["u1", "America/Los_Angeles"]);
  });

  test("overlay:set_timezone refreshes the cached tz and re-emits the session", async () => {
    const io = setupIo();
    /** @type {Array<[string, string|undefined]>} */
    const sessionCalls = [];
    attachSocketAuth(io, {
      secretKey: "sk_test",
      resolveOverlayToken: async () => ({
        userId: "u1",
        label: "test",
        enabledWidgets: [],
      }),
      resolveSession: async (userId, timezone) => {
        sessionCalls.push([userId, timezone]);
        return { wins: 0, losses: 0, games: 0 };
      },
    });
    const socket = await io.runHandshake({
      auth: { overlayToken: "tok-1" },
    });
    io.runConnect(socket);
    await new Promise((r) => setImmediate(r));

    socket.fire("overlay:set_timezone", "Europe/Berlin");
    await new Promise((r) => setImmediate(r));

    expect(socket.data.timezone).toBe("Europe/Berlin");
    expect(sessionCalls.length).toBeGreaterThanOrEqual(2);
    expect(sessionCalls[sessionCalls.length - 1]).toEqual(["u1", "Europe/Berlin"]);
  });

  test("a session-resolve failure must not crash the connection", async () => {
    const io = setupIo();
    attachSocketAuth(io, {
      secretKey: "sk_test",
      resolveOverlayToken: async () => ({
        userId: "u1",
        label: "test",
        enabledWidgets: [],
      }),
      resolveSession: async () => {
        throw new Error("transient mongo blip");
      },
    });
    const socket = await io.runHandshake({
      auth: { overlayToken: "tok-1" },
    });
    expect(() => io.runConnect(socket)).not.toThrow();
    await new Promise((r) => setImmediate(r));
    // No overlay:session was emitted, but the socket is still alive.
    expect(socket.emitted.some((e) => e.event === "overlay:session")).toBe(
      false,
    );
  });
});
