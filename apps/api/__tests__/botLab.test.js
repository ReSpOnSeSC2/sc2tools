// @ts-nocheck
"use strict";
const express = require("express");
const request = require("supertest");
const { buildBotLabRouter } = require("../src/routes/botLab");

const DEVICE = "d".repeat(24);
const ID = "a".repeat(32);
const BOT = "b".repeat(24);
const MAP = "c".repeat(24);
const start = { deviceId: DEVICE, requestId: ID, botId: BOT, mapId: MAP, humanRace: "Protoss" };
function fixture({ enabled = true, admin = true, source = "clerk", devices, reply, pending } = {}) {
  const ack = jest.fn(pending || (async () => reply || { status: "starting", sessionId: ID }));
  const device = { data: { kind: "device", userId: "owner", deviceId: DEVICE }, timeout: jest.fn(() => ({ emitWithAck: ack })) };
  const io = { in: jest.fn(() => ({ fetchSockets: async () => devices || [device] })) };
  const auth = jest.fn((req, _res, next) => { req.auth = { userId: "owner", source, clerkUserId: source === "clerk" ? "clerk_owner" : undefined }; next(); });
  const app = express();
  app.use(express.json());
  app.use("/v1/bot-lab", buildBotLabRouter({ enabled, auth, io, isAdmin: () => admin }));
  app.use((err, _req, res, _next) => { res.status(err.status || 500).json({ error: { code: err.code || "error" } }); });
  return { app, ack, auth, io, device };
}
test("disabled feature does zero authentication or socket work", async () => {
  const f = fixture({ enabled: false });
  expect((await request(f.app).get("/v1/bot-lab/catalog")).status).toBe(404);
  expect((await request(f.app).post("/v1/bot-lab/sessions").send(start)).status).toBe(404);
  expect(f.auth).not.toHaveBeenCalled(); expect(f.io.in).not.toHaveBeenCalled();
});
test.each([{ admin: false }, { source: "device" }])("only a signed-in admin can access %j", async (options) => {
  const f = fixture(options);
  expect((await request(f.app).get("/v1/bot-lab/catalog")).status).toBe(404);
  expect(f.io.in).not.toHaveBeenCalled();
});
test("catalog filters paths and enforces declared race restrictions", async () => {
  const f = fixture({ reply: { ready: true, bots: [{ id: BOT, race: "Protoss", label: "candidate", updates: 2, maxApm: 999, checkpoint: "secret" }], maps: [{ id: MAP, label: "test map", path: "secret" }], token: "secret", activeSessionId: ID } });
  const res = await request(f.app).get("/v1/bot-lab/catalog");
  expect(res.status).toBe(200); expect(res.headers["cache-control"]).toContain("no-store");
  expect(res.body.bots[0]).toMatchObject({ maxApm: 200, cameraRestricted: true });
  expect(JSON.stringify(res.body)).not.toContain("secret");
  expect(f.io.in).toHaveBeenCalledWith("user:owner");
});
test("multiple devices require an explicit choice and never broadcast", async () => {
  const f = fixture({ devices: [{ data: { kind: "device", userId: "owner", deviceId: DEVICE } }, { data: { kind: "device", userId: "owner", deviceId: "e".repeat(24) } }] });
  const res = await request(f.app).get("/v1/bot-lab/catalog");
  expect(res.body.agent.code).toBe("choose_device"); expect(f.ack).not.toHaveBeenCalled();
});
test("foreign or unverified devices cannot be selected", async () => {
  const f = fixture({ devices: [{ data: { kind: "device", userId: "someone-else", deviceId: DEVICE } }] });
  expect((await request(f.app).post("/v1/bot-lab/sessions").send(start)).status).toBe(409);
  expect(f.ack).not.toHaveBeenCalled();
});
test("start sends a single allowlisted command and response", async () => {
  const f = fixture({ reply: { status: "starting", sessionId: ID, command: "private", pid: 99, workspace: "private" } });
  const res = await request(f.app).post("/v1/bot-lab/sessions").send(start);
  expect(res.status).toBe(202); expect(res.body).toMatchObject({ id: ID, deviceId: DEVICE, status: "starting" });
  expect(JSON.stringify(res.body)).not.toContain("private");
  expect(f.ack).toHaveBeenCalledTimes(1);
  expect(f.ack.mock.calls[0]).toEqual(["bot-lab:request", { operation: "start", requestId: ID, botId: BOT, mapId: MAP, humanRace: "Protoss" }]);
});
test.each([{ ...start, path: "C:/malicious" }, { ...start, requestId: "../a" }, { ...start, humanRace: "Random" }, { ...start, deviceId: "" }])("rejects malformed commands %j", async (body) => {
  const f = fixture();
  expect((await request(f.app).post("/v1/bot-lab/sessions").send(body)).status).toBe(400);
  expect(f.ack).not.toHaveBeenCalled();
});
test("lost ACK is explicit and never retries", async () => {
  const f = fixture({ pending: async () => { throw new Error("timeout"); } });
  const res = await request(f.app).post("/v1/bot-lab/sessions").send(start);
  expect(res.status).toBe(504); expect(res.body.error.code).toBe("agent_ack_unknown"); expect(f.ack).toHaveBeenCalledTimes(1);
});
test("status and stop require the same explicit device and request identity", async () => {
  const f = fixture({ reply: { status: "closed" } });
  expect((await request(f.app).get(`/v1/bot-lab/sessions/${ID}`)).status).toBe(400);
  expect((await request(f.app).get(`/v1/bot-lab/sessions/${ID}?deviceId=${DEVICE}`)).body.status).toBe("closed");
  expect((await request(f.app).post(`/v1/bot-lab/sessions/${ID}/stop`).send({ deviceId: DEVICE })).body.status).toBe("closed");
  expect(f.ack.mock.calls.map((call) => call[1].operation)).toEqual(["status", "stop"]);
});
test("concurrent device operations do not overlap", async () => {
  let complete;
  const f = fixture({ pending: () => new Promise((resolve) => { complete = resolve; }) });
  const running = request(f.app).post("/v1/bot-lab/sessions").send(start).then((res) => res);
  while (!complete) await new Promise((resolve) => setTimeout(resolve, 1));
  const duplicate = await request(f.app).post("/v1/bot-lab/sessions").send(start);
  expect(duplicate.status).toBe(409); expect(f.ack).toHaveBeenCalledTimes(1);
  complete({ status: "starting" }); await running;
});

test("device authentication preserves stable pairing identity across sockets", async () => {
  const { attachSocketAuth } = require("../src/socket/auth");
  let middleware;
  const io = { use: (fn) => { middleware = fn; }, on: jest.fn() };
  const resolveDeviceToken = jest.fn(async () => ({ userId: "owner", deviceId: DEVICE }));
  attachSocketAuth(io, { secretKey: "unused", resolveDeviceToken });
  for (const socketId of ["old-socket", "reconnected-socket"]) {
    const socket = { id: socketId, data: {}, handshake: { auth: { deviceToken: "private-token" } } };
    await new Promise((resolve, reject) => middleware(socket, (err) => err ? reject(err) : resolve()));
    expect(socket.data).toMatchObject({ userId: "owner", kind: "device", deviceId: DEVICE });
    expect(JSON.stringify(socket.data)).not.toContain("private-token");
  }
});
