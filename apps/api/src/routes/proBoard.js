"use strict";

const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { ProBoardError } = require("../services/proBoard");

/** The board is read from the server's memory, so visitors are cheap; this only stops a flood. */
const PRO_BOARD_RATE_LIMIT_PER_MIN = 60;
const CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=60";

/**
 * GET /v1/pros-on-ladder: the Grandmasters playing now, and (only while the
 * names gate is open) the known pros among them. PUBLIC and read-only. While
 * the feature's gate is off it answers `{ available: false }`. It answers
 * from the last timer refresh and never reaches SC2Pulse (ADR 0065, ADR 0075).
 *
 * @param {{
 *   proBoard: Pick<import("../services/proBoard").ProBoardService, "view" | "isOpen" | "showNames">,
 *   rateLimitPerMinute?: number,
 * }} deps
 */
function buildProBoardRouter(deps) {
  if (typeof deps?.proBoard?.view !== "function") {
    throw new Error("buildProBoardRouter: proBoard service required");
  }
  const router = express.Router();
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    limit: deps.rateLimitPerMinute || PRO_BOARD_RATE_LIMIT_PER_MIN,
    standardHeaders: true,
    legacyHeaders: false,
  });

  /** Whether the board is open and shows names, for the page to draw the right state at once. */
  router.get("/pros-on-ladder/status", (_req, res) => {
    res.set("Cache-Control", CACHE_CONTROL);
    res.json({ available: deps.proBoard.isOpen(), showNames: deps.proBoard.showNames });
  });

  router.get("/pros-on-ladder", limiter, (_req, res, next) => {
    try {
      const board = deps.proBoard.view();
      res.set("Cache-Control", CACHE_CONTROL);
      res.json(board);
    } catch (err) {
      if (!(err instanceof ProBoardError)) {
        next(err);
        return;
      }
      res.set("Retry-After", "60");
      res.status(503).json({ error: { code: "pros_on_ladder_unavailable", message: "The pros board is not ready right now" } });
    }
  });

  return router;
}

module.exports = { buildProBoardRouter };
