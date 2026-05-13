// @ts-nocheck
"use strict";

/**
 * Coverage for the web-tab flavour of ``attachSocketAuth``.
 *
 * The analyzer dashboard connects with ``auth.token = <Clerk JWT>``
 * so the cloud can push per-user events (``games:changed``,
 * ``import:progress``, ``macro:recompute_request``) back to the open
 * tab. This file exercises the handshake + connection path:
 *
 *   * Clerk JWT verification is mocked at the module level so the
 *     handshake does not require a real Clerk dev instance.
 *   * The middleware MUST call ``resolveClerkUser`` and stash the
 *     internal userId so the connection handler can auto-join
 *     ``user:<userId>``.
 *   * ``subscribe:user`` must be locked down to the caller's own
 *     userId once we have it (no cross-user room joins).
 *   * Resolver failures (Mongo blip during ``ensureFromClerk``) must
 *     not break the handshake — the socket still connects, the
 *     legacy free-form subscribe:user path is still available.
 */

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(),
}));

const { verifyToken } = require("@clerk/backend");
const { attachSocketAuth } = require("../src/socket/auth");

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

describe("attachSocketAuth (web tab)", () => {
  beforeEach(() => {
    verifyToken.mockReset();
  });

  test("auto-joins ``user:<userId>`` after resolveClerkUser maps the Clerk sub", async () => {
    verifyToken.mockResolvedValueOnce({ sub: "user_clerk_abc" });
    const io = setupIo();
    const resolveCalls = [];
    attachSocketAuth(io, {
      secretKey: "sk_test",
      resolveClerkUser: async (clerkUserId) => {
        resolveCalls.push(clerkUserId);
        return { userId: "internal-u1" };
      },
    });
    const socket = await io.runHandshake({
      auth: { token: "jwt-placeholder" },
    });
    expect(socket.data.kind).toBe("web");
    expect(socket.data.clerkUserId).toBe("user_clerk_abc");
    expect(socket.data.userId).toBe("internal-u1");
    io.runConnect(socket);
    expect(socket.rooms).toContain("clerk:user_clerk_abc");
    expect(socket.rooms).toContain("user:internal-u1");
    expect(resolveCalls).toEqual(["user_clerk_abc"]);
  });

  test("handshake survives when resolveClerkUser throws (resolution is non-fatal)", async () => {
    verifyToken.mockResolvedValueOnce({ sub: "user_clerk_abc" });
    const io = setupIo();
    attachSocketAuth(io, {
      secretKey: "sk_test",
      resolveClerkUser: async () => {
        throw new Error("transient mongo blip");
      },
    });
    const socket = await io.runHandshake({
      auth: { token: "jwt-placeholder" },
    });
    expect(socket.data.userId).toBeUndefined();
    // Socket still joins the clerk room; auto-join to user room is
    // simply skipped. The client can still claim a userId via
    // subscribe:user (the backward-compat path).
    io.runConnect(socket);
    expect(socket.rooms).toContain("clerk:user_clerk_abc");
    expect(socket.rooms).not.toContain("user:internal-u1");
  });

  test("subscribe:user is locked to the resolved userId", async () => {
    verifyToken.mockResolvedValueOnce({ sub: "user_clerk_abc" });
    const io = setupIo();
    attachSocketAuth(io, {
      secretKey: "sk_test",
      resolveClerkUser: async () => ({ userId: "internal-u1" }),
    });
    const socket = await io.runHandshake({
      auth: { token: "jwt-placeholder" },
    });
    io.runConnect(socket);
    // Auto-joined to user:internal-u1 already.
    expect(socket.rooms).toContain("user:internal-u1");
    // Pretend a malicious client tries to subscribe to another
    // user's room — the handler must refuse.
    socket.fire("subscribe:user", "internal-u2");
    expect(socket.rooms).not.toContain("user:internal-u2");
    // Self-subscription is still allowed (idempotent re-join).
    socket.fire("subscribe:user", "internal-u1");
    expect(socket.rooms.filter((r) => r === "user:internal-u1").length).toBe(2);
  });

  test(
    "subscribe:user keeps the legacy free-form behaviour when resolveClerkUser is not wired " +
      "(backward compat for the test harness)",
    async () => {
      verifyToken.mockResolvedValueOnce({ sub: "user_clerk_abc" });
      const io = setupIo();
      attachSocketAuth(io, {
        secretKey: "sk_test",
        // resolveClerkUser deliberately omitted
      });
      const socket = await io.runHandshake({
        auth: { token: "jwt-placeholder" },
      });
      io.runConnect(socket);
      // No auto-join to user:* — the resolver was missing.
      expect(socket.rooms.find((r) => r.startsWith("user:"))).toBeUndefined();
      // The legacy free-form join still works so existing test
      // setups that drove the socket via subscribe:user keep
      // functioning.
      socket.fire("subscribe:user", "any-user-id");
      expect(socket.rooms).toContain("user:any-user-id");
    },
  );

  test("rejects when the JWT cannot be verified", async () => {
    verifyToken.mockRejectedValueOnce(new Error("jwt expired"));
    const io = setupIo();
    attachSocketAuth(io, {
      secretKey: "sk_test",
      resolveClerkUser: async () => ({ userId: "internal-u1" }),
    });
    await expect(
      io.runHandshake({ auth: { token: "jwt-placeholder" } }),
    ).rejects.toThrow();
  });

  test("rejects when claims have no subject", async () => {
    verifyToken.mockResolvedValueOnce({});
    const io = setupIo();
    attachSocketAuth(io, {
      secretKey: "sk_test",
      resolveClerkUser: async () => ({ userId: "internal-u1" }),
    });
    await expect(
      io.runHandshake({ auth: { token: "jwt-placeholder" } }),
    ).rejects.toThrow("invalid_token");
  });
});
