"use strict";
const express = require("express");
const crypto = require("crypto");
/** @param {{announcements: import('../services/announcements').AnnouncementsService}} deps */
function buildAnnouncementsRouter(deps) {
  const router = express.Router();
  router.get("/site/banner", async (req, res, next) => {
    try {
      const payload = { banner: await deps.announcements.active() };
      const etag = `"${crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex")}"`;
      res.set({ "Cache-Control": "public, max-age=60", ETag: etag });
      if (req.get("If-None-Match")?.split(/\s*,\s*/).some((tag) => tag === etag || tag === `W/${etag}` || tag === "*")) { res.status(304).end(); return; }
      res.json(payload);
    } catch (error) { next(error); }
  });
  return router;
}
module.exports = { buildAnnouncementsRouter };
