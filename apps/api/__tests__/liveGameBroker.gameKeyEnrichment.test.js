// @ts-nocheck
"use strict";

/**
 * Coverage for the broker's gameKey-aware enrichment staleness guard.
 *
 * Real-stream repro:
 *   1. ``match_loading`` for opponent A lands → publish kicks an
 *      async enrichment.
 *   2. The streamer queues up a brand-new game before the slow
 *      Mongo aggregation finishes (e.g. the page didn't open the
 *      socket until after the bridge moved on).
 *   3. ``match_loading`` for opponent B lands → publish stamps the
 *      new gameKey and the fresh enrichment kicks off.
 *   4. Opponent A's enrichment finishes — without the staleness
 *      guard, the broker would broadcast streamerHistory derived
 *      from opponent A AGAINST the now-current opponent B envelope,
 *      and the OBS scouting widget would render A's H2H over B's
 *      identity for the rest of the match.
 *
 * The guard: ``publish`` stamps the per-user current gameKey BEFORE
 * the partial broadcast; the enrichment promise checks against it
 * before its own broadcast. A mismatch drops the enrichment quietly.
 */

const { LiveGameBroker } = require("../src/services/liveGameBroker");

function flushAsync() {
  return new Promise((r) => setImmediate(r));
}

describe("LiveGameBroker — gameKey-aware enrichment staleness guard", () => {
  test("a late-arriving enrichment for the previous gameKey is dropped", async () => {
    const releaseGameA = (() => {
      let r;
      const promise = new Promise((resolve) => {
        r = resolve;
      });
      return { promise, release: r };
    })();

    /**
     * Custom enricher that stalls game-A's enrichment until we
     * release it from the test, while game-B enriches immediately.
     */
    const enrich = async (userId, envelope) => {
      if (envelope.gameKey === "game-A") {
        await releaseGameA.promise;
        return { ...envelope, streamerHistory: { headToHead: { wins: 9, losses: 0 } } };
      }
      return { ...envelope, streamerHistory: { headToHead: { wins: 1, losses: 1 } } };
    };

    const broker = new LiveGameBroker({ enrich });
    const seen = [];
    broker.subscribe("u1", (env) => seen.push(env));

    // 1. game-A loading lands. The partial broadcasts immediately;
    // the enrichment is suspended on releaseGameA.promise.
    broker.publish("u1", {
      type: "liveGameState",
      phase: "match_loading",
      gameKey: "game-A",
      opponent: { name: "OpponentA" },
    });
    await flushAsync();
    expect(seen).toHaveLength(1);
    expect(seen[0].gameKey).toBe("game-A");

    // 2. game-B loading lands BEFORE game-A's enrichment finishes.
    // Partial + enrichment for game-B both broadcast.
    broker.publish("u1", {
      type: "liveGameState",
      phase: "match_loading",
      gameKey: "game-B",
      opponent: { name: "OpponentB" },
    });
    await flushAsync();
    // Partial for game-B AND its (already-resolved) enrichment.
    expect(seen).toHaveLength(3);
    const lastTwoKeys = seen.slice(1).map((e) => e.gameKey);
    expect(lastTwoKeys).toEqual(["game-B", "game-B"]);

    // 3. Release game-A's enrichment. The broker MUST drop it
    // because the current gameKey is now game-B.
    releaseGameA.release();
    await flushAsync();
    await flushAsync();
    expect(seen).toHaveLength(3);
    // Only game-B envelopes survived after the release.
    const surfacedKeys = new Set(seen.map((e) => e.gameKey));
    expect(surfacedKeys).toEqual(new Set(["game-A", "game-B"]));
    // game-A appears once (the partial), never with streamerHistory.
    expect(
      seen.filter((e) => e.gameKey === "game-A" && e.streamerHistory),
    ).toHaveLength(0);
    expect(broker.counters.enrich_stale_dropped).toBe(1);
  });

  test("idle/menu prevents a finished opponent's late enrichment from resurfacing", async () => {
    let releaseEnded;
    const endedGate = new Promise((resolve) => {
      releaseEnded = resolve;
    });
    const enrich = async (userId, envelope) => {
      if (envelope.gameKey === "finished-game") {
        await endedGate;
        return {
          ...envelope,
          streamerHistory: {
            oppName: "FinishedOpponent",
            headToHead: { wins: 2, losses: 3 },
          },
        };
      }
      return envelope;
    };

    const broker = new LiveGameBroker({ enrich });
    const seen = [];
    broker.subscribe("u1", (envelope) => seen.push(envelope));

    broker.publish("u1", {
      type: "liveGameState",
      phase: "match_ended",
      gameKey: "finished-game",
      opponent: { name: "FinishedOpponent" },
    });
    await flushAsync();
    expect(seen).toHaveLength(1);

    broker.publish("u1", {
      type: "liveGameState",
      phase: "menu",
    });
    await flushAsync();
    expect(seen).toHaveLength(2);
    expect(broker.latest("u1").phase).toBe("menu");
    expect(broker.currentGameKey("u1")).toBeNull();

    releaseEnded();
    await flushAsync();
    await flushAsync();

    expect(seen).toHaveLength(2);
    expect(broker.latest("u1").phase).toBe("menu");
    expect(
      seen.filter((envelope) => envelope.streamerHistory),
    ).toHaveLength(0);
    expect(broker.counters.enrich_stale_dropped).toBe(1);
  });

  test("an older match envelope cannot arrive after menu and restore the finished game", () => {
    const broker = new LiveGameBroker();
    const seen = [];
    broker.subscribe("u1", (envelope) => seen.push(envelope));

    broker.publish("u1", {
      type: "liveGameState",
      phase: "match_in_progress",
      capturedAt: 100,
      gameKey: "finished-game",
      opponent: { name: "FinishedOpponent" },
    });
    broker.publish("u1", {
      type: "liveGameState",
      phase: "menu",
      capturedAt: 102,
    });
    // A slower HTTP worker finishes this older request last.
    const staleAccepted = broker.publish("u1", {
      type: "liveGameState",
      phase: "match_ended",
      capturedAt: 101,
      gameKey: "finished-game",
      opponent: { name: "FinishedOpponent" },
    });

    expect(seen.map((envelope) => envelope.phase)).toEqual([
      "match_in_progress",
      "menu",
    ]);
    expect(broker.latest("u1").phase).toBe("menu");
    expect(broker.currentGameKey("u1")).toBeNull();
    expect(broker.counters.published).toBe(3);
    expect(broker.counters.envelope_stale_dropped).toBe(1);
    expect(staleAccepted).toBe(false);
  });

  test("synthetic transition preludes do not poison the source-time watermark", () => {
    const broker = new LiveGameBroker();
    const seen = [];
    broker.subscribe("u1", (envelope) => seen.push(envelope));

    broker.publish("u1", {
      type: "liveGameState",
      phase: "match_in_progress",
      capturedAt: 50,
      gameKey: "old-game",
      opponent: { name: "OldOpponent" },
    });
    broker.publish("u1", {
      type: "liveGameState",
      phase: "menu",
      capturedAt: 101,
      synthetic: true,
    });
    broker.publish("u1", {
      type: "liveGameState",
      phase: "match_loading",
      capturedAt: 102,
      gameKey: "new-game",
      synthetic: true,
    });
    // The original event was captured before its synthetic prelude was
    // constructed. It is still the logically newest real observation.
    broker.publish("u1", {
      type: "liveGameState",
      phase: "match_in_progress",
      capturedAt: 100,
      gameKey: "new-game",
      opponent: { name: "NewOpponent" },
    });

    expect(seen.at(-1)?.phase).toBe("match_in_progress");
    expect(seen.at(-1)?.opponent?.name).toBe("NewOpponent");
    expect(broker.latest("u1").phase).toBe("match_in_progress");
    expect(broker.currentGameKey("u1")).toBe("new-game");
    expect(broker.counters.envelope_stale_dropped).toBe(0);
  });

  test("a reused gameKey cannot attach delayed history to a different opponent", async () => {
    let releaseOpponentA;
    const opponentAGate = new Promise((resolve) => {
      releaseOpponentA = resolve;
    });
    const enrich = async (userId, envelope) => {
      if (envelope.opponent?.name === "Opponent A") {
        await opponentAGate;
        return {
          ...envelope,
          streamerHistory: {
            oppName: "Opponent A",
            headToHead: { wins: 9, losses: 0 },
          },
        };
      }
      return envelope;
    };
    const broker = new LiveGameBroker({ enrich });
    const seen = [];
    broker.subscribe("u1", (envelope) => seen.push(envelope));

    broker.publish("u1", {
      type: "liveGameState",
      phase: "match_loading",
      capturedAt: 100,
      gameKey: "reused-key",
      opponent: { name: "Opponent A" },
    });
    await flushAsync();
    broker.publish("u1", {
      type: "liveGameState",
      phase: "match_loading",
      capturedAt: 100,
      gameKey: "reused-key",
      opponent: { name: "Opponent B" },
    });
    await flushAsync();
    releaseOpponentA();
    await flushAsync();
    await flushAsync();

    expect(seen.map((envelope) => envelope.opponent?.name)).toEqual([
      "Opponent A",
      "Opponent B",
    ]);
    expect(seen.some((envelope) => envelope.streamerHistory)).toBe(false);
    expect(broker.latest("u1").opponent.name).toBe("Opponent B");
    expect(broker.counters.enrich_stale_dropped).toBe(1);
  });

  test("older enrichment for the same match cannot regress a newer phase", async () => {
    let releaseLoading;
    const loadingGate = new Promise((resolve) => {
      releaseLoading = resolve;
    });
    const enrich = async (userId, envelope) => {
      if (envelope.phase === "match_loading") {
        await loadingGate;
        return {
          ...envelope,
          streamerHistory: {
            oppName: "Opponent A",
            headToHead: { wins: 2, losses: 1 },
          },
        };
      }
      return envelope;
    };
    const broker = new LiveGameBroker({ enrich });
    const seen = [];
    broker.subscribe("u1", (envelope) => seen.push(envelope));

    broker.publish("u1", {
      type: "liveGameState",
      phase: "match_loading",
      capturedAt: 100,
      gameKey: "same-game",
      opponent: { name: "Opponent A" },
    });
    await flushAsync();
    broker.publish("u1", {
      type: "liveGameState",
      phase: "match_in_progress",
      capturedAt: 101,
      gameKey: "same-game",
      opponent: { name: "Opponent A" },
    });
    await flushAsync();
    releaseLoading();
    await flushAsync();
    await flushAsync();

    expect(seen.map((envelope) => envelope.phase)).toEqual([
      "match_loading",
      "match_in_progress",
    ]);
    expect(broker.latest("u1").phase).toBe("match_in_progress");
    expect(broker.counters.enrich_stale_dropped).toBe(1);
  });

  test("an enriched payload for the SAME gameKey still broadcasts (no false positives)", async () => {
    const enrich = async (userId, envelope) => ({
      ...envelope,
      streamerHistory: { headToHead: { wins: 2, losses: 1 } },
    });
    const broker = new LiveGameBroker({ enrich });
    const seen = [];
    broker.subscribe("u1", (env) => seen.push(env));

    broker.publish("u1", {
      type: "liveGameState",
      phase: "match_loading",
      gameKey: "game-stable",
    });
    await flushAsync();
    await flushAsync();
    expect(seen).toHaveLength(2);
    expect(seen[0].streamerHistory).toBeUndefined();
    expect(seen[1].streamerHistory).toEqual({
      headToHead: { wins: 2, losses: 1 },
    });
    expect(broker.counters.enrich_stale_dropped).toBe(0);
    expect(broker.counters.enrich_ok).toBe(1);
  });

  test("envelopes without gameKey are NEVER dropped by the guard (legacy / partial)", async () => {
    // The guard short-circuits when the original envelope had no
    // gameKey — there's nothing to compare against, so we trust the
    // enrichment regardless. A future schema where every envelope
    // always carries gameKey would let us tighten this; until then,
    // the broker stays permissive.
    const enrich = async (userId, envelope) => ({
      ...envelope,
      streamerHistory: { headToHead: { wins: 0, losses: 0 } },
    });
    const broker = new LiveGameBroker({ enrich });
    const seen = [];
    broker.subscribe("u1", (env) => seen.push(env));
    broker.publish("u1", {
      type: "liveGameState",
      phase: "match_loading",
    });
    await flushAsync();
    await flushAsync();
    expect(seen).toHaveLength(2);
    expect(seen[1].streamerHistory).toBeDefined();
    expect(broker.counters.enrich_stale_dropped).toBe(0);
  });
});
