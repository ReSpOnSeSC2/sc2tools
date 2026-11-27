// @ts-nocheck
"use strict";
const express = require("express");
const request = require("supertest");
const { StreamGuardianService, GUARDIAN_EXPIRES_MS } = require("../src/services/streamGuardian");
const { buildAgentStreamingRouter } = require("../src/routes/agentStreaming");
const { attachSocketAuth } = require("../src/socket/auth");

const NOW = 1_800_000_000_000;
const fakeIo = () => { const sent = []; return { sent, to: (room) => ({ emit: (event, payload) => sent.push({ room, event, payload }) }) }; };
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("StreamGuardianService", () => {
  test("keeps only the four known rules, once each, and pushes them to the user's room", () => {
    const io = fakeIo();
    const service = new StreamGuardianService({ io, now: () => NOW });
    const result = service.publish("u", [
      { rule: "mic_muted", since: NOW - 5000 }, { rule: "mic_muted", since: NOW - 1 },
      { rule: "not_a_rule", since: NOW }, { rule: "stream_unstable" }, "junk", null,
    ]);
    expect(result.warnings).toEqual([{ rule: "mic_muted", since: NOW - 5000 }, { rule: "stream_unstable", since: NOW }]);
    expect(io.sent).toEqual([{ room: "user:u", event: "overlay:guardian", payload: result }]);
  });

  test("a start time in the future or not a whole number becomes now", () => {
    const service = new StreamGuardianService({ now: () => NOW });
    const warnings = service.sanitize([{ rule: "mic_muted", since: NOW + 3_600_000 }, { rule: "not_recording", since: 12.5 }]);
    expect(warnings.map((row) => row.since)).toEqual([NOW, NOW]);
  });

  test("an empty list clears the user and says so to the Dock", () => {
    const io = fakeIo();
    const service = new StreamGuardianService({ io, now: () => NOW });
    service.publish("u", [{ rule: "mic_muted", since: NOW }]);
    service.publish("u", []);
    expect(service.latest("u")).toBeNull();
    expect(io.sent.at(-1).payload.warnings).toEqual([]);
  });

  test("a list the agent stopped refreshing expires, and only that user's", () => {
    let now = NOW;
    const service = new StreamGuardianService({ now: () => now });
    service.publish("old", [{ rule: "mic_muted", since: NOW }]);
    now += GUARDIAN_EXPIRES_MS - 1;
    expect(service.latest("old")).not.toBeNull();
    service.publish("fresh", [{ rule: "stuck_on_break", since: now }]);
    now += 2;
    expect(service.latest("old")).toBeNull();
    expect(service.latest("fresh")).not.toBeNull();
    expect(service.byUser.has("old")).toBe(false);
  });
});

describe("POST /v1/agent/streaming/guardian", () => {
  const app = (streamGuardian, auth = { userId: "u", source: "device" }) => {
    const server = express();
    server.use(express.json());
    server.use("/v1", buildAgentStreamingRouter({ auth: (req, _res, next) => { req.auth = auth; next(); },
      integrations: {}, streamingTitles: {}, streamGuardian }));
    server.use((error, _req, res, _next) => res.status(error.status || 500).json({ code: error.code }));
    return server;
  };

  test("publishes for the authenticated user and answers with what it kept", async () => {
    const service = new StreamGuardianService({ now: () => NOW });
    const response = await request(app(service)).post("/v1/agent/streaming/guardian")
      .send({ warnings: [{ rule: "mic_muted", since: NOW - 1000 }, { rule: "x" }] }).expect(200);
    expect(response.body).toEqual({ warnings: [{ rule: "mic_muted", since: NOW - 1000 }] });
    expect(service.latest("u").warnings).toHaveLength(1);
  });

  test.each([
    ["a user id beside the list", { warnings: [], userId: "other" }],
    ["no list", {}],
    ["a list that is not an array", { warnings: "mic_muted" }],
  ])("refuses %s", async (_name, body) => {
    const service = new StreamGuardianService({ now: () => NOW });
    await request(app(service)).post("/v1/agent/streaming/guardian").send(body).expect(400);
    expect(service.byUser.size).toBe(0);
  });

  test("needs an account, and a server without the service is unavailable", async () => {
    const service = new StreamGuardianService({ now: () => NOW });
    await request(app(service, { source: "device" })).post("/v1/agent/streaming/guardian").send({ warnings: [] }).expect(401);
    await request(app(undefined)).post("/v1/agent/streaming/guardian").send({ warnings: [] }).expect(503);
  });
});

describe("Dock replay", () => {
  async function connect(resolveGuardian) {
    let middleware, onConnection;
    const io = { use: (fn) => { middleware = fn; }, on: (event, fn) => { if (event === "connection") onConnection = fn; } };
    attachSocketAuth(io, { secretKey: "sk_test", resolveOverlayToken: async () => ({ userId: "owner" }), resolveGuardian });
    const emitted = [];
    const socket = { handshake: { auth: { overlayToken: "good" } }, data: {}, connected: true, join: () => {},
      on: () => {}, emit: (event, payload) => emitted.push({ event, payload }), disconnect: () => {} };
    await new Promise((resolve, reject) => middleware(socket, (error) => error ? reject(error) : resolve()));
    onConnection(socket); await flush();
    return emitted;
  }

  test("a Dock that connects during a warning gets it at once", async () => {
    const held = { warnings: [{ rule: "mic_muted", since: NOW }], at: NOW };
    const resolve = jest.fn(() => held);
    const emitted = await connect(resolve);
    expect(resolve).toHaveBeenCalledWith("owner");
    expect(emitted).toContainEqual({ event: "overlay:guardian", payload: held });
  });

  test("nothing is sent when nothing is wrong, and a failing lookup never blocks the socket", async () => {
    expect((await connect(() => null)).filter((row) => row.event === "overlay:guardian")).toEqual([]);
    const emitted = await connect(() => { throw new Error("boom"); });
    expect(emitted.filter((row) => row.event === "overlay:guardian")).toEqual([]);
  });
});
