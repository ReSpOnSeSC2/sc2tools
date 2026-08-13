// @ts-nocheck
"use strict";

/**
 * Regression: historical re-uploads must never fire the live overlay.
 *
 * Full resyncs / the Builds-page reclassify / the Macro backfill /
 * bulk imports all re-upload the user's history through the SAME
 * ``POST /v1/games`` ingest as freshly-played games. Pre-fix, every
 * batch fan-out built an ``overlay:live`` post-game payload from the
 * batch's last game — a years-old replay — and overwrote the broker's
 * cached payload with it, so the streamer's OBS scene re-ran stale
 * widgets for the whole duration of a backfill and the resync replay
 * kept re-showing the last one for 30 minutes after.
 *
 * The gate: emit only when the batch contains a game played within
 * the freshness window, and emit for the FRESHEST accepted game (not
 * the last array element) so a real game finishing mid-backfill still
 * reaches the stream.
 */

const express = require("express");
const request = require("supertest");
const { buildGamesRouter } = require("../src/routes/games");

function buildTestApp({ created = true } = {}) {
  const emitted = [];
  const builtFrom = [];
  const cachedPayloads = [];
  const games = {
    upsert: jest.fn(async () => created),
  };
  const opponents = { refreshMetadata: jest.fn(async () => ({})) };
  const overlayLive = {
    buildFromGame: jest.fn(async (_userId, game) => {
      builtFrom.push(game.gameId);
      return { oppName: game?.opponent?.displayName || "Opp", result: "Victory" };
    }),
  };
  const overlayTokens = {
    list: jest.fn(async () => [{ token: "tok-1", revokedAt: null }]),
  };
  const liveGameBroker = {
    latest: () => null,
    setLatestOverlayLive: jest.fn((_userId, payload) => {
      cachedPayloads.push(payload);
    }),
  };
  const io = {
    to: (room) => ({
      emit: (event, payload) => emitted.push({ room, event, payload }),
    }),
  };
  const auth = (req, _res, next) => {
    req.auth = { userId: "u1" };
    next();
  };
  const app = express();
  app.use(express.json());
  app.use(
    buildGamesRouter({
      games,
      opponents,
      overlayLive,
      overlayTokens,
      liveGameBroker,
      io,
      auth,
      testOnlyAllowMissingReplayIngestAdmission: true,
    }),
  );
  return { app, emitted, builtFrom, cachedPayloads };
}

function gameAt(gameId, date) {
  return {
    gameId,
    date,
    result: "Victory",
    myRace: "Zerg",
    map: "Site Delta",
    opponent: { displayName: `Opp-${gameId}` },
  };
}

const overlayLiveEvents = (emitted) =>
  emitted.filter((e) => e.event === "overlay:live");

// Ingest fan-out is fire-and-forget; give the microtask queue a beat.
const settle = () => new Promise((r) => setTimeout(r, 25));

describe("POST /games — overlay:live freshness gate", () => {
  test("a just-played game fans out to the overlay", async () => {
    const { app, emitted } = buildTestApp();
    const res = await request(app)
      .post("/games")
      .send(gameAt("fresh", new Date().toISOString()));
    expect(res.status).toBe(202);
    await settle();
    expect(overlayLiveEvents(emitted)).toHaveLength(1);
    expect(overlayLiveEvents(emitted)[0].room).toBe("overlay:tok-1");
  });

  test("a historical re-upload does NOT fan out (and does not poison the cache)", async () => {
    const { app, emitted, cachedPayloads } = buildTestApp();
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
    const res = await request(app).post("/games").send(gameAt("old", twoDaysAgo));
    expect(res.status).toBe(202);
    await settle();
    expect(overlayLiveEvents(emitted)).toHaveLength(0);
    expect(cachedPayloads).toHaveLength(0);
  });

  test("an all-historical backfill batch is fully skipped", async () => {
    const { app, emitted } = buildTestApp();
    const games = [];
    for (let i = 0; i < 25; i++) {
      games.push(
        gameAt(`g${i}`, new Date(Date.now() - (i + 1) * 24 * 3600 * 1000).toISOString()),
      );
    }
    const res = await request(app).post("/games").send({ games });
    expect(res.status).toBe(202);
    await settle();
    expect(overlayLiveEvents(emitted)).toHaveLength(0);
  });

  test("a fresh game buried mid-batch still reaches the stream (freshest wins, not last)", async () => {
    const { app, emitted, builtFrom } = buildTestApp();
    const res = await request(app)
      .post("/games")
      .send({
        games: [
          gameAt("old-1", new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString()),
          gameAt("just-played", new Date(Date.now() - 60 * 1000).toISOString()),
          // Last element is historical — pre-fix this one would have
          // driven the fan-out.
          gameAt("old-2", new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString()),
        ],
      });
    expect(res.status).toBe(202);
    await settle();
    expect(overlayLiveEvents(emitted)).toHaveLength(1);
    expect(builtFrom).toEqual(["just-played"]);
  });

  test("a game with an unparseable date is treated as historical", async () => {
    const { app, emitted } = buildTestApp();
    // upsert is mocked to accept anything; the gate must still refuse
    // to put it on stream.
    const res = await request(app)
      .post("/games")
      .send(gameAt("baddate", "not-a-date"));
    expect(res.status).toBe(202);
    await settle();
    expect(overlayLiveEvents(emitted)).toHaveLength(0);
  });
});

describe("POST /games — duplicate live-event defense", () => {
  test("a fresh re-upload does not re-fire widgets or overwrite cache", async () => {
    const { app, emitted, builtFrom, cachedPayloads } = buildTestApp({
      created: false,
    });
    const res = await request(app)
      .post("/games")
      .send(gameAt("fresh-retry", new Date().toISOString()));
    expect(res.status).toBe(202);
    expect(res.body.accepted).toEqual([
      { gameId: "fresh-retry", created: false },
    ]);
    await settle();
    expect(builtFrom).toHaveLength(0);
    expect(overlayLiveEvents(emitted)).toHaveLength(0);
    expect(cachedPayloads).toHaveLength(0);
  });
});
