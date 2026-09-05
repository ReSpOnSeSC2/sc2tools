"use strict";

const { randomUUID } = require("node:crypto");
const jobs = new Map();
const TTL_MS = 20 * 60 * 1000;
const MAX_JOBS = 1000;
/** @param {string} userId @param {string} gameId */
const key = (userId, gameId) => JSON.stringify([userId, gameId]);

/** @param {string} userId @param {string} gameId */
function getPlaybackJob(userId, gameId) {
  const job = jobs.get(key(userId, gameId));
  if (!job) return null;
  if (Date.now() - job.updatedAt > TTL_MS) {
    jobs.delete(key(userId, gameId));
    return { requestId: job.requestId, status: "failed", code: "rebuild_expired", message: "Replay rebuild timed out. Retry with the desktop agent running." };
  }
  return { ...job };
}

/** @param {string} userId @param {string} gameId */
function startPlaybackJob(userId, gameId) {
  const current = getPlaybackJob(userId, gameId);
  if (current && ["queued", "processing", "uploading"].includes(current.status)) return { job: current, existing: true };
  const now = Date.now();
  for (const [jobKey, job] of jobs) {
    if (now - job.updatedAt > TTL_MS) jobs.delete(jobKey);
  }
  while (jobs.size >= MAX_JOBS) jobs.delete(jobs.keys().next().value);
  const job = { requestId: randomUUID(), status: "queued", updatedAt: now };
  jobs.set(key(userId, gameId), job);
  return { job: { ...job }, existing: false };
}

/** @param {string} userId @param {string} gameId @param {string} requestId @param {string} deviceId */
function bindPlaybackJobDevice(userId, gameId, requestId, deviceId) {
  const job = jobs.get(key(userId, gameId));
  if (!job || job.requestId !== requestId || job.status !== "queued") return false;
  job.deviceId = deviceId;
  return true;
}

/** @param {string} userId @param {string} gameId @param {string} requestId @param {any} update @param {string} [deviceId] */
function updatePlaybackJob(userId, gameId, requestId, update, deviceId) {
  const job = jobs.get(key(userId, gameId));
  if (!job || job.requestId !== requestId || !update ||
      (deviceId !== undefined && job.deviceId !== deviceId) ||
      ["complete", "failed"].includes(job.status) ||
      !["queued", "processing", "uploading", "complete", "failed"].includes(update.status)) return false;
  jobs.set(key(userId, gameId), {
    requestId, deviceId: job.deviceId, status: update.status, updatedAt: Date.now(),
    ...(typeof update.code === "string" ? { code: update.code.slice(0, 80) } : {}),
    ...(typeof update.message === "string" ? { message: update.message.slice(0, 500) } : {}),
  });
  return true;
}

module.exports = { getPlaybackJob, startPlaybackJob, updatePlaybackJob, bindPlaybackJobDevice };
