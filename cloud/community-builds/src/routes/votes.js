"use strict";

const { Router } = require("express");
const { validate } = require("../validation/validator");
const { isValidBuildId } = require("../util/ids");
const { hmacAuth } = require("../middleware/auth");
const { writeLimiter } = require("../middleware/rateLimits");

/**
 * @typedef {{
 *   votesService: import('../services/votesService').VotesService,
 *   pepper: Buffer,
 *   clock: () => number,
 * }} VotesRouterDeps
 */

/**
 * Voting + flagging routes.
 *
 * @param {VotesRouterDeps} deps
 * @returns {import('express').Router}
 */
function buildVotesRouter(deps) {
  const router = Router();
  const auth = hmacAuth(deps.pepper);
  const writes = writeLimiter();

  router.post("/:id/vote", auth, writes, asyncHandler(handleVote(deps)));
  router.post("/:id/flag", auth, writes, asyncHandler(handleFlag(deps)));

  return router;
}

/**
 * @param {VotesRouterDeps} deps
 * @returns {(req: import('express').Request, res: import('express').Response) => Promise<unknown>}
 */
function handleVote(deps) {
  return async (req, res) => {
    if (!isValidBuildId(req.params.id)) { res.status(400).json({ error: "bad_id" }); return; }
    const result = validate("vote", req.body);
    if (!result.ok) { res.status(400).json({ error: "validation", details: result.errors }); return; }
    const totals = await deps.votesService.vote({
      buildId: req.params.id,
      clientId: /** @type {string} */ (req.clientId),
      vote: result.value.vote,
      now: deps.clock(),
    });
    res.json(totals);
  };
}

/**
 * @param {VotesRouterDeps} deps
 * @returns {(req: import('express').Request, res: import('express').Response) => Promise<unknown>}
 */
function handleFlag(deps) {
  return async (req, res) => {
    if (!isValidBuildId(req.params.id)) { res.status(400).json({ error: "bad_id" }); return; }
    const body = req.body ?? {};
    const result = validate("flag", body);
    if (!result.ok) { res.status(400).json({ error: "validation", details: result.errors }); return; }
    const totals = await deps.votesService.flag({
      buildId: req.params.id,
      clientId: /** @type {string} */ (req.clientId),
      reason: result.value.reason ?? "",
      now: deps.clock(),
    });
    res.json(totals);
  };
}

/**
 * @param {(req: import('express').Request, res: import('express').Response) => Promise<unknown>} fn
 * @returns {(req: import('express').Request, res: import('express').Response) => Promise<unknown>}
 */
/**
 * @param {(req: import('express').Request, res: import('express').Response) => Promise<unknown>} fn
 * @returns {import('express').RequestHandler}
 */
function asyncHandler(fn) {
  return function asyncWrapped(req, res, next) {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

module.exports = { buildVotesRouter };
