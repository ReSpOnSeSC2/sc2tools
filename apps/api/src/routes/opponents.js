"use strict";

const express = require("express");
const { LIMITS } = require("../config/constants");
const { parseFilters } = require("../util/parseQuery");

/**
 * /v1/opponents — list and detail.
 *
 * @param {{
 *   opponents: import('../services/types').OpponentsService,
 *   auth: import('express').RequestHandler,
 *   pulseIntel?: import('../services/pulseOpponentIntel').PulseOpponentIntelService,
 *   resolvePulseCharacterId?: (userId: string, pulseId: string) => Promise<string|null|undefined>,
 *   pulseLinks?: import('../services/pulseCharacterLinks').PulseCharacterLinkService,
 *   listPulseCharacterIds?: (userId: string) => Promise<string[]>,
 *   overlayLive?: import('../services/overlayLive').OverlayLiveService,
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

  // SC2Pulse ladder context for the dossier's "Ladder context" card:
  // league/tier + percentile, season record, peak MMR, 90-day rating
  // history, pro identity + linked accounts. One cached upstream call
  // per opponent (PulseOpponentIntelService). ``intel: null`` (200)
  // means the opponent's character id hasn't resolved yet — the card
  // renders nothing; 404 is reserved for "not your opponent".
  router.get("/opponents/:pulseId/pulse-intel", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      if (!deps.pulseIntel || !deps.resolvePulseCharacterId) {
        res.json({ intel: null });
        return;
      }
      const characterId = await deps.resolvePulseCharacterId(
        auth.userId,
        String(req.params.pulseId),
      );
      if (characterId === undefined) {
        res.status(404).json({ error: { code: "not_found" } });
        return;
      }
      const intel = characterId
        ? await deps.pulseIntel.getIntel(characterId)
        : null;
      res.json({ intel });
    } catch (err) {
      next(err);
    }
  });

  // SC2Pulse "same player" linkage for ALL of the caller's resolved
  // opponents in one call: character id → {accountId, proId,
  // proNickname}. The Opponents tab uses it to merge rows that
  // SC2Pulse says are the same human (same Battle.net account, or the
  // same community-verified player across accounts) into one grouped
  // row. Served from the shared linkage cache with a bounded upstream
  // budget per call; ``partial: true`` means some ids are still
  // unresolved and a later call will fill them. Registered before
  // ``/:pulseId`` so the literal segment wins the match.
  router.get("/opponents/pulse-links", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      if (!deps.pulseLinks || !deps.listPulseCharacterIds) {
        res.json({ links: {}, partial: false });
        return;
      }
      const ids = await deps.listPulseCharacterIds(auth.userId);
      const { links, partial } = await deps.pulseLinks.getLinks(ids);
      res.json({ links: Object.fromEntries(links), partial });
    } catch (err) {
      next(err);
    }
  });

  // Complete, metadata-only replay history for one opponent. Kept separate
  // from the analytics profile below: that response intentionally caps and
  // hydrates games for aggregate computation, while this feed pages every
  // matching row without touching the detail store.
  router.get("/opponents/:pulseId/games", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const result = await deps.opponents.listGames(
        auth.userId,
        String(req.params.pulseId),
        {
          filters: parseFilters(req.query),
          mergeLinked: req.query.mergeLinked === "1",
          limit: parseLimit(req.query.limit),
          cursor: parseCursor(req.query.cursor),
        },
      );
      if (!result) {
        res.status(404).json({ error: { code: "not_found" } });
        return;
      }
      res.set("Cache-Control", "private, no-store").json(result);
    } catch (err) {
      next(err);
    }
  });

  router.put("/opponents/:pulseId/notes", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const errors = validateNotesBody(req.body);
      if (errors.length > 0) {
        res.status(400).json({ error: { code: "bad_request", details: errors } });
        return;
      }
      const result = await deps.opponents.updateNotes(
        auth.userId,
        String(req.params.pulseId),
        req.body,
      );
      if (!result) {
        res.status(404).json({ error: { code: "not_found" } });
        return;
      }

      if (
        deps.overlayLive
        && typeof deps.overlayLive.invalidateEnrichmentForOpponent === "function"
      ) {
        try {
          deps.overlayLive.invalidateEnrichmentForOpponent(
            auth.userId,
            result.opponentName,
            result.pulseCharacterId,
          );
        } catch (err) {
          if (req.log && typeof req.log.warn === "function") {
            req.log.warn(
              { err, userId: auth.userId, pulseId: req.params.pulseId },
              "overlay_enrichment_invalidate_failed",
            );
          }
        }
      }

      res.set("Cache-Control", "private, no-store").json({
        notes: result.notes,
        notesReadAloud: result.notesReadAloud,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/opponents/:pulseId", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      // Apply the same analyzer scope that produced the opponents list to
      // the profile behind it. Date bounds remain special for the
      // recency-oriented panels, but game classification (ladder/custom
      // and 1v1/team) must never expand again after drill-in.
      // ``mergeLinked=1`` folds every identity SC2Pulse links to the
      // same player into this one profile (the deep dive behind the
      // Opponents tab's grouped rows).
      const filters = parseFilters(req.query);
      const opp = await deps.opponents.get(
        auth.userId,
        String(req.params.pulseId),
        {
          filters,
          mergeLinked: req.query.mergeLinked === "1",
        },
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

/** @param {unknown} raw @returns {string[]} */
function validateNotesBody(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return ["body must be an object"];
  }
  const body = /** @type {Record<string, unknown>} */ (raw);
  const errors = [];
  if (typeof body.notes !== "string") {
    errors.push("notes must be a string");
  } else if (body.notes.length > LIMITS.OPPONENT_NOTES_MAX_LENGTH) {
    errors.push(
      `notes must contain at most ${LIMITS.OPPONENT_NOTES_MAX_LENGTH} characters`,
    );
  }
  if (typeof body.notesReadAloud !== "boolean") {
    errors.push("notesReadAloud must be a boolean");
  }
  return errors;
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

/** @param {unknown} raw @returns {string|undefined} */
function parseCursor(raw) {
  if (raw === undefined) return undefined;
  if (typeof raw === "string") return raw;
  const err = /** @type {Error & {status: number, code: string}} */ (
    new Error("cursor must be a string")
  );
  err.status = 400;
  err.code = "bad_request";
  throw err;
}

module.exports = { buildOpponentsRouter };
