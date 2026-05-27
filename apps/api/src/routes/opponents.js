"use strict";

const express = require("express");
const { parseFilters } = require("../util/parseQuery");

/**
 * /v1/opponents — list and detail.
 *
 * @param {{
 *   opponents: import('../services/types').OpponentsService,
 *   auth: import('express').RequestHandler,
 * }} deps
 */
function buildOpponentsRouter(deps) {
  const router = express.Router();
  router.use(deps.auth);

  router.get("/opponents", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const limit = parseLimit(req.query.limit);
      const before = parseDate(req.query.before);
      const filters = parseFilters(req.query);
      const result = await deps.opponents.list(auth.userId, {
        limit,
        before,
        filters,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Identity / MMR diagnostics for one of the caller's OWN opponents —
  // "why is the Pulse ID or MMR missing?". Read-only, no SC2Pulse
  // traffic. Scoped to ``auth.userId`` so a user only ever sees their
  // own opponent rows (the admin variant under /admin can target any
  // user). Mounted before ``/:pulseId`` would also match — Express
  // routes the more specific ``/:pulseId/diagnostics`` first because it
  // has more path segments.
  router.get("/opponents/:pulseId/diagnostics", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const result = await deps.opponents.diagnoseIdentity(
        auth.userId,
        String(req.params.pulseId),
      );
      if (!result) {
        res.status(404).json({ error: { code: "not_found" } });
        return;
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Force a fresh SC2Pulse resolve + MMR refetch for one of the
  // caller's own opponents, bypassing the throttle windows.
  router.post("/opponents/:pulseId/retry-pulse", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const result = await deps.opponents.retryPulseResolution(
        auth.userId,
        String(req.params.pulseId),
      );
      if (!result) {
        res.status(404).json({ error: { code: "not_found" } });
        return;
      }
      res.status(202).json(result);
    } catch (err) {
      next(err);
    }
  });

  // Per-race SC2Pulse 1v1 MMR breakdown for one of the caller's own
  // opponents (live SC2Pulse fetch, cached). Powers the opponent
  // deep-dive's per-race table + the Top-MMR / race-you-faced-most
  // headline toggle.
  router.get("/opponents/:pulseId/pulse-races", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const result = await deps.opponents.getPulseRaceBreakdown(
        auth.userId,
        String(req.params.pulseId),
      );
      if (!result) {
        res.status(404).json({ error: { code: "not_found" } });
        return;
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get("/opponents/:pulseId", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      // Date-range filter applies to every panel except "Likely
      // strategies next" and "Last 5 games", which always reflect the
      // most recent activity for the opponent regardless of the picker.
      const filters = parseFilters(req.query);
      const opp = await deps.opponents.get(
        auth.userId,
        String(req.params.pulseId),
        { since: filters.since, until: filters.until },
      );
      if (!opp) {
        res.status(404).json({ error: { code: "not_found" } });
        return;
      }
      res.json(opp);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** @param {unknown} raw @returns {number|undefined} */
function parseLimit(raw) {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** @param {unknown} raw @returns {Date|undefined} */
function parseDate(raw) {
  if (!raw || typeof raw !== "string") return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

module.exports = { buildOpponentsRouter };
