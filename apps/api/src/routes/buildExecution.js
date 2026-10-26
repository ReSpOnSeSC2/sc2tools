"use strict";
/** Registered only on the authenticated owner games router. No coach, review,
 * public replay or overlay transport receives this private resource.
 * @param {import('express').Router} router
 * @param {{gameExecution?:import('../services/buildExecution').BuildExecutionService}} deps */
function registerBuildExecutionRoute(router, deps) {
  router.get("/games/:gameId/build-execution", async (req, res, next) => {
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.once("close", abort);
    try {
      res.set("Cache-Control", "private, no-store");
      if (!req.auth) throw new Error("auth_required");
      const value = await deps.gameExecution?.get(req.auth.userId, String(req.params.gameId), { signal: controller.signal });
      if (!value) { res.status(404).json({ error: { code: "not_found" } }); return; }
      res.json(value);
    } catch (error) { next(error); }
    finally { res.off("close", abort); }
  });
}
module.exports = { registerBuildExecutionRoute };
