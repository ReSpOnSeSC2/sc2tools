"use strict";

const { CLIP_PAGE_MAX, MANUAL_MOMENT_NOTE_MAX } = require("../services/multichatEngagement");

/** @param {import('express').Router} router
 * @param {{engagement?: import('../services/multichatEngagement').MultichatEngagementService,
 *   limiter: import('express').RequestHandler, tokenAuth: import('express').RequestHandler}} deps */
function registerDockClipRoutes(router, { engagement, limiter, tokenAuth }) {
  router.post("/multichat/:token/moment", limiter, tokenAuth, async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!engagement) { res.status(503).json({ error: { code: "clip_moments_unavailable" } }); return; }
      const raw = req.body?.note ?? "";
      if (typeof raw !== "string" || /[\r\n\u2028\u2029]/u.test(raw)) {
        res.status(400).json({ error: { code: "invalid_moment_note", message: "The note must be one line of text." } });
        return;
      }
      const note = raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
      if (Array.from(note).length > MANUAL_MOMENT_NOTE_MAX) {
        res.status(400).json({ error: { code: "invalid_moment_note", message: `Keep the note to ${MANUAL_MOMENT_NOTE_MAX} characters.` } });
        return;
      }
      const result = await engagement.flagMoment(String(req.params.token), note);
      if (!result.ok) {
        res.set("Retry-After", String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
        res.status(429).json({ error: { code: "too_soon", message: "Too soon" } });
        return;
      }
      res.status(201).json({ moment: result.moment });
    } catch (error) { next(error); }
  });

  router.get("/multichat/:token/moments", limiter, tokenAuth, async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!engagement) { res.json({ moments: [], hasMore: false }); return; }
      const before = req.query.before === undefined ? null : Number(req.query.before);
      const beforeId = req.query.beforeId ?? null;
      const limit = req.query.limit === undefined ? CLIP_PAGE_MAX : Number(req.query.limit);
      if ((before !== null && (!Number.isSafeInteger(before) || before <= 0)) || !Number.isSafeInteger(limit) || limit < 1 || limit > CLIP_PAGE_MAX
          || (beforeId !== null && (before === null || typeof beforeId !== "string" || !/^[a-f0-9]{24}$/i.test(beforeId)))) {
        res.status(400).json({ error: { code: "invalid_moment_page" } });
        return;
      }
      res.json(await engagement.listMoments(String(req.params.token), { before, beforeId, limit }));
    } catch (error) { next(error); }
  });

  router.get("/multichat/:token/engagement", limiter, tokenAuth, async (req, res, next) => {
    try {
      if (!engagement) { res.json({ wall: [], oracles: [], prediction: null, clipMoments: [] }); return; }
      res.json(await engagement.summary(String(req.params.token)));
    } catch (error) { next(error); }
  });
}

module.exports = { registerDockClipRoutes };
