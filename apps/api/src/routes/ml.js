"use strict";

const express = require("express");

/** One-release compatibility response for the retired, unused ML API.
 * @param {{auth: import('express').RequestHandler}} deps
 */
function buildMlRouter({ auth }) {
  const router = express.Router();
  router.use(auth);
  router.use("/ml", (req, res) => {
    if (!req.auth) return res.status(401).json({ error: "auth_required" });
    return res.status(410).json({
      error: {
        code: "ml_retired",
        message: "Model training and prediction have been retired. Replay analysis uses fixed rules and statistics.",
      },
    });
  });
  return router;
}

module.exports = { buildMlRouter };
