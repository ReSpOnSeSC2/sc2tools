// @ts-nocheck
"use strict";
/* eslint-disable max-lines-per-function */

const express = require("express");
const request = require("supertest");

const { buildCustomBuildsRouter } = require("../src/routes/customBuilds");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolve_, reject_) => {
    resolve = resolve_;
    reject = reject_;
  });
  return { promise, resolve, reject };
}

async function waitForCondition(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return Boolean(predicate());
}

async function abortSupertest(test, settled) {
  test.abort();
  await settled;
  // Supertest creates a temporary listener for each request when handed an
  // Express app. Its abort path does not close that listener for us.
  const server = test._server;
  if (server && server.listening) {
    await new Promise((resolve, reject) => server.close((error) => {
      if (error) reject(error);
      else resolve();
    }));
  }
}

function phasePayload(slug) {
  return {
    slug,
    name: slug,
    perspective: "you",
    sampleSize: {},
    perPhase: {},
    finalPhaseDistribution: {},
    medianCrossings: {},
    durationP95Sec: 0,
    flags: [],
    transitions: { nodes: [], edges: [] },
  };
}

function makeHarness(evaluateBuildPhases, overrides = {}) {
  const customBuilds = {
    latestGameDateMs: jest.fn(async () => 1_786_644_000_000),
    evaluateBuildPhases: jest.fn(evaluateBuildPhases),
    evaluateAllStats: jest.fn(async () => []),
    evaluateBuild: jest.fn(async (_userId, slug) => ({ slug })),
    get: jest.fn(async (_userId, slug) => ({ slug, name: slug })),
    upsert: jest.fn(async () => undefined),
    softDelete: jest.fn(async () => undefined),
    enqueueReclassify: jest.fn(async () => ({
      status: "queued",
      generation: "phase-test-generation",
    })),
    ...overrides,
  };
  const app = express();
  app.use(express.json());
  app.use(
    "/v1",
    buildCustomBuildsRouter({
      customBuilds,
      perGame: {},
      auth: (req_, _res, next) => {
        req_.auth = { userId: "phase-user" };
        next();
      },
    }),
  );
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: { code: err.code || "internal_error" } });
  });
  return { app, customBuilds };
}

