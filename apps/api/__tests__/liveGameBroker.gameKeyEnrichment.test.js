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
