// @ts-nocheck
"use strict";

const http = require("http");
const express = require("express");
const request = require("supertest");
const {
  buildReplayIngestAdmission,
  claimReplayIngestAdmission,
  releaseReplayIngestAdmission,
} = require("../src/middleware/replayIngestAdmission");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function testApp({
  hold,
  respondBeforeHold = false,
  rejectAuth = false,
  beforeRoute,
  onRouteStart,
  maxBodyBytes,
  bodyTimeoutMs,
} = {}) {
  const app = express();
  // Production agents always send a device Bearer token. Inject a valid shape
  // here so focused admission tests can stay concerned with capacity; the
  // missing-header case below builds its own app.
  app.use((req, _res, next) => {
    if (!req.headers.authorization) {
      req.headers.authorization = `Bearer ${"t".repeat(43)}`;
    }
    next();
  });
  app.use(buildReplayIngestAdmission({
    maxActive: 1,
    maxBodyBytes,
    bodyTimeoutMs,
  }));
  app.use(express.json({ limit: "5mb" }));
  if (rejectAuth) {
    app.use((_req, res) => res.status(401).json({ error: "unauthorized" }));
    return app;
  }
  if (beforeRoute) app.use(beforeRoute);
  app.post("/v1/games", async (req, res) => {
    if (!claimReplayIngestAdmission(res)) return;
    if (onRouteStart) onRouteStart();
    try {
      if (respondBeforeHold) {
        res.status(202).json({ accepted: [{ gameId: req.body.gameId }] });
      }
      if (hold) await hold.promise;
      if (!respondBeforeHold) {
        res.status(202).json({ accepted: [{ gameId: req.body.gameId }] });
      }
    } finally {
      releaseReplayIngestAdmission(res);
    }
  });
  // Parser errors ordinarily flow through the application error handler.
  app.use((err, _req, res, _next) => {
    if (res.headersSent) return;
    res.status(err.status || 500).json({ error: "bad_json" });
  });
  return app;
}