describe("custom-build phase endpoint admission", () => {
  test("stats and matches share the bounded lane and receive cancellation signals", async () => {
    const statsStarted = deferred();
    const releaseStats = deferred();
    let statsSignal;
    let matchesSignal;
    const evaluateAllStats = jest.fn(async (_userId, opts) => {
      statsSignal = opts.signal;
      statsStarted.resolve();
      await releaseStats.promise;
      return [];
    });
    const evaluateBuild = jest.fn(async (_userId, slug, opts) => {
      matchesSignal = opts.signal;
      return { slug };
    });
    const { app } = makeHarness(
      async (_userId, slug) => phasePayload(slug),
      { evaluateAllStats, evaluateBuild },
    );

    const stats = request(app)
      .get("/v1/custom-builds/stats")
      .then((response) => response);
    await statsStarted.promise;
    const matches = request(app)
      .get("/v1/custom-builds/lane-match/matches")
      .then((response) => response);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(evaluateBuild).not.toHaveBeenCalled();
    expect(statsSignal).toBeInstanceOf(AbortSignal);

    releaseStats.resolve();
    const responses = await Promise.all([stats, matches]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(evaluateAllStats).toHaveBeenCalledTimes(1);
    expect(evaluateBuild).toHaveBeenCalledTimes(1);
    expect(matchesSignal).toBeInstanceOf(AbortSignal);
  });

  test("disconnecting queued matches removes them before heavy evaluation", async () => {
    const statsStarted = deferred();
    const releaseStats = deferred();
    const evaluateAllStats = jest.fn(async () => {
      statsStarted.resolve();
      await releaseStats.promise;
      return [];
    });
    const evaluateBuild = jest.fn(async (_userId, slug) => ({ slug }));
    const { app } = makeHarness(
      async (_userId, slug) => phasePayload(slug),
      { evaluateAllStats, evaluateBuild },
    );

    const active = request(app)
      .get("/v1/custom-builds/stats")
      .then((response) => response);
    await statsStarted.promise;
    const queued = request(app).get("/v1/custom-builds/no-late-match/matches");
    const queuedSettled = queued.then(
      (response) => response,
      (error) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await abortSupertest(queued, queuedSettled);
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseStats.resolve();
    expect((await active).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(evaluateBuild).not.toHaveBeenCalled();
  });

  test("disconnecting active stats aborts its scan and frees the lane", async () => {
    const statsStarted = deferred();
    const abortObserved = deferred();
    let calls = 0;
    const evaluateAllStats = jest.fn(async (_userId, opts) => {
      calls += 1;
      if (calls > 1) return [];
      statsStarted.resolve();
      await new Promise((resolve, reject) => {
        const abort = () => {
          abortObserved.resolve();
          const error = new Error("stats disconnected");
          error.name = "AbortError";
          reject(error);
        };
        if (opts.signal.aborted) abort();
        else opts.signal.addEventListener("abort", abort, { once: true });
      });
      return [];
    });
    const { app } = makeHarness(
      async (_userId, slug) => phasePayload(slug),
      { evaluateAllStats },
    );

    const disconnected = request(app).get("/v1/custom-builds/stats");
    const disconnectedSettled = disconnected.then(
      (response) => response,
      (error) => error,
    );
    await statsStarted.promise;
    const aborting = abortSupertest(disconnected, disconnectedSettled);
    await abortObserved.promise;
    await aborting;

    const retry = await request(app).get("/v1/custom-builds/stats");
    expect(retry.status).toBe(200);
    expect(evaluateAllStats).toHaveBeenCalledTimes(2);
  });

  test("identical concurrent requests share one phase computation", async () => {
    const started = deferred();
    const release = deferred();
    const { app, customBuilds } = makeHarness(async (_userId, slug) => {
      started.resolve();
      await release.promise;
      return phasePayload(slug);
    });

    const first = request(app)
      .get("/v1/custom-builds/shared/compositions")
      .then((response) => response);
    await started.promise;
    const second = request(app)
      .get("/v1/custom-builds/shared/compositions")
      .then((response) => response);

    expect(await waitForCondition(() =>
      customBuilds.latestGameDateMs.mock.calls.length === 2)).toBe(true);
    expect(customBuilds.evaluateBuildPhases).toHaveBeenCalledTimes(1);
    release.resolve();

    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses[0].body).toEqual(responses[1].body);
    expect(customBuilds.evaluateBuildPhases).toHaveBeenCalledTimes(1);
  });

  test("one disconnected subscriber does not abort identical shared work", async () => {
    const started = deferred();
    const release = deferred();
    let computeSignal;
    const { app, customBuilds } = makeHarness(
      async (_userId, slug, opts) => {
        computeSignal = opts.signal;
        started.resolve();
        await release.promise;
        return phasePayload(slug);
      },
    );

    const first = request(app).get("/v1/custom-builds/shared-abort/compositions");
    const firstSettled = first.then(
      (response) => response,
      (error) => error,
    );
    await started.promise;
    const second = request(app)
      .get("/v1/custom-builds/shared-abort/compositions")
      .then((response) => response);
    expect(await waitForCondition(() =>
      customBuilds.latestGameDateMs.mock.calls.length === 2)).toBe(true);

    await abortSupertest(first, firstSettled);
    expect(computeSignal.aborted).toBe(false);
    release.resolve();

    const response = await second;
    expect(response.status).toBe(200);
    expect(customBuilds.evaluateBuildPhases).toHaveBeenCalledTimes(1);
    expect(computeSignal.aborted).toBe(false);
  });

  test("disconnecting the final subscriber aborts active phase hydration", async () => {
    const started = deferred();
    const abortObserved = deferred();
    let attempt = 0;
    const { app, customBuilds } = makeHarness(
      async (_userId, slug, opts) => {
        attempt += 1;
        if (attempt > 1) return phasePayload(slug);
        started.resolve();
        await new Promise((resolve, reject) => {
          const abort = () => {
            abortObserved.resolve();
            const error = new Error("phase request disconnected");
            error.name = "AbortError";
            reject(error);
          };
          if (opts.signal.aborted) abort();
          else opts.signal.addEventListener("abort", abort, { once: true });
        });
        return phasePayload(slug);
      },
    );

    const disconnected = request(app)
      .get("/v1/custom-builds/active-abort/compositions");
    const disconnectedSettled = disconnected.then(
      (response) => response,
      (error) => error,
    );
    await started.promise;
    const aborting = abortSupertest(disconnected, disconnectedSettled);
    await abortObserved.promise;
    await aborting;

    const retry = await request(app)
      .get("/v1/custom-builds/active-abort/compositions");
    expect(retry.status).toBe(200);
    expect(customBuilds.evaluateBuildPhases).toHaveBeenCalledTimes(2);
  });

  test("an immediate replacement never joins or caches an aborted partial result", async () => {
    const started = deferred();
    const abortObserved = deferred();
    const releaseAbortedCompute = deferred();
    let attempt = 0;
    const { app, customBuilds } = makeHarness(
      async (_userId, slug, opts) => {
        attempt += 1;
        if (attempt === 1) {
          started.resolve();
          await new Promise((resolve) => {
            const abort = () => {
              abortObserved.resolve();
              resolve();
            };
            if (opts.signal.aborted) abort();
            else opts.signal.addEventListener("abort", abort, { once: true });
          });
          await releaseAbortedCompute.promise;
          return { ...phasePayload(slug), flags: ["partial-aborted"] };
        }
        return { ...phasePayload(slug), flags: ["fresh-complete"] };
      },
    );

    const disconnected = request(app)
      .get("/v1/custom-builds/immediate-retry/compositions");
    const disconnectedSettled = disconnected.then(
      (response) => response,
      (error) => error,
    );
    await started.promise;
    const aborting = abortSupertest(disconnected, disconnectedSettled);
    await abortObserved.promise;

    const replacement = request(app)
      .get("/v1/custom-builds/immediate-retry/compositions")
      .then((response) => response);
    expect(await waitForCondition(() =>
      customBuilds.latestGameDateMs.mock.calls.length === 2)).toBe(true);
    releaseAbortedCompute.resolve();
    await aborting;

    const fresh = await replacement;
    expect(fresh.status).toBe(200);
    expect(fresh.body.flags).toEqual(["fresh-complete"]);
    expect(customBuilds.evaluateBuildPhases).toHaveBeenCalledTimes(2);

    const cached = await request(app)
      .get("/v1/custom-builds/immediate-retry/compositions");
    expect(cached.body.flags).toEqual(["fresh-complete"]);
    expect(customBuilds.evaluateBuildPhases).toHaveBeenCalledTimes(2);
  });

  test("a disconnected queued request leaves the lane without late work", async () => {
    const activeStarted = deferred();
    const releaseActive = deferred();
    let callIndex = 0;
    const { app, customBuilds } = makeHarness(async (_userId, slug) => {
      const index = callIndex;
      callIndex += 1;
      if (index === 0) {
        activeStarted.resolve();
        await releaseActive.promise;
      }
      return phasePayload(slug);
    });

    const active = request(app)
      .get("/v1/custom-builds/holds-lane/compositions")
      .then((response) => response);
    await activeStarted.promise;
    const queued = request(app)
      .get("/v1/custom-builds/disconnected-queue/compositions");
    const queuedSettled = queued.then(
      (response) => response,
      (error) => error,
    );
    expect(await waitForCondition(() =>
      customBuilds.latestGameDateMs.mock.calls.length === 2)).toBe(true);

    await abortSupertest(queued, queuedSettled);
    // Superagent observes its local abort just before Node delivers the
    // response close event to the Express handler. Keep the active lane held
    // until that disconnect has propagated to the queued subscriber.
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseActive.resolve();
    expect((await active).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(customBuilds.evaluateBuildPhases).toHaveBeenCalledTimes(1);

    const retry = await request(app)
      .get("/v1/custom-builds/disconnected-queue/compositions");
    expect(retry.status).toBe(200);
    expect(customBuilds.evaluateBuildPhases).toHaveBeenCalledTimes(2);
  });

  test("a failed shared computation releases the lane and is retryable", async () => {
    const started = deferred();
    const releaseFailure = deferred();
    let attempt = 0;
    const { app, customBuilds } = makeHarness(async (_userId, slug) => {
      attempt += 1;
      if (attempt === 1) {
        started.resolve();
        await releaseFailure.promise;
        throw new Error("phase failed");
      }
      return phasePayload(slug);
    });

    const first = request(app)
      .get("/v1/custom-builds/retry/compositions")
      .then((response) => response);
    await started.promise;
    const second = request(app)
      .get("/v1/custom-builds/retry/compositions")
      .then((response) => response);
    expect(await waitForCondition(() =>
      customBuilds.latestGameDateMs.mock.calls.length === 2)).toBe(true);
    releaseFailure.resolve();

    const failures = await Promise.all([first, second]);
    expect(failures.map((response) => response.status)).toEqual([500, 500]);
    expect(customBuilds.evaluateBuildPhases).toHaveBeenCalledTimes(1);

    const retry = await request(app)
      .get("/v1/custom-builds/retry/compositions");
    expect(retry.status).toBe(200);
    expect(customBuilds.evaluateBuildPhases).toHaveBeenCalledTimes(2);
  });

  test("compositions and transitions share one global execution lane", async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    let active = 0;
    let maxActive = 0;
    let callIndex = 0;
    const { app, customBuilds } = makeHarness(async (_userId, slug) => {
      const index = callIndex;
      callIndex += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (index === 0) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      active -= 1;
      return phasePayload(slug);
    });

    const compositions = request(app)
      .get("/v1/custom-builds/one/compositions")
      .then((response) => response);
    await firstStarted.promise;
    const transitions = request(app)
      .get("/v1/custom-builds/two/transitions")
      .then((response) => response);

    expect(await waitForCondition(() =>
      customBuilds.latestGameDateMs.mock.calls.length === 2)).toBe(true);
    expect(customBuilds.evaluateBuildPhases).toHaveBeenCalledTimes(1);
    expect(maxActive).toBe(1);
    releaseFirst.resolve();

    const responses = await Promise.all([compositions, transitions]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(customBuilds.evaluateBuildPhases).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
  });

  test("rejects excess distinct work instead of retaining an unbounded queue", async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    let callIndex = 0;
    const { app, customBuilds } = makeHarness(async (_userId, slug) => {
      const index = callIndex;
      callIndex += 1;
      if (index === 0) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      return phasePayload(slug);
    });

    const active = request(app)
      .get("/v1/custom-builds/active/compositions")
      .then((response) => response);
    await firstStarted.promise;
    const queued = Array.from({ length: 8 }, (_, index) =>
      request(app)
        .get(`/v1/custom-builds/queued-${index}/compositions`)
        .then((response) => response));
    expect(await waitForCondition(() =>
      customBuilds.latestGameDateMs.mock.calls.length === 9)).toBe(true);

    const overflow = await request(app)
      .get("/v1/custom-builds/overflow/compositions");
    expect(overflow.status).toBe(503);
    expect(overflow.headers["retry-after"]).toBe("2");
    expect(overflow.body).toEqual({
      error: { code: "phase_analysis_busy" },
    });

    releaseFirst.resolve();
    const admitted = await Promise.all([active, ...queued]);
    expect(admitted.every((response) => response.status === 200)).toBe(true);
  });

  test("evicts the least-recent phase payload after 32 cache entries", async () => {
    const { app, customBuilds } = makeHarness(async (_userId, slug) =>
      phasePayload(slug));

    for (let index = 0; index < 33; index += 1) {
      const response = await request(app)
        .get(`/v1/custom-builds/cache-${index}/compositions`);
      expect(response.status).toBe(200);
    }
    expect(customBuilds.evaluateBuildPhases).toHaveBeenCalledTimes(33);

    const evicted = await request(app)
      .get("/v1/custom-builds/cache-0/compositions");
    expect(evicted.status).toBe(200);
    expect(customBuilds.evaluateBuildPhases).toHaveBeenCalledTimes(34);

    const retained = await request(app)
      .get("/v1/custom-builds/cache-32/compositions");
    expect(retained.status).toBe(200);
    expect(customBuilds.evaluateBuildPhases).toHaveBeenCalledTimes(34);
  });

  test("saving or deleting a build invalidates its cached phase payload", async () => {
    const { app, customBuilds } = makeHarness(async (_userId, slug) =>
      phasePayload(slug));

    const first = await request(app)
      .get("/v1/custom-builds/edited/compositions");
    const cached = await request(app)
      .get("/v1/custom-builds/edited/compositions");
    expect(first.status).toBe(200);
    expect(cached.status).toBe(200);
    expect(customBuilds.evaluateBuildPhases).toHaveBeenCalledTimes(1);

    const save = await request(app)
      .put("/v1/custom-builds/edited")
      .send({
        name: "Edited build",
        race: "Protoss",
        vsRace: "Terran",
        rules: [{ type: "before", name: "BuildPylon", time_lt: 60 }],
      });
    expect(save.status).toBe(200);
    expect((await request(app)
      .get("/v1/custom-builds/edited/compositions")).status).toBe(200);
    expect(customBuilds.evaluateBuildPhases).toHaveBeenCalledTimes(2);

    const remove = await request(app)
      .delete("/v1/custom-builds/edited");
    expect(remove.status).toBe(204);
    expect((await request(app)
      .get("/v1/custom-builds/edited/compositions")).status).toBe(200);
    expect(customBuilds.evaluateBuildPhases).toHaveBeenCalledTimes(3);
  });

  test("a build edit aborts old in-flight analysis and only caches its replacement", async () => {
    const oldStarted = deferred();
    const releaseOld = deferred();
    let oldSignal;
    let attempt = 0;
    const { app, customBuilds } = makeHarness(
      async (_userId, slug, opts) => {
        attempt += 1;
        if (attempt === 1) {
          oldSignal = opts.signal;
          oldStarted.resolve();
          await releaseOld.promise;
          return { ...phasePayload(slug), flags: ["stale-before-edit"] };
        }
        return { ...phasePayload(slug), flags: ["fresh-after-edit"] };
      },
    );

    const oldRequest = request(app)
      .get("/v1/custom-builds/edit-race/compositions")
      .then((response) => response);
    await oldStarted.promise;
    const save = await request(app)
      .put("/v1/custom-builds/edit-race")
      .send({
        name: "Edited build",
        race: "Protoss",
        vsRace: "Terran",
        rules: [{ type: "before", name: "BuildPylon", time_lt: 60 }],
      });
    expect(save.status).toBe(200);
    expect(oldSignal.aborted).toBe(true);

    const replacement = request(app)
      .get("/v1/custom-builds/edit-race/compositions")
      .then((response) => response);
    expect(await waitForCondition(() =>
      customBuilds.latestGameDateMs.mock.calls.length === 2)).toBe(true);
    releaseOld.resolve();

    const stale = await oldRequest;
    const fresh = await replacement;
    expect(stale.status).toBe(409);
    expect(stale.headers["retry-after"]).toBe("2");
    expect(stale.body).toEqual({
      error: { code: "analysis_invalidated" },
    });
    expect(fresh.status).toBe(200);
    expect(fresh.body.flags).toEqual(["fresh-after-edit"]);
    expect(customBuilds.evaluateBuildPhases).toHaveBeenCalledTimes(2);

    const cached = await request(app)
      .get("/v1/custom-builds/edit-race/compositions");
    expect(cached.body.flags).toEqual(["fresh-after-edit"]);
    expect(customBuilds.evaluateBuildPhases).toHaveBeenCalledTimes(2);
  });

  test.each([
    {
      label: "aggregate stats",
      path: "/v1/custom-builds/stats",
      serviceMethod: "evaluateAllStats",
      value: [],
    },
    {
      label: "build matches",
      path: "/v1/custom-builds/edit-race/matches",
      serviceMethod: "evaluateBuild",
      value: { slug: "edit-race" },
    },
  ])(
    "a build edit terminates stale $label work with a retryable response",
    async ({ path, serviceMethod, value }) => {
      const started = deferred();
      const release = deferred();
      let workSignal;
      const evaluate = jest.fn(async (...args) => {
        workSignal = args[args.length - 1].signal;
        started.resolve();
        await release.promise;
        return value;
      });
      const { app } = makeHarness(
        async (_userId, slug) => phasePayload(slug),
        { [serviceMethod]: evaluate },
      );

      const staleRequest = request(app).get(path).then((response) => response);
      await started.promise;
      const save = await request(app)
        .put("/v1/custom-builds/edit-race")
        .send({
          name: "Edited build",
          race: "Protoss",
          vsRace: "Terran",
          rules: [{ type: "before", name: "BuildPylon", time_lt: 60 }],
        });
      expect(save.status).toBe(200);
      expect(workSignal.aborted).toBe(true);
      release.resolve();

      const stale = await staleRequest;
      expect(stale.status).toBe(409);
      expect(stale.headers["retry-after"]).toBe("2");
      expect(stale.body).toEqual({
        error: { code: "analysis_invalidated" },
      });
      expect(evaluate).toHaveBeenCalledTimes(1);
    },
  );
});
