"use strict";

const express = require("express");
const { reserveExport, waitForDrain } = require("./exportAdmission");
const { BuildOrderExportError } = require("../services/buildOrderExportPolicy");

const EXACT_SUPPLY_ACCEPT = "application/x-ndjson; profile=exact-supply";

/** @param {import('../services/buildOrderExport').BuildOrderExportService} service @param {'csv'|'ndjson'} format
 * @returns {import('express').RequestHandler} */
function buildOrderExportHandler(service, format) {
  return async (req, res) => {
    const owner = req.auth?.userId;
    res.setHeader("cache-control", "private, no-store");
    if (typeof owner !== "string" || !owner) { res.status(401).json({ error: { code: "auth_required" } }); return; }
    if (format === "ndjson") res.vary("Accept");
    let request;
    try { request = service.request(owner, req.query, format, req.headers?.accept === EXACT_SUPPLY_ACCEPT); }
    catch (error) { sendFailure(res, error); return; }
    if (req.aborted || res.destroyed || res.writableEnded) return;
    const lease = reserveExport(res);
    if (!lease) { res.status(503).json({ error: { code: "export_busy" } }); return; }
    const controller = new AbortController();
    const disconnected = () => controller.abort();
    req.once("aborted", disconnected);
    res.once("close", disconnected); res.once("finish", disconnected); res.once("error", disconnected);
    try {
      if (req.aborted || lease.closed()) controller.abort();
      controller.signal.throwIfAborted();
      const prepared = await service.prepare(request, controller.signal);
      controller.signal.throwIfAborted();
      res.setHeader("content-type", format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8");
      res.setHeader("content-disposition", `attachment; filename="sc2tools-build-orders-${Date.now()}.${format}"`);
      res.setHeader("x-export-has-more", String(prepared.hasMore));
      if (prepared.continuation) res.setHeader("x-export-continuation-token", prepared.continuation);
      for await (const chunk of prepared.stream) {
        controller.signal.throwIfAborted();
        if (!res.write(chunk)) await waitForDrain(res, controller.signal);
      }
      controller.signal.throwIfAborted();
      res.end();
    } catch (error) {
      if (!lease.closed() && !controller.signal.aborted) {
        if (res.headersSent) res.destroy();
        else sendFailure(res, error);
      }
    } finally {
      controller.abort(); req.off("aborted", disconnected);
      res.off("close", disconnected); res.off("finish", disconnected); res.off("error", disconnected);
      lease.settle();
    }
  };
}

/** @param {import('express').Response} res @param {unknown} error */
function sendFailure(res, error) {
  const status = error instanceof BuildOrderExportError ? error.status : 503;
  const code = error instanceof BuildOrderExportError ? error.code : "export_unavailable";
  res.removeHeader("content-disposition"); res.removeHeader("x-export-continuation-token"); res.removeHeader("x-export-has-more");
  if (status === 429) res.setHeader("retry-after", "3600");
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.status(status).json({ error: { code } });
}

/** @param {{buildOrderExport:import('../services/buildOrderExport').BuildOrderExportService,auth:import('express').RequestHandler}} deps */
function buildBuildOrderExportRouter(deps) {
  const router = express.Router();
  router.get("/export/build-orders.csv", deps.auth, buildOrderExportHandler(deps.buildOrderExport, "csv"));
  router.get("/export/build-orders.ndjson", deps.auth, buildOrderExportHandler(deps.buildOrderExport, "ndjson"));
  return router;
}

module.exports = { buildBuildOrderExportRouter, buildOrderExportHandler };
