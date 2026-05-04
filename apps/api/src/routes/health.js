"use strict";

const express = require("express");

/**
 * Health endpoints. /v1/health is unauth and pings Mongo so Render's
 * healthCheck doesn't accept a server with a dead DB connection.
 *
 * @param {{db: {client: import('mongodb').MongoClient}}} deps
 * @returns {import('express').Router}
 */
function buildHealthRouter(deps) {
  const router = express.Router();
  router.get("/health", async (_req, res, next) => {
    try {
      await deps.db.client.db().admin().ping();
      res.json({ status: "ok", time: new Date().toISOString() });
    } catch (err) {
      next(err);
    }
  });
  return router;
}

module.exports = { buildHealthRouter };
