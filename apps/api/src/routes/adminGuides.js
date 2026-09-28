"use strict";

const express = require("express");
const { resolveBuild } = require("../config/guideSlugs");
const { validateGuideAdminInput } = require("../validation/guideAdmin");

const HTTP_CREATED = 201;
const HTTP_ACCEPTED = 202;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_MIN = 400;
const HTTP_MAX = 599;
/** Marker for "the recompute is still running" in the start race. */
const PENDING = Symbol("pending");

/**
 * @typedef {import('../jobs/guideStatsRecomputeJob').GuideStatsJobSummary} GuideStatsJobSummary
 */

/**
 * @typedef {object} AdminGuidesDeps
 * @property {import('../services/guideNotes').GuideNotesService} guideNotes
 * @property {Pick<import('../services/guides').GuidesService, "sampleCount">} guides
 * @property {Pick<import('../services/guideStats').GuideStatsService, "readRun">} guideStats
 * @property {{ runOnce: (opts?: { force?: boolean }) => Promise<GuideStatsJobSummary>, isRunning: () => boolean }} guideStatsJob
 * @property {Pick<import('../jobs/guideSamplesBackfillJob').GuideSamplesBackfillJob, "start"|"stop"|"status">|null} [guideSamplesBackfill]
 * @property {Pick<import('../services/guideVideos').GuideVideosService,
 *   "listForAdmin"|"addVideo"|"setHidden"|"syncFromChannel">} guideVideos
 * @property {() => number} [now]
 */

/**
 * @typedef {object} RecomputeState
 * @property {string|null} requestedAt ISO time of the last "Recompute now"
 * @property {{ ran: boolean, reason: string|null, finishedAt: string }|null} last
 *   outcome of the last admin-triggered run (reason codes only)
 */

/**
 * /v1/admin/guides/* — the admin side of SC2 Tools Guides. Mounted by
 * routes/admin.js under its auth + ``admin_only`` gate, so every route
 * here is admin-only; all responses are ``private, no-store``.
 *
 *   GET    /notes                        every coach's note
 *   PUT    /notes/:matchup/:build        save (merge) { body?, videos?: { pinned?, hidden? } }
 *   DELETE /notes/:matchup/:build        204
 *   GET    /status                       last run, backfill progress, sample count
 *   POST   /recompute                    202; guide_stats rebuild in the background
 *   GET    /backfill                     backfill progress (counts only)
 *   POST   /backfill                     { action: "start"|"stop", days? } → 202 status
 *   GET    /videos                       channel videos + detected matches
 *   POST   /videos                       { youtubeId } → 201 (oEmbed-checked)
 *   PATCH  /videos/:youtubeId            { hidden } → 200
 *   POST   /videos/sync                  pull the channel feed now
 *
 * Responses never carry a note's ``updatedBy`` or any user identifier.
 *
 * @param {AdminGuidesDeps} deps
 */
function buildAdminGuidesRouter(deps) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    next();
  });
  mountNoteRoutes(router, deps);
  mountRunRoutes(router, deps);
  mountVideoRoutes(router, deps);
  return router;
}

/**
 * @param {import('express').Router} router
 * @param {AdminGuidesDeps} deps
 */
function mountNoteRoutes(router, deps) {
  router.get("/notes", handle(async (_req, res) => {
    res.json({ items: await deps.guideNotes.list() });
  }));
  router.put("/notes/:matchup/:build", handle(async (req, res) => {
    const build = resolveCanonicalBuild(req.params.matchup, req.params.build);
    if (!build) return notFound(res);
    const editor = req.auth && typeof req.auth.userId === "string" ? req.auth.userId : null;
    res.json({ note: await deps.guideNotes.save(build.matchup, build.name, req.body, editor) });
  }));
  router.delete("/notes/:matchup/:build", handle(async (req, res) => {
    const build = resolveCanonicalBuild(req.params.matchup, req.params.build);
    if (!build) return notFound(res);
    await deps.guideNotes.remove(build.matchup, build.name);
    res.status(HTTP_NO_CONTENT).end();
  }));
}

/**
 * Status, recompute and backfill.
 *
 * @param {import('express').Router} router
 * @param {AdminGuidesDeps} deps
 */
