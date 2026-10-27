"use strict";

const express = require("express");
const { historyError } = require("../services/sessionHistoryDescriptor");
const { MAX_BYTES } = require("../services/sessionHistoryQuery");

/** @param {{sessionHistory:import('../services/sessionHistory').SessionHistoryService,auth:import('express').RequestHandler}} deps */
function buildSessionsRouter(deps) {
  const router = express.Router();
  /** @param {'list'|'current'|'detail'} mode @returns {import('express').RequestHandler} */
  const handle = (mode) => async (req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    try {
      const owner = req.auth?.userId;
      if (!owner) throw historyError("unauthorized", 401);
      const publish = deps.sessionHistory.capturePublication(owner);
      const value = mode === "list" ? await deps.sessionHistory.list(owner, req.query)
        : mode === "current" ? await deps.sessionHistory.current(owner, req.query)
          : await deps.sessionHistory.detail(owner, req.params.id, req.query);
      if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_BYTES) throw historyError("session_history_response_limit", 422);
      publish();
      res.json(value);
    } catch (error) { next(error); }
  };
  router.get("/sessions", deps.auth, handle("list"));
  router.get("/sessions/current", deps.auth, handle("current"));
  router.get("/sessions/:id", deps.auth, handle("detail"));
  return router;
}
module.exports = { buildSessionsRouter };
