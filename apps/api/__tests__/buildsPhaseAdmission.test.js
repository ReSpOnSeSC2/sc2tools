// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { buildBuildsRouter } = require("../src/routes/builds");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function payload(name) {
  return {
    name,
    total: 1,
    perspective: "you",
    sampleSize: {},
    perPhase: {},
    finalPhaseDistribution: {},
    medianCrossings: {},
    durationP95Sec: 0,
    flags: [],
    sampleLimit: 100,
    sampleTruncated: false,
  };
}

function makeApp(strategyPhases) {
  const app = express();
  app.use("/v1", buildBuildsRouter({
    builds: {
      list: async () => [],
      detail: async () => null,
      oppStrategies: async () => [],
    },
    strategyPhases,
    auth(req, _res, next) {
      req.auth = { userId: "phase-user", source: "clerk" };
      next();
    },
  }));
  return app;
}

describe("strategy/build phase admission", () => {
  test("identical requests share one bounded computation", async () => {
    const gate = deferred();
    const started = deferred();
    const evaluate = jest.fn(async (_userId, name, opts) => {
      expect(opts.signal).toBeInstanceOf(AbortSignal);
      started.resolve();
      await gate.promise;
      return payload(name);
    });
    const app = makeApp({ latestGameDateMs: async () => 1, evaluate });

    const first = request(app).get("/v1/strategies/mass-ling/phases").then((r) => r);
    const second = request(app).get("/v1/strategies/mass-ling/phases").then((r) => r);
    await started.promise;
    expect(evaluate).toHaveBeenCalledTimes(1);
    gate.resolve();
    const responses = await Promise.all([first, second]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  test("distinct phase scans use one process-wide lane", async () => {
    const firstGate = deferred();
    const firstStarted = deferred();
    const secondStarted = deferred();
    const evaluate = jest.fn(async (_userId, name) => {
      if (name === "first") {
        firstStarted.resolve();
        await firstGate.promise;
      } else {
        secondStarted.resolve();
      }
      return payload(name);
    });
    const app = makeApp({ latestGameDateMs: async () => 1, evaluate });

    const first = request(app).get("/v1/strategies/first/phases").then((r) => r);
    await firstStarted.promise;
    const second = request(app).get("/v1/strategies/second/phases").then((r) => r);
    await new Promise((resolve) => setImmediate(resolve));
    expect(evaluate).toHaveBeenCalledTimes(1);
    firstGate.resolve();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    await secondStarted.promise;
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  test("phase cache is a 32-entry LRU instead of an unbounded map", async () => {
    const evaluate = jest.fn(async (_userId, name) => payload(name));
    const app = makeApp({ latestGameDateMs: async () => 1, evaluate });
    for (let i = 0; i < 34; i += 1) {
      const res = await request(app).get(`/v1/strategies/s-${i}/phases`);
      expect(res.status).toBe(200);
    }
    expect(evaluate).toHaveBeenCalledTimes(34);
    expect((await request(app).get("/v1/strategies/s-0/phases")).status).toBe(200);
    expect(evaluate).toHaveBeenCalledTimes(35);
  });
});
