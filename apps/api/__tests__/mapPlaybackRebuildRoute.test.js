// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { buildPerGameRouter } = require("../src/routes/perGame");
const { updatePlaybackJob } = require("../src/services/replayPlaybackJobs");

function setup({ result = { ok: true, v: 6 }, ack = { ok: true }, online = true } = {}) {
  const device = { id: "device-1", data: { kind: "device" }, timeout: jest.fn().mockReturnThis(),
    emitWithAck: jest.fn(async (_event, payload) => ({ ...ack, requestId: payload.requestId, gameId: payload.gameIds[0] })) };
  const web = { data: { kind: "web" }, emitWithAck: jest.fn() };
  const io = { in: jest.fn(() => ({ fetchSockets: async () => online ? [web, device] : [web] })) };
  const perGame = { mapPlayback: jest.fn().mockResolvedValue(result), hasGame: jest.fn().mockResolvedValue(result !== null) };
  const app = express();
  app.use(express.json());
  app.use("/v1", buildPerGameRouter({ perGame, io, auth(req, _res, next) { req.auth = { userId: "u" }; next(); } }));
  return { app, device, web, perGame, io };
}

test("engine rebuild checks ownership before dispatching to a device", async () => {
  const { app, perGame, device } = setup({ result: null });
  const response = await request(app).post("/v1/games/not-owned/map-playback").send({ fidelity: "engine" });
  expect(response.status).toBe(404);
  expect(perGame.hasGame).toHaveBeenCalledWith("u", "not-owned");
  expect(perGame.mapPlayback).not.toHaveBeenCalled();
  expect(device.emitWithAck).not.toHaveBeenCalled();
});

test("status polling checks ownership without loading playback, including an absent job", async () => {
  const { app, perGame } = setup();
  const response = await request(app).get("/v1/games/status-only/map-playback/status");
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ ok: true, rebuild: null });
  expect(perGame.hasGame).toHaveBeenCalledWith("u", "status-only");
  expect(perGame.mapPlayback).not.toHaveBeenCalled();
  const started = await request(app).post("/v1/games/status-only/map-playback");
  const polled = await request(app).get("/v1/games/status-only/map-playback/status");
  expect(polled.body.rebuild.requestId).toBe(started.body.rebuild.requestId);
  expect(perGame.mapPlayback).not.toHaveBeenCalled();
  perGame.hasGame.mockResolvedValue(false);
  expect((await request(app).get("/v1/games/status-only/map-playback/status")).status).toBe(404);
});

test("a connected browser does not count as an online desktop agent", async () => {
  const { app } = setup({ online: false });
  const response = await request(app).post("/v1/games/offline/map-playback").send({});
  expect(response.status).toBe(503);
  expect(response.body.error.code).toBe("agent_offline");
});

test("dispatch is acknowledged, scoped, and repeated clicks reuse the active request", async () => {
  const { app, device, web } = setup();
  const first = await request(app).post("/v1/games/queued/map-playback").send({ fidelity: "engine" });
  expect(first.status).toBe(202);
  expect(device.emitWithAck).toHaveBeenCalledWith("macro:recompute_request", {
    gameIds: ["queued"], replayFidelity: "engine", requestId: first.body.rebuild.requestId,
  });
  expect(web.emitWithAck).not.toHaveBeenCalled();
  expect((await request(app).post("/v1/games/queued/map-playback")).status).toBe(202);
  expect(device.emitWithAck).toHaveBeenCalledTimes(1);
});

test("missing local replay and runtime failures reach the polling UI", async () => {
  const missing = setup({ ack: { ok: false, code: "replay_not_found" } });
  const response = await request(missing.app).post("/v1/games/missing/map-playback");
  expect(response.status).toBe(409);
  expect(response.body.error.code).toBe("replay_not_found");
  const { app } = setup();
  const started = await request(app).post("/v1/games/failed-capture/map-playback");
  const requestId = started.body.rebuild.requestId;
  expect(updatePlaybackJob("other-user", "failed-capture", requestId, { status: "failed" })).toBe(false);
  expect(updatePlaybackJob("u", "failed-capture", "stale", { status: "failed" })).toBe(false);
  expect(updatePlaybackJob("u", "failed-capture", requestId, { status: "failed", code: "engine_capture_failed", message: "SC2 build unavailable" })).toBe(true);
  const polled = await request(app).get("/v1/games/failed-capture/map-playback");
  expect(polled.body.rebuild).toMatchObject({ status: "failed", message: "SC2 build unavailable" });
});

test("legacy agents without an acknowledgement return an actionable update error", async () => {
  const { app, device } = setup();
  device.emitWithAck.mockRejectedValue(new Error("operation timed out"));
  const response = await request(app).post("/v1/games/old-agent/map-playback");
  expect(response.status).toBe(503);
  expect(response.body.error.code).toBe("agent_update_required");
});

test("rebuild status is readable when an old game has no playback payload yet", async () => {
  const { app } = setup({ result: { ok: false, code: "not_computed" } });
  const started = await request(app).post("/v1/games/not-computed/map-playback");
  expect(started.status).toBe(202);
  const response = await request(app).get("/v1/games/not-computed/map-playback");
  expect(response.status).toBe(200);
  expect(response.body.rebuild.requestId).toBe(started.body.rebuild.requestId);
});

test("multiple devices only accept status from the acknowledged device", async () => {
  const { app, device, io } = setup({ ack: { ok: false, code: "replay_not_found" } });
  const second = { id: "device-2", data: { kind: "device" }, timeout: jest.fn().mockReturnThis(),
    emitWithAck: jest.fn(async (_event, payload) => ({ ok: true, requestId: payload.requestId, gameId: payload.gameIds[0] })) };
  io.in.mockReturnValue({ fetchSockets: async () => [device, second] });
  const response = await request(app).post("/v1/games/two-devices/map-playback");
  expect(response.status).toBe(202);
  const id = response.body.rebuild.requestId;
  expect(updatePlaybackJob("u", "two-devices", id, { status: "failed" }, "device-1")).toBe(false);
  expect(updatePlaybackJob("u", "two-devices", id, { status: "processing" }, "device-2")).toBe(true);
});

test("an uncertain acknowledgement does not launch a second duplicate capture", async () => {
  const { app, device, io } = setup();
  device.emitWithAck.mockRejectedValue(new Error("ACK lost"));
  const second = { id: "device-other", data: { kind: "device" }, emitWithAck: jest.fn() };
  io.in.mockReturnValue({ fetchSockets: async () => [device, second] });
  expect((await request(app).post("/v1/games/lost-ack/map-playback")).status).toBe(503);
  expect(second.emitWithAck).not.toHaveBeenCalled();
});

test("a disconnected device's active job does not return a stale accepted response", async () => {
  const { app, device } = setup();
  const first = await request(app).post("/v1/games/disconnected/map-playback");
  device.id = "reconnected-device";
  const retried = await request(app).post("/v1/games/disconnected/map-playback");
  expect(retried.status).toBe(202);
  expect(retried.body.rebuild.requestId).not.toBe(first.body.rebuild.requestId);
  expect(device.emitWithAck).toHaveBeenCalledTimes(2);
});
