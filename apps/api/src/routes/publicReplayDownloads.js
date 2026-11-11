"use strict";

const { createHmac, randomBytes, timingSafeEqual } = require("node:crypto");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { LIMITS, SERVICE } = require("../config/constants");
const { isPublicReplayReference } = require("../util/publicReplayReference");

const FILENAME = "sc2tools-replay.SC2Replay";
const TICKET_TTL_SEC = 60;
const STREAM_TIMEOUT_MS = 15_000;
const CONCURRENT_PUBLIC_STREAMS = 8;
const DOWNLOAD_PATH = "/public/replays/:handle/:gameId";

/** @param {Buffer|string} key @param {string} handle @param {string} reference @param {number} expires */
function signature(key, handle, reference, expires) {
  return createHmac("sha256", key).update(JSON.stringify(["public-replay-download-v1", handle, reference, expires])).digest();
}

/** @param {Buffer|string} key @param {string} handle @param {string} reference @param {unknown} raw */
function verifyTicket(key, handle, reference, raw) {
  if (!isPublicReplayReference(reference) || typeof raw !== "string") return false;
  const ticket = /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(raw);
  if (!ticket) return false;
  const expires = Number(ticket[1]);
  const now = Date.now();
  if (expires <= now || expires > now + TICKET_TTL_SEC * 1000) return false;
  return timingSafeEqual(signature(key, handle, reference, expires), Buffer.from(ticket[2], "base64url"));
}

/** @param {import('express').Response} res */
function privateHeaders(res) {
  res.set("Cache-Control", "no-store, max-age=0");
  res.set("X-Robots-Tag", "noindex, nofollow");
}

/** @param {import('express').Response} res */
function notFound(res) {
  res.status(404).json({ error: { code: "replay_unavailable", message: "This replay is unavailable or private." } });
}

/** @param {import('express').Response} res */
function storageUnavailable(res) {
  res.status(503).json({ error: { code: "replay_storage_unavailable", message: "Replay storage is temporarily unavailable." } });
}

/** @param {import('express').Response} res @param {unknown} error */
function downloadFailure(res, error) {
  if (error && typeof error === "object" && "status" in error && error.status === 404) return notFound(res);
  return storageUnavailable(res);
}

/** @typedef {{handle: string, reference: string, userId: string, gameId: string}} DownloadTarget */

/** @param {import('express').Router} router
 * @param {{read: (handle: string, replay: string) => Promise<DownloadTarget|null>,
 * files?: import('../services/replayFiles').ReplayFilesService|null,
 * limiter: import('express').RequestHandler, secret?: Buffer|string}} deps
 */
function mountPublicReplayDownloads(router, deps) {
  const key = deps.secret ?? randomBytes(32);
  let streams = 0;

  router.get(DOWNLOAD_PATH + "/download", deps.limiter, async (req, res) => {
    privateHeaders(res);
    try {
      const target = await deps.read(String(req.params.handle), String(req.params.gameId));
      if (!target) return notFound(res);
      if (!deps.files) return storageUnavailable(res);
      // Validate that the original is ready before handing the browser a ticket.
      // The storage URL has the private R2 key and never leaves this process.
      const prepared = await deps.files.prepareDownload(target.userId, target.gameId, { filename: FILENAME });
      const expiresIn = Math.min(TICKET_TTL_SEC, prepared.expiresIn);
      const expires = Date.now() + expiresIn * 1000;
      const token = expires + "." + signature(key, target.handle, target.reference, expires).toString("base64url");
      const url = SERVICE.ROUTE_PREFIX + "/public/replays/" + encodeURIComponent(target.handle) + "/" + target.reference + "/file?token=" + token;
      res.json({ url, filename: FILENAME, expiresIn });
    } catch (error) { downloadFailure(res, error); }
  });

  router.get(DOWNLOAD_PATH + "/file", deps.limiter, async (req, res) => {
    privateHeaders(res);
    const handle = String(req.params.handle);
    const reference = String(req.params.gameId);
    if (!verifyTicket(key, handle, reference, req.query.token)) return notFound(res);
    if (!deps.files || streams >= CONCURRENT_PUBLIC_STREAMS) return storageUnavailable(res);
    streams += 1;
    try {
      const target = await deps.read(handle, reference);
      if (!target || target.reference !== reference) return notFound(res);
      const prepared = await deps.files.prepareDownload(target.userId, target.gameId, { filename: FILENAME });
      await streamOriginal(prepared.url, res);
    } catch (error) {
      if (res.headersSent) res.destroy();
      else if (!res.destroyed) downloadFailure(res, error);
    } finally {
      streams -= 1;
    }
  });
}

/** @param {string} source @param {import('express').Response} res
 * @param {() => Promise<boolean>} [authorize] */
async function streamOriginal(source, res, authorize) {
  if (res.destroyed) return;
  const cancel = new AbortController();
  const stop = () => cancel.abort();
  res.once("close", stop);
  const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(STREAM_TIMEOUT_MS)]);
  try {
    const upstream = await fetch(source, { signal, redirect: "error" });
    const bytes = Number(upstream.headers.get("content-length"));
    if (!upstream.ok || !upstream.body || !Number.isSafeInteger(bytes) || bytes < 4 || bytes > LIMITS.REPLAY_FILE_MAX_BYTES) {
      await upstream.body?.cancel().catch(() => {});
      return storageUnavailable(res);
    }
    if (authorize && !await authorize()) {
      await upstream.body.cancel().catch(() => {});
      return notFound(res);
    }
    signal.throwIfAborted();
    res.set({ "Content-Type": "application/octet-stream", "Content-Length": String(bytes),
      "Content-Disposition": 'attachment; filename="' + FILENAME + '"', "X-Content-Type-Options": "nosniff" });
    const body = /** @type {import('node:stream/web').ReadableStream} */ (/** @type {unknown} */ (upstream.body));
    await pipeline(Readable.fromWeb(body), res, { signal });
  } catch {
    if (res.headersSent) res.destroy();
    else if (!res.destroyed) storageUnavailable(res);
  } finally {
    res.off("close", stop);
    cancel.abort();
  }
}

module.exports = { mountPublicReplayDownloads, streamOriginal };