function mountRunRoutes(router, deps) {
  const now = deps.now || Date.now;
  /** @type {RecomputeState} */
  const recompute = { requestedAt: null, last: null };
  router.get("/status", handle(async (_req, res) => {
    const [run, count] = await Promise.all([deps.guideStats.readRun(), deps.guides.sampleCount()]);
    res.json({
      run,
      backfill: deps.guideSamplesBackfill ? deps.guideSamplesBackfill.status() : null,
      samples: { count },
      recompute: { running: deps.guideStatsJob.isRunning(), ...recompute },
    });
  }));
  router.post("/recompute", handle(async (_req, res) => {
    const pending = deps.guideStatsJob.runOnce({ force: true });
    const early = await settledNow(pending);
    if (early !== PENDING && early.reason === "disabled") {
      res.status(HTTP_CONFLICT).json({ error: { code: "guide_stats_disabled" } });
      return;
    }
    recompute.requestedAt = new Date(now()).toISOString();
    void pending.then((summary) => {
      recompute.last = { ran: summary.ran, reason: summary.reason || null, finishedAt: new Date(now()).toISOString() };
    }, () => undefined);
    res.status(HTTP_ACCEPTED).json({ started: true });
  }));
  router.get("/backfill", handle(async (_req, res) => {
    res.json(deps.guideSamplesBackfill ? deps.guideSamplesBackfill.status() : null);
  }));
  router.post("/backfill", handle(async (req, res) => {
    const checked = validateGuideAdminInput("backfill", req.body);
    if (!checked.valid) return badRequest(res, "invalid_backfill", checked.errors);
    const job = deps.guideSamplesBackfill;
    if (!job || (checked.value.action === "start" && job.status().disabled)) {
      res.status(HTTP_CONFLICT).json({ error: { code: "backfill_disabled" } });
      return;
    }
    const status = checked.value.action === "start" ? job.start({ days: checked.value.days }) : await job.stop();
    res.status(HTTP_ACCEPTED).json(status);
  }));
}

/**
 * @param {import('express').Router} router
 * @param {AdminGuidesDeps} deps
 */
function mountVideoRoutes(router, deps) {
  router.get("/videos", handle(async (_req, res) => {
    res.json({ items: await deps.guideVideos.listForAdmin() });
  }));
  router.post("/videos/sync", handle(async (_req, res) => {
    res.json(await deps.guideVideos.syncFromChannel());
  }));
  router.post("/videos", handle(async (req, res) => {
    const checked = validateGuideAdminInput("videoAdd", req.body);
    if (!checked.valid) return badRequest(res, "invalid_video_id", checked.errors);
    res.status(HTTP_CREATED).json({ item: await deps.guideVideos.addVideo(checked.value.youtubeId) });
  }));
  router.patch("/videos/:youtubeId", handle(async (req, res) => {
    const checked = validateGuideAdminInput("videoPatch", req.body);
    if (!checked.valid) return badRequest(res, "invalid_video_patch", checked.errors);
    const item = await deps.guideVideos.setHidden(req.params.youtubeId, checked.value.hidden);
    if (!item) return notFound(res);
    res.json({ item });
  }));
}

/**
 * The live build of a URL (one alias hop followed), or null.
 *
 * @param {string} matchupSlugValue
 * @param {string} slug
 * @returns {{ matchup: string, name: string, slug: string }|null}
 */
function resolveCanonicalBuild(matchupSlugValue, slug) {
  const resolved = resolveBuild(matchupSlugValue, slug);
  if (!resolved) return null;
  if (!("redirect" in resolved)) return resolved;
  const next = resolveBuild(resolved.redirect.matchupSlug, resolved.redirect.slug);
  return next && !("redirect" in next) ? next : null;
}

/**
 * The promise's value if it settles within the current turn (before any
 * I/O callback), else PENDING. A disabled job answers synchronously.
 *
 * @param {Promise<GuideStatsJobSummary>} promise
 * @returns {Promise<GuideStatsJobSummary|typeof PENDING>}
 */
function settledNow(promise) {
  /** @type {Promise<typeof PENDING>} */
  const later = new Promise((resolve) => setImmediate(() => resolve(PENDING)));
  return Promise.race([promise, later]);
}

/** @param {import('express').Response} res */
function notFound(res) {
  res.status(HTTP_NOT_FOUND).json({ error: { code: "not_found" } });
}

/**
 * @param {import('express').Response} res
 * @param {string} code
 * @param {string[]} errors
 */
function badRequest(res, code, errors) {
  res.status(HTTP_BAD_REQUEST).json({ error: { code, message: errors.join("; ") } });
}

/**
 * Async handler wrapper. Coded service errors (status + code: note
 * validation, video lookups — 400/422/502/503) become
 * `{ error: { code } }`; anything else goes to the app error handler.
 *
 * @param {(req: import('express').Request, res: import('express').Response) => Promise<void>} fn
 * @returns {import('express').RequestHandler}
 */
function handle(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      const e = /** @type {any} */ (err);
      const coded = e && typeof e.code === "string" && typeof e.status === "number"
        && e.status >= HTTP_MIN && e.status <= HTTP_MAX;
      if (!coded) return next(err);
      /** @type {Record<string, string>} */
      const body = { code: e.code };
      if (e.status === HTTP_BAD_REQUEST && typeof e.message === "string") body.message = e.message;
      res.status(e.status).json({ error: body });
    }
  };
}

module.exports = { buildAdminGuidesRouter };