describe("replay ingest admission", () => {
  test("route claims fail closed when the pre-parser gate is missing", () => {
    const res = { locals: {} };
    expect(claimReplayIngestAdmission(res)).toBe(false);
    expect(claimReplayIngestAdmission(res, { allowMissing: true })).toBe(true);
  });

  test("rejects a missing Bearer header without occupying the ingest slot", async () => {
    const app = express();
    app.use(buildReplayIngestAdmission({ maxActive: 1 }));
    const missing = await request(app).post("/v1/games").send({ gameId: "no-auth" });
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe("missing_token");
    const malformed = await request(app)
      .post("/v1/games")
      .set("authorization", "Bearer token trailing")
      .send({ gameId: "bad-auth" });
    expect(malformed.status).toBe(401);
    const oversized = await request(app)
      .post("/v1/games")
      .set("authorization", `Bearer ${"x".repeat(4097)}`)
      .send({ gameId: "huge-auth" });
    expect(oversized.status).toBe(401);
  });

  test("closes an unauthenticated chunked body instead of draining forever", async () => {
    const app = express();
    app.use(buildReplayIngestAdmission({ maxActive: 1 }));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const outcome = deferred();
      const requestClosed = deferred();
      const req = http.request({
        host: "127.0.0.1",
        port: server.address().port,
        path: "/v1/games",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "transfer-encoding": "chunked",
        },
      }, (res) => {
        res.resume();
        res.on("end", () => outcome.resolve(res.statusCode));
      });
      req.on("error", () => {});
      req.on("close", requestClosed.resolve);
      req.write('{"gameId":"unauth-slow"');
      expect(await outcome.promise).toBe(401);
      await requestClosed.promise;
      expect(req.destroyed).toBe(true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test("rejects concurrent bodies before parsing and recovers after finally", async () => {
    const hold = deferred();
    const started = deferred();
    const app = testApp({ hold, onRouteStart: started.resolve });
    const first = request(app)
      .post("/v1/games")
      .send({ gameId: "first", heavy: "x".repeat(512 * 1024) })
      .then((res) => res);
    await started.promise;
    try {
      const busy = await request(app)
        .post("/v1/games")
        .send({ gameId: "second", heavy: "y".repeat(512 * 1024) });
      expect(busy.status).toBe(503);
      expect(busy.headers["retry-after"]).toBe("5");
      expect(busy.body.error).toMatchObject({
        code: "replay_ingest_busy",
        retryable: true,
      });
    } finally {
      hold.resolve();
    }
    expect((await first).status).toBe(202);
    expect((await request(app).post("/v1/games").send({ gameId: "third" })).status)
      .toBe(202);
  });

  test("normalizes trailing slash onto the same protected endpoint", async () => {
    const hold = deferred();
    const started = deferred();
    const app = testApp({ hold, onRouteStart: started.resolve });
    const first = request(app)
      .post("/v1/games/")
      .send({ gameId: "one" })
      .then((res) => res);
    await started.promise;
    try {
      const busy = await request(app).post("/v1/games/").send({ gameId: "two" });
      expect(busy.status).toBe(503);
    } finally {
      hold.resolve();
    }
    await first;
  });

  test("normalizes mixed-case Express routes onto the protected endpoint", async () => {
    const hold = deferred();
    const started = deferred();
    const app = testApp({ hold, onRouteStart: started.resolve });
    const first = request(app)
      .post("/V1/GaMeS")
      .send({ gameId: "mixed-one" })
      .then((res) => res);
    await started.promise;
    try {
      const busy = await request(app)
        .post("/v1/GAMES")
        .send({ gameId: "mixed-two" });
      expect(busy.status).toBe(503);
    } finally {
      hold.resolve();
    }
    expect((await first).status).toBe(202);
  });

  test("invalid JSON releases a pre-route slot", async () => {
    const app = testApp();
    const invalid = await request(app)
      .post("/v1/games")
      .set("content-type", "application/json")
      .send('{"gameId":');
    expect(invalid.status).toBe(400);
    const valid = await request(app).post("/v1/games").send({ gameId: "ok" });
    expect(valid.status).toBe(202);
  });

  test("an auth rejection releases a pre-route slot", async () => {
    const app = testApp({ rejectAuth: true });
    const first = await request(app).post("/v1/games").send({ gameId: "nope" });
    expect(first.status).toBe(401);
    const second = await request(app).post("/v1/games").send({ gameId: "still-nope" });
    expect(second.status).toBe(401);
  });

  test("rejects an oversized declared busy body without parsing it", async () => {
    const hold = deferred();
    const started = deferred();
    const app = testApp({
      hold,
      onRouteStart: started.resolve,
      maxBodyBytes: 64,
    });
    const first = request(app)
      .post("/v1/games")
      .send({ gameId: "held" })
      .then((res) => res);
    await started.promise;
    try {
      const oversized = await request(app)
        .post("/v1/games")
        .send({ gameId: "too-big", heavy: "x".repeat(128) });
      expect(oversized.status).toBe(413);
      expect(oversized.body.error.code).toBe("payload_too_large");
    } finally {
      hold.resolve();
      await first;
    }
  });

  test("bounds a chunked busy body while draining without JSON allocation", async () => {
    const hold = deferred();
    const started = deferred();
    const app = testApp({
      hold,
      onRouteStart: started.resolve,
      maxBodyBytes: 64,
    });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const first = request(server)
      .post("/v1/games")
      .send({ gameId: "held" })
      .then((res) => res);
    await started.promise;
    try {
      const response = await rawChunkedRequest(server, [
        "x".repeat(40),
        "y".repeat(40),
      ]);
      expect(response.status).toBe(413);
      expect(response.body.error.code).toBe("payload_too_large");
    } finally {
      hold.resolve();
      await first;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test("slow pre-parser body times out, releases, and cannot enter route", async () => {
    let routeStarts = 0;
    const app = testApp({
      bodyTimeoutMs: 40,
      onRouteStart: () => { routeStarts += 1; },
    });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = server.address().port;
      const timedOut = deferred();
      const slow = http.request({
        host: "127.0.0.1",
        port,
        path: "/v1/games",
        method: "POST",
        headers: {
          authorization: `Bearer ${"t".repeat(43)}`,
          "content-type": "application/json",
          "transfer-encoding": "chunked",
        },
      }, (res) => {
        res.resume();
        res.on("end", () => timedOut.resolve(res.statusCode));
      });
      slow.on("error", () => {});
      slow.write('{"gameId":"slow"');
      expect(await timedOut.promise).toBe(408);
      expect(routeStarts).toBe(0);
      expect((await request(server).post("/v1/games").send({ gameId: "after" })).status)
        .toBe(202);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test("response finish does not release claimed work before route finally", async () => {
    const hold = deferred();
    const app = testApp({ hold, respondBeforeHold: true });
    const first = request(app)
      .post("/v1/games")
      .send({ gameId: "responded" })
      .then((res) => res);
    expect((await first).status).toBe(202);
    // The HTTP response finished, but the claimed route is deliberately still
    // awaiting work. Only its finally block may release the admission slot.
    try {
      const busy = await request(app).post("/v1/games").send({ gameId: "too-soon" });
      expect(busy.status).toBe(503);
    } finally {
      hold.resolve();
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    const after = await request(app).post("/v1/games").send({ gameId: "after" });
    expect(after.status).toBe(202);
  });

  test("a disconnect cannot release a claimed slot while route work continues", async () => {
    const hold = deferred();
    const started = deferred();
    const app = testApp({ hold, onRouteStart: started.resolve });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = server.address().port;
      const abortedClosed = deferred();
      const aborted = http.request({
        host: "127.0.0.1",
        port,
        path: "/v1/games",
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      aborted.on("error", () => {});
      aborted.on("close", abortedClosed.resolve);
      aborted.end('{"gameId":"aborted"}');
      await started.promise;
      aborted.destroy();
      await abortedClosed.promise;

      const busy = await request(server)
        .post("/v1/games")
        .send({ gameId: "while-active" });
      expect(busy.status).toBe(503);
      hold.resolve();
      const after = await request(server).post("/v1/games").send({ gameId: "after" });
      expect(after.status).toBe(202);
    } finally {
      hold.resolve();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test("a pre-route disconnect cannot start work after delayed auth resolves", async () => {
    const auth = deferred();
    const authEntered = deferred();
    const authFinished = deferred();
    let routeStarts = 0;
    const app = testApp({
      beforeRoute: async (_req, _res, next) => {
        authEntered.resolve();
        await auth.promise;
        next();
        authFinished.resolve();
      },
      onRouteStart: () => { routeStarts += 1; },
    });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = server.address().port;
      const abortedClosed = deferred();
      const aborted = http.request({
        host: "127.0.0.1",
        port,
        path: "/v1/games",
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      aborted.on("error", () => {});
      aborted.on("close", abortedClosed.resolve);
      aborted.end('{"gameId":"auth-race"}');
      await authEntered.promise;
      aborted.destroy();
      await abortedClosed.promise;
      auth.resolve();
      await authFinished.promise;
      expect(routeStarts).toBe(0);
      expect((await request(server).post("/v1/games").send({ gameId: "after" })).status)
        .toBe(202);
    } finally {
      auth.resolve();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

function rawChunkedRequest(server, chunks) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/v1/games",
      method: "POST",
      headers: {
        authorization: `Bearer ${"t".repeat(43)}`,
        "content-type": "application/json",
        "transfer-encoding": "chunked",
      },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({
        status: res.statusCode,
        body: JSON.parse(text),
      }));
    });
    req.on("error", reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}
