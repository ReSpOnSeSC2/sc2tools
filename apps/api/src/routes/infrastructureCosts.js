"use strict";

const express = require("express");

const SUCCESS_CACHE_CONTROL =
  "public, max-age=300, s-maxage=900, stale-while-revalidate=86400";

/**
 * Public aggregate used by the landing-page infrastructure cost display.
 * The service response is already a strict allowlist and the router never
 * accepts request-controlled selectors.
 *
 * @param {{
 *   infrastructureUsage: import('../services/infrastructureUsage').InfrastructureUsageService,
 * }} deps
 */
function buildInfrastructureCostsRouter(deps) {
  if (!deps || !deps.infrastructureUsage) {
    throw new Error("buildInfrastructureCostsRouter: service required");
  }
  const router = express.Router();

  router.get("/public/infrastructure-costs", async (_req, res, next) => {
    try {
      const snapshot = await deps.infrastructureUsage.snapshot();
      res.set("Cache-Control", SUCCESS_CACHE_CONTROL).json(snapshot);
    } catch (err) {
      if (
        err
        && /** @type {any} */ (err).code
          === "infrastructure_costs_unavailable"
      ) {
        // Missing optional analytics credentials is an expected operational
        // state, not an application crash. Avoid logging/Sentry noise and
        // prevent CDNs from pinning the temporary absence.
        res.set("Cache-Control", "no-store").status(503).json({
          error: { code: "infrastructure_costs_unavailable" },
        });
        return;
      }
      next(err);
    }
  });

  return router;
}

module.exports = {
  buildInfrastructureCostsRouter,
  _internals: { SUCCESS_CACHE_CONTROL },
};
