// @ts-nocheck
"use strict";

/**
 * Coverage for the broker's resync surface: the synthetic prelude
 * helper plus the cached post-game payload accessor.
 *
 * The actual ``overlay:resync`` Socket.io event handler lives in
 * ``socket/auth.js`` (and is exercised by the
 * ``socketAuthOverlay.resync.test.js`` suite); here we focus on the
 * broker-level building blocks ``replayLatestForOverlay`` /
 * ``setLatestOverlayLive`` / ``latestOverlayLive`` /
 * ``currentGameKey``.
 */

const { LiveGameBroker } = require("../src/services/liveGameBroker");

function fakeIo() {
  const calls = [];
  return {
    io: {
      to(room) {
        return {
          emit(event, payload) {
            calls.push({ room, event, payload });
          },
        };
      },
    },
    calls,
  };
}

function fakeOverlayTokens(byUser) {
  return {
    async list(userId) {
      return byUser[userId] || [];
    },
  };
}

const flushAsync = () => new Promise((r) => setImmediate(r));

describe("LiveGameBroker — replayLatestForOverlay", () => {
  test("emits NO prelude when the cached envelope is at match_loading", () => {
    const broker = new LiveGameBroker();
    broker.publish("u1", {
      type: "liveGameState",
      phase: "match_loading",
      gameKey: "k",
      capturedAt: 1,
    });
    const replay = broker.replayLatestForOverlay("u1");
    expect(replay.envelope).toBeTruthy();
    expect(replay.envelope.phase).toBe("match_loading");
    expect(replay.prelude).toBeNull();
  });

  test("emits a synthetic match_loading prelude when the cached envelope is past loading", () => {
    const broker = new LiveGameBroker();
    broker.publish("u1", {
      type: "liveGameState",
      phase: "match_in_progress",
      gameKey: "k1",
      capturedAt: 100,
    });
    const replay = broker.replayLatestForOverlay("u1");
    expect(replay.prelude).toBeTruthy();
    expect(replay.prelude.phase).toBe("match_loading");
    expect(replay.prelude.gameKey).toBe("k1");
    expect(replay.prelude.synthetic).toBe(true);
    expect(replay.envelope.phase).toBe("match_in_progress");
    expect(replay.envelope.gameKey).toBe("k1");
  });

  test("emits a prelude when the cached envelope is at match_ended (e.g. score screen)", () => {
    const broker = new LiveGameBroker();
    broker.publish("u1", {
      type: "liveGameState",
      phase: "match_ended",
      gameKey: "k-end",
      capturedAt: 200,
    });
    const replay = broker.replayLatestForOverlay("u1");
    expect(replay.prelude).toBeTruthy();
    expect(replay.prelude.phase).toBe("match_loading");
    expect(replay.prelude.gameKey).toBe("k-end");
    expect(replay.envelope.phase).toBe("match_ended");
  });

  test("a non-loading envelope without a gameKey gets NO prelude (we can't fabricate identity)", () => {
    const broker = new LiveGameBroker();
    broker.publish("u1", {
      type: "liveGameState",
      phase: "match_in_progress",
      capturedAt: 100,
    });
    const replay = broker.replayLatestForOverlay("u1");
    expect(replay.prelude).toBeNull();
    expect(replay.envelope.phase).toBe("match_in_progress");
  });

  test("returns nulls when nothing is cached", () => {
    const broker = new LiveGameBroker();
    const replay = broker.replayLatestForOverlay("nobody");
    expect(replay).toEqual({ prelude: null, envelope: null });
  });
});

describe("LiveGameBroker — overlay:live cache for resync replay", () => {
  test("setLatestOverlayLive / latestOverlayLive round-trip the post-game payload", () => {
    const broker = new LiveGameBroker();
    expect(broker.latestOverlayLive("u1")).toBeNull();
    const payload = { oppName: "Foe", result: "win", gameKey: "g-final" };
    broker.setLatestOverlayLive("u1", payload);
    expect(broker.latestOverlayLive("u1")).toBe(payload);
  });

  test("expired entries return null and are evicted from the map", () => {
    const broker = new LiveGameBroker();
    // Force the entry to be 31 minutes old (just past _maxAgeMs).
    broker._latestOverlayLive.set("u1", {
      payload: { oppName: "Old" },
      ts: Date.now() - 31 * 60 * 1000,
    });
    expect(broker.latestOverlayLive("u1")).toBeNull();
    expect(broker._latestOverlayLive.has("u1")).toBe(false);
  });

  test("clear() drops the post-game payload cache too", () => {
    const broker = new LiveGameBroker();
    broker.setLatestOverlayLive("u1", { oppName: "Foe" });
    broker.clear();
    expect(broker.latestOverlayLive("u1")).toBeNull();
  });
});

describe("LiveGameBroker — currentGameKey", () => {
  test("publishes update the per-user current gameKey", () => {
    const broker = new LiveGameBroker();
    expect(broker.currentGameKey("u1")).toBeNull();
    broker.publish("u1", {
      type: "liveGameState",
      phase: "match_loading",
      gameKey: "k1",
    });
    expect(broker.currentGameKey("u1")).toBe("k1");
    broker.publish("u1", {
      type: "liveGameState",
      phase: "match_loading",
      gameKey: "k2",
    });
    expect(broker.currentGameKey("u1")).toBe("k2");
  });

  test("envelopes without a gameKey leave the previous current key in place", () => {
    const broker = new LiveGameBroker();
    broker.publish("u1", {
      type: "liveGameState",
      phase: "match_loading",
      gameKey: "k1",
    });
    expect(broker.currentGameKey("u1")).toBe("k1");
    broker.publish("u1", {
      type: "liveGameState",
      phase: "match_in_progress",
    });
    // No gameKey on the inbound envelope — the in-progress tick
    // doesn't reset the per-user current key (a missing key here is
    // a serialisation gap, not a transition signal).
    expect(broker.currentGameKey("u1")).toBe("k1");
  });
});

describe("LiveGameBroker — subscribe replay carries the prelude", () => {
  test("a fresh subscriber for a mid-match user receives prelude + envelope in order", () => {
    const broker = new LiveGameBroker();
    broker.publish("u1", {
      type: "liveGameState",
      phase: "match_in_progress",
      gameKey: "k-mid",
      capturedAt: 50,
    });
    const seen = [];
    broker.subscribe("u1", (env) => seen.push(env));
    expect(seen).toHaveLength(2);
    expect(seen[0].phase).toBe("match_loading");
    expect(seen[0].synthetic).toBe(true);
    expect(seen[1].phase).toBe("match_in_progress");
  });

  test("a fresh subscriber for a user at match_loading receives only the cached envelope", () => {
    const broker = new LiveGameBroker();
    broker.publish("u1", {
      type: "liveGameState",
      phase: "match_loading",
      gameKey: "k",
      capturedAt: 50,
    });
    const seen = [];
    broker.subscribe("u1", (env) => seen.push(env));
    expect(seen).toHaveLength(1);
    expect(seen[0].phase).toBe("match_loading");
    expect(seen[0].synthetic).toBeUndefined();
  });
});
