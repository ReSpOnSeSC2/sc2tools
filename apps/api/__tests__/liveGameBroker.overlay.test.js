// @ts-nocheck
"use strict";

/**
 * Cross-surface fan-out coverage for ``LiveGameBroker``: each
 * ``publish()`` must reach BOTH the SSE subscriber callbacks AND
 * every active ``overlay:<token>`` room belonging to the publishing
 * user.
 *
 * Scope of this file:
 *   1. Active tokens receive ``overlay:liveGame`` for every publish.
 *   2. Revoked tokens are filtered out of the emit loop.
 *   3. A throwing Socket.io ``emit`` for one token must not stop
 *      either the SSE fan-out or the next token's emit.
 *   4. Per-user isolation: alice's envelope never reaches bob's
 *      overlay tokens (Pulse / scouting data is k-anon-sensitive,
 *      cross-tenant leakage is unacceptable).
 *   5. The publish path stays non-blocking when the token-list lookup
 *      throws — the agent's POST should not surface an error from a
 *      Mongo blip on the overlay-tokens collection.
 */

const { LiveGameBroker } = require("../src/services/liveGameBroker");

/**
 * Build a fake socket.io ``Server`` shape the broker can ``.to(room)``
 * against. Each ``.to(room)`` returns an object with ``.emit(ev, payload)``
 * which records the call into ``calls``. ``failOnRoom`` lets a test
 * inject a per-room throw without poisoning the rest of the loop.
 */
function fakeIo({ failOnRoom } = {}) {
  const calls = [];
  const io = {
    to(room) {
      return {
        emit(event, payload) {
          if (failOnRoom && failOnRoom === room) {
            throw new Error(`emit_failed_${room}`);
          }
          calls.push({ room, event, payload });
        },
      };
    },
  };
  return { io, calls };
}

/**
 * Stubbed ``OverlayTokensService`` — only ``list(userId)`` is exercised
 * by the broker today. Each test seeds the per-user token list
 * directly.
 */
function fakeOverlayTokens(byUser) {
  return {
    async list(userId) {
      return byUser[userId] || [];
    },
  };
}

function silentLogger() {
  return { warn: () => {}, debug: () => {}, info: () => {} };
}

// Helper: yield enough event-loop turns to let the broker's
// fire-and-forget ``_fanOutToOverlayTokens`` resolve before the
// assertions run. The broker fans out via an async path so the
// publish() caller (the agent's POST handler) doesn't pay the Mongo
// round-trip latency.
const flushAsync = () => new Promise((r) => setImmediate(r));

