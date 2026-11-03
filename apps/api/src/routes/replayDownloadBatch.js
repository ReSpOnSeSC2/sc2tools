"use strict";

const { reserveExport } = require("./exportAdmission");
const { parseDownloadBatch } = require("../services/replayDownloadBatchPolicy");

const DEADLINE_MS = 60_000;

/** @param {import('../services/replayFiles').ReplayFilesService|null} store
 * @returns {import('express').RequestHandler}
 */
function downloadBatchHandler(store) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const owner = req.auth?.userId;
    if (typeof owner !== "string" || !owner) { fail(res, 401, "auth_required"); return; }
    let ids;
    try { ids = parseDownloadBatch(req.body); }
    catch { fail(res, 400, "invalid_replay_download_batch"); return; }
    if (!store) { fail(res, 503, "replay_storage_unavailable"); return; }
    if (req.aborted || res.destroyed || res.writableEnded) return;
    const lease = reserveExport(res);
    if (!lease) { fail(res, 503, "export_busy"); return; }
    const controller = new AbortController(), signal = controller.signal;
    const disconnected = () => controller.abort();
    req.once("aborted", disconnected);
    res.once("close", disconnected); res.once("finish", disconnected); res.once("error", disconnected);
    const deadline = setTimeout(disconnected, DEADLINE_MS); deadline.unref?.();
    try {
      if (req.aborted || res.destroyed) controller.abort();
      const result = await store.prepareDownloadBatch(owner, ids, { signal });
      if (signal.aborted) { if (!lease.closed()) fail(res, 503, "replay_download_unavailable"); return; }
      if (!lease.closed()) res.json(result);
    } catch { if (!lease.closed()) fail(res, 503, "replay_download_unavailable"); }
    finally {
      clearTimeout(deadline); controller.abort(); req.off("aborted", disconnected);
      res.off("close", disconnected); res.off("finish", disconnected); res.off("error", disconnected);
      lease.settle();
    }
  };
}

/** @param {import('express').Response} res @param {number} status @param {string} code */
function fail(res, status, code) { res.status(status).json({ error: { code } }); }

/** @param {import('express').Router} router
 * @param {{auth:import('express').RequestHandler,replayFiles:import('../services/replayFiles').ReplayFilesService|null}} deps
 */
function registerDownloadBatch(router, deps) {
  router.post("/replays/download-batch", deps.auth, downloadBatchHandler(deps.replayFiles));
  return router;
}

module.exports = { downloadBatchHandler, registerDownloadBatch, DEADLINE_MS };
