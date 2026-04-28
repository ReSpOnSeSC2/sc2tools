"use strict";

const { Router } = require("express");
const { SERVICE } = require("../constants");

/**
 * Health endpoint: cheap liveness probe. Does not touch the database.
 *
 * @returns {import('express').Router}
 */
function buildHealthRouter() {
  const router = Router();
  router.get("/health", (_req, res) => {
    res.json({ ok: true, service: SERVICE.NAME, version: SERVICE.VERSION });
  });
  return router;
}

module.exports = { buildHealthRouter };
