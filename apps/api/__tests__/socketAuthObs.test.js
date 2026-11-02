// @ts-nocheck
"use strict";
jest.mock("@clerk/backend", () => ({ verifyToken: jest.fn(async () => ({ sub: "web" })) }));
const { attachSocketAuth } = require("../src/socket/auth");
function fixture(auth, identity = { userId: "owner", deviceId: "a".repeat(24) }) {
  let middleware, connection;
  const io = { use: fn => { middleware = fn; }, on: (_event, fn) => { connection = fn; } };
  attachSocketAuth(io, { secretKey: "synthetic", resolveDeviceToken: async () => identity });
  const handlers = {}, socket = { id: "socket-namespace-id", handshake: { auth }, data: {}, join: jest.fn(), emit: jest.fn(), on: (event, fn) => { handlers[event] = fn; } };
  return { handlers, socket, connect: async () => { await new Promise((resolve, reject) => middleware(socket, err => err ? reject(err) : resolve())); connection(socket); } };
}
test("only authenticated device capability values are strict booleans and hot updates remain on that socket", async () => {
  const f = fixture({ deviceToken: "synthetic-device", obsAddSource: { supported: true, enabled: "true", userId: "other" } });
  await f.connect(); expect(f.socket.data.obsAddSource).toEqual({ supported: true, enabled: false });
  f.handlers["obs:capabilities"]({ supported: true, enabled: true, userId: "other" });
  expect(f.socket.data.obsAddSource).toEqual({ supported: true, enabled: true }); expect(f.socket.data.userId).toBe("owner");
});
test("a web socket cannot advertise website-write consent", async () => {
  const f = fixture({ token: "synthetic-web", obsAddSource: { supported: true, enabled: true } }); await f.connect();
  expect(f.socket.data.obsAddSource).toBeUndefined(); expect(f.handlers["obs:capabilities"]).toBeUndefined();
});

test.each([1, 0, "1", true, undefined])("retry protocol capability is strict and device-authenticated (%j)", async value => {
  const f = fixture({ deviceToken: "synthetic-device", syncRetryVersion: value }); await f.connect();
  expect(f.socket.data.syncRetryVersion).toBe(value === 1 ? 1 : 0);
  if (value === 1) expect(f.socket.emit).toHaveBeenCalledWith("sync:retry-ready", { version: 1, deviceId: "a".repeat(24), sessionId: "socket-namespace-id" });
  else expect(f.socket.emit).not.toHaveBeenCalledWith("sync:retry-ready", expect.anything());
  const web = fixture({ token: "synthetic-web", syncRetryVersion: 1 }); await web.connect();
  expect(web.socket.data.syncRetryVersion).toBeUndefined();
  expect(web.socket.emit).not.toHaveBeenCalledWith("sync:retry-ready", expect.anything());
});

test.each([undefined, "bad", "A".repeat(24)])("legacy/malformed stable device ID %j keeps ordinary auth but cannot advertise retry", async deviceId => {
  const f = fixture({ deviceToken: "synthetic-device", syncRetryVersion: 1 }, { userId: "owner", deviceId });
  await f.connect();
  expect(f.socket.data).toMatchObject({ userId: "owner", kind: "device", syncRetryVersion: 0 });
  expect(f.socket.data.deviceId).toBeUndefined();
  expect(f.socket.join).toHaveBeenCalledWith("user:owner");
  expect(f.socket.emit).toHaveBeenCalledWith("device:hello", { ok: true });
  expect(f.socket.emit).not.toHaveBeenCalledWith("sync:retry-ready", expect.anything());
});
