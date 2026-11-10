"use strict";

const express = require("express");

/** @param {unknown} body @returns {Record<string, unknown>|null} */
function objectBody(body) {
  return body && typeof body === "object" && !Array.isArray(body) ? /** @type {Record<string, unknown>} */ (body) : null;
}

/**
 * Owner-only private game notes and the review queue toggle. Every response
 * is ``private, no-store``; nothing here is reachable from a share, public
 * replay or Review Exchange route (those use their own allowlists).
 *
 *   GET    /v1/games/:gameId/notes          → { items, limit }
 *   POST   /v1/games/:gameId/notes          → note
 *   PATCH  /v1/games/:gameId/notes/:noteId  → note
 *   DELETE /v1/games/:gameId/notes/:noteId  → the deleted note (for Undo)
 *   PUT    /v1/games/:gameId/review         → { review }
 *   GET    /v1/review-queue/tags            → { tags }
 *
 * Build check-in notes are a separate dataset (routes/buildIntents.js) and
 * are never read or written here.
 *
 * @param {{
 *   auth: import('express').RequestHandler,
 *   notes: import('../services/notes').NotesService,
 * }} deps
 */
function buildGameNotesRouter(deps) {
  const router = express.Router();
  const { notes } = deps;
  /**
   * One owner-scoped handler: no-store, a 404 for a missing game or note, a
   * 400 for a non-object body where one is required, errors to the handler.
   * @param {(userId: string, req: import('express').Request, body: Record<string, unknown>) => Promise<unknown>} run
   * @param {{body?: boolean, status?: number}} [opts]
   * @returns {import('express').RequestHandler}
   */
  const handle = (run, opts = {}) => async (req, res, next) => {
    try {
      res.set("Cache-Control", "private, no-store");
      if (!req.auth) throw new Error("auth_required");
      const body = objectBody(req.body);
      if (opts.body && !body) { res.status(400).json({ error: { code: "bad_request", message: "body must be an object" } }); return; }
      const result = await run(req.auth.userId, req, body || {});
      if (result === null || result === undefined) { res.status(404).json({ error: { code: "not_found" } }); return; }
      res.status(opts.status || 200).json(result);
    } catch (err) { next(err); }
  };
  const game = (/** @type {import('express').Request} */ req) => String(req.params.gameId);
  const note = (/** @type {import('express').Request} */ req) => String(req.params.noteId);

  router.get("/review-queue/tags", deps.auth, handle(async (userId) => ({ tags: await notes.reviewTags(userId) })));
  router.get("/games/:gameId/notes", deps.auth, handle((userId, req) => notes.listGameNotes(userId, game(req))));
  router.post("/games/:gameId/notes", deps.auth, handle((userId, req, body) => notes.createGameNote(userId, game(req), body), { body: true, status: 201 }));
  router.patch("/games/:gameId/notes/:noteId", deps.auth, handle((userId, req, body) => notes.updateGameNote(userId, game(req), note(req), body), { body: true }));
  router.delete("/games/:gameId/notes/:noteId", deps.auth, handle((userId, req) => notes.deleteGameNote(userId, game(req), note(req))));
  router.put("/games/:gameId/review", deps.auth, handle((userId, req) => notes.setReview(userId, game(req), req.body)));
  return router;
}

module.exports = { buildGameNotesRouter };