describe("LiveGameBroker — overlay Socket.io fan-out", () => {
  test("publish emits overlay:liveGame to every active token of the user", async () => {
    const { io, calls } = fakeIo();
    const overlayTokens = fakeOverlayTokens({
      "user-a": [
        { token: "tok_main", revokedAt: null },
        { token: "tok_friend", revokedAt: null },
      ],
    });
    const broker = new LiveGameBroker({
      io,
      overlayTokens,
      logger: silentLogger(),
    });

    broker.publish("user-a", { type: "liveGameState", phase: "match_loading" });
    await flushAsync();

    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.room).sort()).toEqual(
      ["overlay:tok_friend", "overlay:tok_main"],
    );
    expect(calls.every((c) => c.event === "overlay:liveGame")).toBe(true);
    expect(calls[0].payload.phase).toBe("match_loading");
    expect(broker.counters.overlay_emit_ok).toBe(2);
    expect(broker.counters.overlay_emit_failed).toBe(0);
  });

  test("revoked tokens are skipped", async () => {
    const { io, calls } = fakeIo();
    const overlayTokens = fakeOverlayTokens({
      "user-a": [
        { token: "tok_alive", revokedAt: null },
        { token: "tok_revoked", revokedAt: new Date("2026-01-01") },
        { token: "tok_alive2", revokedAt: null },
      ],
    });
    const broker = new LiveGameBroker({
      io,
      overlayTokens,
      logger: silentLogger(),
    });

    broker.publish("user-a", { phase: "match_started" });
    await flushAsync();

    expect(calls.map((c) => c.room).sort()).toEqual(
      ["overlay:tok_alive", "overlay:tok_alive2"],
    );
    expect(calls.find((c) => c.room === "overlay:tok_revoked")).toBeUndefined();
  });

  test("a throwing Socket.io emit for one token does not block the others or the SSE fan-out", async () => {
    const { io, calls } = fakeIo({ failOnRoom: "overlay:tok_bad" });
    const overlayTokens = fakeOverlayTokens({
      "user-a": [
        { token: "tok_good", revokedAt: null },
        { token: "tok_bad", revokedAt: null },
        { token: "tok_other", revokedAt: null },
      ],
    });
    const broker = new LiveGameBroker({
      io,
      overlayTokens,
      logger: silentLogger(),
    });

    const sseSeen = [];
    broker.subscribe("user-a", (env) => sseSeen.push(env));

    broker.publish("user-a", { phase: "match_started" });
    await flushAsync();

    expect(sseSeen).toHaveLength(1);
    expect(calls.map((c) => c.room).sort()).toEqual(
      ["overlay:tok_good", "overlay:tok_other"],
    );
    expect(broker.counters.overlay_emit_failed).toBe(1);
    expect(broker.counters.overlay_emit_ok).toBe(2);
  });

  test("per-user isolation: alice's envelope never reaches bob's overlay tokens", async () => {
    const { io, calls } = fakeIo();
    const overlayTokens = fakeOverlayTokens({
      alice: [{ token: "alice_tok", revokedAt: null }],
      bob: [{ token: "bob_tok", revokedAt: null }],
    });
    const broker = new LiveGameBroker({
      io,
      overlayTokens,
      logger: silentLogger(),
    });

    broker.publish("alice", { phase: "match_loading", gameKey: "alice|x" });
    await flushAsync();

    expect(calls).toHaveLength(1);
    expect(calls[0].room).toBe("overlay:alice_tok");
    expect(calls.find((c) => c.room === "overlay:bob_tok")).toBeUndefined();
  });

  test("an overlayTokens.list() failure is logged and swallowed without throwing", async () => {
    const errors = [];
    const logger = {
      warn: (obj, msg) => errors.push({ obj, msg }),
      debug: () => {},
      info: () => {},
    };
    const overlayTokens = {
      async list() {
        throw new Error("mongo_blip");
      },
    };
    const { io, calls } = fakeIo();
    const broker = new LiveGameBroker({ io, overlayTokens, logger });

    // Publish must not throw even though list() rejects.
    expect(() =>
      broker.publish("user-a", { phase: "match_loading" }),
    ).not.toThrow();
    await flushAsync();

    expect(calls).toHaveLength(0);
    expect(broker.counters.overlay_emit_failed).toBeGreaterThanOrEqual(1);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  test("publish without io/overlayTokens still works (SSE-only mode)", () => {
    // Broker constructed without overlay deps — the SSE path must
    // still function so the existing `/v1/me/live` tests stay green.
    const broker = new LiveGameBroker();
    const seen = [];
    broker.subscribe("user-a", (env) => seen.push(env));
    broker.publish("user-a", { phase: "match_loading" });
    expect(seen).toEqual([{ phase: "match_loading" }]);
    expect(broker.counters.published).toBe(1);
    expect(broker.counters.overlay_emit_ok).toBe(0);
  });

  test("counters reflect the per-publish fan-out outcomes", async () => {
    const { io } = fakeIo();
    const overlayTokens = fakeOverlayTokens({
      "user-a": [
        { token: "t1", revokedAt: null },
        { token: "t2", revokedAt: null },
      ],
    });
    const broker = new LiveGameBroker({
      io,
      overlayTokens,
      logger: silentLogger(),
    });

    broker.subscribe("user-a", () => {});
    broker.publish("user-a", { phase: "x" });
    await flushAsync();
    broker.publish("user-a", { phase: "y" });
    await flushAsync();

    expect(broker.counters.published).toBe(2);
    expect(broker.counters.sse_emit_ok).toBe(2);
    expect(broker.counters.overlay_emit_ok).toBe(4);
  });
});
