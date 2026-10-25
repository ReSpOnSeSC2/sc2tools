// @ts-nocheck
"use strict";
const express = require("express");
const request = require("supertest");
const { buildObsSourcesRouter } = require("../src/routes/obsSources");
const DEVICE = "a".repeat(24);
function fixture({ source = "clerk", devices, ack, timeoutMs } = {}) {
  const emit = jest.fn(ack || (async (_event, payload) => ({ ...payload, code: "added", private: "never serialize" })));
  const device = { data: { kind: "device", userId: "owner", deviceId: DEVICE, obsAddSource: { supported: true, enabled: true } }, timeout: jest.fn(() => ({ emitWithAck: emit })) };
  const fetchSockets = jest.fn(async () => devices ?? [device]);
  const io = { in: jest.fn(() => ({ fetchSockets })) };
  const app = express(); app.use(express.json());
  app.use("/v1/devices/obs", buildObsSourcesRouter({ io, timeoutMs, auth: (req, _res, next) => { req.auth = { userId: "owner", source }; next(); } }));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ code: err.code }));
  return { app, io, fetchSockets, device, emit };
}
test("availability is private, owner-scoped and strips all socket/credential fields", async () => {
  const f = fixture(); f.device.data.tokenHash = "secret";
  const res = await request(f.app).get("/v1/devices/obs");
  expect(res.status).toBe(200); expect(res.headers["cache-control"]).toBe("private, no-store");
  expect(res.body.devices).toEqual([{ id: DEVICE, label: `Local agent 1 (${DEVICE.slice(-6)})`, supported: true, enabled: true }]);
  expect(f.io.in).toHaveBeenCalledWith("user:owner"); expect(f.emit).not.toHaveBeenCalled();
});
test("device-auth callers cannot initiate remote OBS writes", async () => {
  const f = fixture({ source: "device" });
  expect((await request(f.app).post("/v1/devices/obs/add-source").send({ widget: "opponent" })).status).toBe(403);
  expect(f.fetchSockets).not.toHaveBeenCalled();
});
test.each([{ widget: "unknown" }, { widget: "opponent", url: "https://arbitrary.invalid" }, { widget: "opponent", token: "secret" }, { widget: "opponent", deviceId: "bad" }, {}, []])("strict command rejects %j before socket reads", async body => {
  const f = fixture(); expect((await request(f.app).post("/v1/devices/obs/add-source").send(body)).status).toBe(400);
  expect(f.fetchSockets).not.toHaveBeenCalled();
});
test("one request reaches one verified selected device and validates the bound ACK", async () => {
  const f = fixture(); const res = await request(f.app).post("/v1/devices/obs/add-source").send({ widget: "opponent" });
  expect(res.status).toBe(200); expect(res.body.code).toBe("added"); expect(Object.keys(res.body).sort()).toEqual(["code", "deviceId", "requestId"]);
  expect(f.emit).toHaveBeenCalledTimes(1); const [event, payload] = f.emit.mock.calls[0];
  expect(event).toBe("obs:add-source"); expect(Object.keys(payload).sort()).toEqual(["deviceId", "expiresAt", "requestId", "widget"]);
  expect(payload.requestId).toMatch(/^[a-f0-9]{32}$/); expect(payload.deviceId).toBe(DEVICE);
  expect(payload.expiresAt - Date.now()).toBeLessThanOrEqual(44000);
});
test("Ghost without an assigned URL fragment is rejected before dispatch; website uses Copy/Drag", async () => {
  const f = fixture(); expect((await request(f.app).post("/v1/devices/obs/add-source").send({ widget: "ghost-build" })).status).toBe(400);
  expect(f.emit).not.toHaveBeenCalled();
});
test.each([[], [{ data: { kind: "device", userId: "another", deviceId: DEVICE } }], [{ data: { kind: "web", userId: "owner", deviceId: DEVICE } }]].map(devices => ({ devices })))("foreign, web and offline sockets cannot receive commands", async ({ devices }) => {
  const f = fixture({ devices }); expect((await request(f.app).post("/v1/devices/obs/add-source").send({ widget: "opponent" })).status).toBe(409);
  expect(f.emit).not.toHaveBeenCalled();
});
test("old/default-off devices remain disabled and multiple eligible devices require selection", async () => {
  const f = fixture(); f.device.data.obsAddSource.enabled = false;
  expect((await request(f.app).post("/v1/devices/obs/add-source").send({ widget: "opponent" })).body.code).toBe("obs_disabled");
  f.device.data.obsAddSource.enabled = true;
  const other = { ...f.device, data: { ...f.device.data, deviceId: "b".repeat(24) } };
  f.fetchSockets.mockResolvedValue([f.device, other]);
  expect((await request(f.app).post("/v1/devices/obs/add-source").send({ widget: "opponent" })).body.code).toBe("choose_device");
  expect(f.emit).not.toHaveBeenCalled();
  expect((await request(f.app).post("/v1/devices/obs/add-source").send({ widget: "opponent", deviceId: other.data.deviceId })).status).toBe(200);
  expect(f.emit).toHaveBeenCalledTimes(1);
});
test.each(["requestId", "deviceId", "code"])("rejects an unbound or unsupported ACK %s without retry", async key => {
  const f = fixture({ ack: async (_event, payload) => ({ ...payload, code: "added", [key]: "wrong" }) });
  expect((await request(f.app).post("/v1/devices/obs/add-source").send({ widget: "opponent" })).body.code).toBe("invalid_obs_ack");
  expect(f.emit).toHaveBeenCalledTimes(1);
});
test("admission rejects concurrent owner requests before discovery and releases after real deadline", async () => {
  const f = fixture({ timeoutMs: 60, ack: () => new Promise(() => {}) });
  const first = request(f.app).post("/v1/devices/obs/add-source").send({ widget: "opponent" }).then(res => res);
  for (let count = 0; !f.emit.mock.calls.length && count < 100; count++) await new Promise(resolve => setTimeout(resolve, 1));
  expect(f.emit).toHaveBeenCalledTimes(1);
  const second = await request(f.app).post("/v1/devices/obs/add-source").send({ widget: "opponent" });
  expect(second.status).toBe(409); expect(f.fetchSockets).toHaveBeenCalledTimes(1);
  expect((await first).body.code).toBe("obs_ack_unknown");
  f.emit.mockImplementation(async (_event, payload) => ({ ...payload, code: "declined" }));
  expect((await request(f.app).post("/v1/devices/obs/add-source").send({ widget: "opponent" })).body.code).toBe("declined");
});
