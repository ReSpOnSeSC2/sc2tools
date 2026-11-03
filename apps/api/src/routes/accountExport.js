"use strict";

const { reserveExport, waitForDrain } = require("./exportAdmission");

/** @param {import('express').Request} req @param {import('express').Response} res
 * @param {import('../services/gdpr').GdprService} gdpr @param {string} userId
 */
async function streamAccount(req, res, gdpr, userId) {
  const controller = new AbortController();
  const disconnected = () => controller.abort();
  req.once("aborted", disconnected);
  res.once("close", disconnected); res.once("finish", disconnected); res.once("error", disconnected);
  try {
    if (req.aborted || res.destroyed) controller.abort();
    const stream = gdpr.exportStream(userId, { details: req.query.details === "1", signal: controller.signal });
    res.setHeader("content-type", "application/x-ndjson; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="sc2tools-account-export-${Date.now()}.ndjson"`);
    for await (const chunk of stream) {
      controller.signal.throwIfAborted();
      if (!res.write(chunk)) await waitForDrain(res, controller.signal);
    }
    controller.signal.throwIfAborted();
    res.end();
  } catch {
    // Once streaming starts, a closed connection and missing complete trailer
    // convey failure. Do not serialize a private DB/storage exception or URL.
    if (!res.destroyed && !controller.signal.aborted) {
      if (res.headersSent) res.destroy();
      else {
        res.removeHeader("content-disposition");
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.status(503).json({ error: { code: "export_unavailable" } });
      }
    }
  } finally {
    controller.abort(); req.off("aborted", disconnected);
    res.off("close", disconnected); res.off("finish", disconnected); res.off("error", disconnected);
  }
}

/** @param {import('../services/gdpr').GdprService} gdpr
 * @returns {import('express').RequestHandler}
 */
function accountExportHandler(gdpr) {
  return async (req, res, next) => {
    // Copy once; neither later req.auth mutation nor awaits can retarget work.
    const userId = req.auth?.userId;
    if (typeof userId !== "string" || !userId) { res.status(401).json({ error: { code: "auth_required" } }); return; }
    res.setHeader("cache-control", "private, no-store");
    const { format, details } = req.query;
    if ((format !== undefined && format !== "json" && format !== "ndjson")
      || (details !== undefined && (format !== "ndjson" || (details !== "0" && details !== "1")))) {
      res.status(400).json({ error: { code: "invalid_export_options" } }); return;
    }
    if (req.aborted || res.destroyed || res.writableEnded) return;
    const lease = reserveExport(res);
    if (!lease) { res.status(503).json({ error: { code: "export_busy" } }); return; }
    try {
      if (format === "ndjson") { await streamAccount(req, res, gdpr, userId); return; }
      const data = await gdpr.export(userId);
      if (lease.closed() || req.aborted) return;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("content-disposition", `attachment; filename="sc2tools-export-${Date.now()}.json"`);
      res.json(data);
    } catch (err) { if (!lease.closed() && !req.aborted) next(err); }
    finally { lease.settle(); }
  };
}

module.exports = { accountExportHandler };
