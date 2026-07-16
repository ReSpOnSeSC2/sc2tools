"use strict";

const express = require("express");
const fs = require("fs");

/**
 * Public /v1/map-image router.
 *
 * Minimap thumbnails ship with the analyzer and contain no per-user
 * data, so this endpoint must be reachable without a bearer token —
 * browsers can't attach `Authorization` to an `<img src>` request.
 *
 * Mounted as a "public router" in app.js, before any router that
 * applies `router.use(auth)`. Express runs every mounted router in
 * order; an auth-using router's top-level middleware fires for ANY
 * request entering /v1, even ones that router won't handle, so a
 * public route inside an auth-using router is still 401'd by some
 * other auth-eager router earlier in the chain. Splitting it out
 * keeps the route truly anonymous.
 *
 * @param {{ catalog: import('../services/types').CatalogService }} deps
 */
function buildMapImageRouter(deps) {
  const router = express.Router();

  router.get("/map-image", (req, res, next) => {
    // The SPA and API are deployed on different origins. Helmet defaults
    // Cross-Origin-Resource-Policy to same-origin, which would make browsers
    // reject these public <img> responses even though CORS allows the request.
    res.setHeader("cross-origin-resource-policy", "cross-origin");
    try {
      const name = String(req.query.map || "").trim();
      if (!name) {
        res.status(400).json({ error: { code: "map_required" } });
        return;
      }
      const found = deps.catalog.mapImagePath(name);
      if (!found) {
        res.status(404).json({ error: { code: "map_image_not_found" } });
        return;
      }
      res.setHeader("content-type", found.contentType);
      res.setHeader(
        "cache-control",
        "public, max-age=604800, stale-while-revalidate=2592000",
      );
      if (found.etag) {
        res.setHeader("etag", found.etag);
        if (req.headers["if-none-match"] === found.etag) {
          res.status(304).end();
          return;
        }
      }
      fs.createReadStream(found.path)
        .on("error", (e) => next(e))
        .pipe(res);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { buildMapImageRouter };
