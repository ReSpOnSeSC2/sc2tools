// @ts-nocheck
"use strict";
/* eslint-disable max-lines-per-function */

const express = require("express");
const request = require("supertest");
const { buildBuildsRouter } = require("../src/routes/builds");
const { buildCustomBuildsRouter } = require("../src/routes/customBuilds");

const ENDPOINTS = [
  { kind: "custom", url: "/v1/custom-builds/test-build/compositions" },
  { kind: "build", url: "/v1/builds/test-build/phases" },
  { kind: "strategy", url: "/v1/strategies/test-build/phases" },
];

function makeApp(kind, handler) {
  const evaluate = jest.fn(handler || (async (userId, _name, opts) => ({
    userId,
    compareGameId: opts.compareGameId || null,
    perspective: opts.perspective || "you",
    filters: opts.filters,
    sampleLimit: 100,
    sampleTruncated: true,
    checkpoints: [{ timeSec: 240, reachedGames: 1, endedGames: 0 }],
    comparisonGames: [{ gameId: "sample-game" }],
  })));
  const latestGameDateMs = jest.fn(async () => 100);
  const auth = (req, res, next) => {
    const userId = req.get("x-test-user");
    if (!userId) return res.status(401).end();
    req.auth = { userId };
    next();
  };
  const app = express();
  app.use("/v1", kind === "custom"
    ? buildCustomBuildsRouter({
      customBuilds: { evaluateBuildPhases: evaluate, latestGameDateMs },
      perGame: {},
      auth,
    })
    : buildBuildsRouter({
      builds: {},
      strategyPhases: {
        evaluate,
        evaluateByBuildName: evaluate,
        latestGameDateMs,
      },
      auth,
    }));
  return { app, evaluate, latestGameDateMs };
}

describe.each(ENDPOINTS)("$kind composition comparison route", ({ kind, url }) => {
  test("validates comparison identifiers before reading or allocating work", async () => {
    const { app, evaluate, latestGameDateMs } = makeApp(kind);
    const invalidQueries = [
      "compareGameId=",
      `compareGameId=${"x".repeat(201)}`,
      "compareGameId=%20game",
      "compareGameId=game%20",
      "compareGameId=%00game",
      "compareGameId=game%7F",
      "compareGameId=first&compareGameId=second",
      "compareGameId[$ne]=game",
    ];
    for (const query of invalidQueries) {
      const response = await request(app).get(`${url}?${query}`).set("x-test-user", "owner");
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("invalid_compare_game_id");
    }
    expect(evaluate).not.toHaveBeenCalled();
    expect(latestGameDateMs).not.toHaveBeenCalled();
  });

  test("preserves authentication and accepts the persisted 200-character identifier limit", async () => {
    const { app, evaluate } = makeApp(kind);
    expect((await request(app).get(`${url}?compareGameId=game`)).status).toBe(401);
    expect(evaluate).not.toHaveBeenCalled();
    const gameId = "a".repeat(200);
    const response = await request(app).get(url).query({ compareGameId: gameId }).set("x-test-user", "owner");
    expect(response.status).toBe(200);
    expect(response.body.compareGameId).toBe(gameId);
    expect(evaluate).toHaveBeenCalledWith("owner", "test-build", expect.objectContaining({
      compareGameId: gameId,
      signal: expect.any(AbortSignal),
    }));
  });

  test("isolates cached selection by replay, account, perspective and filters", async () => {
    const { app, evaluate } = makeApp(kind);
    const cases = [
      { user: "owner", query: {} },
      { user: "owner", query: { compareGameId: "game-a" } },
      { user: "owner", query: { compareGameId: "game-b" } },
      { user: "owner", query: { compareGameId: "game-a", map: "Map One" } },
      { user: "owner", query: { compareGameId: "game-a", perspective: "opponent" } },
      { user: "other-owner", query: { compareGameId: "game-a" } },
    ];
    for (let pass = 0; pass < 2; pass += 1) {
      for (const { user, query } of cases) {
        const response = await request(app).get(url).query(query).set("x-test-user", user);
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
          userId: user,
          compareGameId: query.compareGameId || null,
          perspective: query.perspective || "you",
          sampleLimit: 100,
          sampleTruncated: true,
          checkpoints: [{ timeSec: 240 }],
          comparisonGames: [{ gameId: "sample-game" }],
        });
      }
    }
    expect(evaluate).toHaveBeenCalledTimes(cases.length);
  });

  test("different concurrent comparison requests cannot share the first selection", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let start;
    const started = new Promise((resolve) => { start = resolve; });
    const { app, evaluate } = makeApp(kind, async (_userId, _name, opts) => {
      if (opts.compareGameId === "game-a") {
        start();
        await gate;
      }
      return { compareGameId: opts.compareGameId };
    });
    const first = request(app).get(url).query({ compareGameId: "game-a" })
      .set("x-test-user", "owner").then((response) => response);
    await started;
    const second = request(app).get(url).query({ compareGameId: "game-b" })
      .set("x-test-user", "owner").then((response) => response);
    release();
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses.map((response) => response.body.compareGameId)).toEqual(["game-a", "game-b"]);
    expect(evaluate).toHaveBeenCalledTimes(2);
  });
});
