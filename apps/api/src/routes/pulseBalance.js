"use strict";

const express = require("express");

const BALANCE_CACHE_CONTROL = "public, s-maxage=3600, stale-while-revalidate=86400";

/** @param {{pulseBalance: Pick<import("../services/pulseBalanceStore").PulseBalanceStore,"latest">}} deps */
function buildPulseBalanceRouter({ pulseBalance }) {
  const router = express.Router();

  router.get("/ladder/balance", async (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    try {
      const bundle = await pulseBalance.latest();
      if (!bundle) {
        res.status(503).json({ error: { code: "balance_snapshot_unavailable" } });
        return;
      }
      res.set("Cache-Control", BALANCE_CACHE_CONTROL).json(bundle);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { buildPulseBalanceRouter };
