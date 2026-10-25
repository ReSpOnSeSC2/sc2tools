// @ts-nocheck
"use strict";
const { attachSocketAuth } = require("../src/socket/auth");
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function connection(resolveSeries) {
  let middleware, connect;
  const io = { use: fn => { middleware = fn; }, on: (event, fn) => { if (event === "connection") connect = fn; } };
  attachSocketAuth(io, { secretKey: "sk_test", resolveOverlayToken: async () => ({ userId: "owner" }), resolveSeries });
  const handlers = {}, emitted = [];
  const socket = { handshake: { auth: { overlayToken: "good" } }, data: {}, connected: true,
    join: () => {}, on: (event, fn) => { handlers[event] = fn; }, emit: (event, payload) => emitted.push({ event, payload }), disconnect: () => { socket.connected = false; } };
  await new Promise((resolve, reject) => middleware(socket, error => error ? reject(error) : resolve()));
  connect(socket); await flush();
  return { socket, emitted, handlers };
}
test("Series bootstraps absent state and resyncs through the same owner-scoped resolver", async () => {
  const resolve = jest.fn(async () => null), { handlers, emitted } = await connection(resolve);
  expect(resolve).toHaveBeenCalledWith("good", "owner"); expect(emitted).toContainEqual({ event: "overlay:series", payload: null });
  resolve.mockResolvedValue({ revision: 2, status: "active" });
  await handlers["overlay:resync"](); await flush();
  expect(emitted).toContainEqual({ event: "overlay:series", payload: { revision: 2, status: "active" } });
});
test.each(["disconnected", "changed-owner", "changed-token"])("a held Series bootstrap cannot emit after %s", async boundary => {
  const held = deferred(), { socket, emitted } = await connection(() => held.promise);
  if (boundary === "disconnected") socket.connected = false;
  if (boundary === "changed-owner") socket.data.overlayUserId = "other";
  if (boundary === "changed-token") socket.data.overlayToken = "other";
  held.resolve({ revision: 1 }); await flush();
  expect(emitted.filter(row => row.event === "overlay:series")).toEqual([]);
});
