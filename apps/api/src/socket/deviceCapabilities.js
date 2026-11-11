"use strict";
const DEVICE_ID = /^[a-f0-9]{24}$/;

/** Call only after authoritative device-token authentication. The handshake
 * can advertise protocol support, never choose its owner or stable identity.
 * Legacy token resolvers may omit a stable ID; their ordinary device socket
 * still works, but cannot advertise the bound retry protocol.
 * @param {any} socket @param {{userId:string,deviceId?:string}} hit */
function initializeDeviceSocket(socket, hit) {
  const deviceId = typeof hit.deviceId === "string" && DEVICE_ID.test(hit.deviceId) ? hit.deviceId : undefined;
  socket.data.userId = hit.userId;
  socket.data.kind = "device";
  // Preserve authenticated legacy metadata; only canonical IDs enable retry.
  socket.data.deviceId = hit.deviceId;
  socket.data.syncRetryVersion = deviceId && socket.handshake.auth.syncRetryVersion === 1 ? 1 : 0;
  // Managed re-analysis batches are bound to a stable device identity too.
  socket.data.reanalysisVersion = deviceId && socket.handshake.auth.reanalysisVersion === 1 ? 1 : 0;
  socket.data.obsAddSource = {
    supported: socket.handshake.auth.obsAddSource?.supported === true,
    enabled: socket.handshake.auth.obsAddSource?.enabled === true,
  };
}

/** @typedef {{deviceReady(data: Record<string, any>): unknown, recordOutcome(data: Record<string, any>, payload: unknown): unknown}} DeviceReanalysisHooks */

/** This advisory binding belongs only to the current namespace session.
 * It contains no credential and is never broadcast to the owner room.
 * Re-analysis hooks get only the authenticated socket data; the service
 * checks ownership, job and batch itself.
 * @param {any} socket @param {DeviceReanalysisHooks} [reanalysis] */
function announceDeviceReady(socket, reanalysis) {
  socket.emit("device:hello", { ok: true });
  if (socket.data.syncRetryVersion === 1) socket.emit("sync:retry-ready", {
    version: 1, deviceId: socket.data.deviceId, sessionId: socket.id,
  });
  if (!reanalysis) return;
  socket.on("reanalyze:outcome", (/** @type {unknown} */ payload) => {
    Promise.resolve().then(() => reanalysis.recordOutcome(socket.data, payload)).catch(() => {});
  });
  Promise.resolve().then(() => reanalysis.deviceReady(socket.data)).catch(() => {});
}

module.exports = { initializeDeviceSocket, announceDeviceReady };
