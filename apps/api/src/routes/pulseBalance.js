"use strict";

const express = require("express");

const BALANCE_CACHE_CONTROL = "public, s-maxage=3600, stale-while-revalidate=86400";
const PINNED_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** @param {express.Request["query"]} query */
function parsePin({ season, asOf }) {
  if (season === undefined && asOf === undefined) return null;
  if (typeof season !== "string" || !/^[1-9]\d{0,8}$/.test(season)
    || typeof asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return false;
  const date = new Date(asOf);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== asOf) return false;
  return { season: Number(season), asOf };
}

/** @param {{pulseBalance: Pick<import("../services/pulseBalanceStore").PulseBalanceStore,"latest"|"evidence">}} deps */
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

  router.get("/ladder/balance/evidence", async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    const pin = parsePin(req.query);
    if (pin === false) {
      res.status(400).json({ error: { code: "invalid_balance_snapshot_pin" } });
      return;
    }
    try {
      const evidence = await pulseBalance.evidence(pin);
      if (!evidence) {
        res.status(pin ? 404 : 503).json({ error: { code: "balance_snapshot_unavailable" } });
        return;
      }
      res.set("Cache-Control", pin ? PINNED_CACHE_CONTROL : BALANCE_CACHE_CONTROL).json(evidence);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { buildPulseBalanceRouter };
