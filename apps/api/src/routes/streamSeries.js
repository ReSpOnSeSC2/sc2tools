"use strict";

/** Reuses the existing bounded control limiter, token ownership and erasure
 * admission. No provider route or independent bearer scheme is introduced.
 * @param {import('express').Router} router
 * @param {{series?:import('../services/streamSeries').StreamSeriesService,
 * limiter:import('express').RequestHandler,tokenAuth:import('express').RequestHandler}} deps */
function registerStreamSeriesRoutes(router, deps) {
  for (const method of /** @type {const} */ (["get", "post"])) {
    router[method]("/multichat/:token/series", (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); }, deps.limiter, deps.tokenAuth, async (req, res, next) => {
      if (!deps.series) { res.status(503).json({ error: { code: "series_unavailable" } }); return; }
      try {
        // @ts-ignore established by the shared tokenAuth middleware
        const owner = String(req.overlayUserId), token = String(req.params.token);
        res.json(method === "get" ? await deps.series.get(token, owner) : await deps.series.act(token, owner, req.body));
      } catch (error) { next(error); }
    });
  }
}
module.exports = { registerStreamSeriesRoutes };
