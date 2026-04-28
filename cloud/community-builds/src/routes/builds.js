"use strict";

const { Router } = require("express");
const { validate } = require("../validation/validator");
const { isValidBuildId } = require("../util/ids");
const { hmacAuth } = require("../middleware/auth");
const { writeLimiter, readLimiter } = require("../middleware/rateLimits");

/**
 * @typedef {{
 *   buildsService: import('../services/buildsService').BuildsService,
 *   syncService: import('../services/syncService').SyncService,
 *   votesService: import('../services/votesService').VotesService,
 *   pepper: Buffer,
 *   clock: () => number,
 * }} BuildsRouterDeps
 */

/**
 * CRUD routes for community builds. Mounted at /v1/community-builds.
 *
 * @param {BuildsRouterDeps} deps
 * @returns {import('express').Router}
 */
function buildBuildsRouter(deps) {
  const router = Router();
  const auth = hmacAuth(deps.pepper);
  const writes = writeLimiter();
  const reads = readLimiter();

  router.get("/", reads, asyncHandler(handleList(deps)));
  router.get("/sync", reads, asyncHandler(handleSync(deps)));
  router.get("/:id", reads, asyncHandler(handleGet(deps)));
  router.post("/", auth, writes, asyncHandler(handleCreate(deps)));
  router.put("/:id", auth, writes, asyncHandler(handleReplace(deps)));
  router.delete("/:id", auth, writes, asyncHandler(handleDelete(deps)));

  return router;
}

/** @param {BuildsRouterDeps} deps @returns {(req: import('express').Request, res: import('express').Response) => Promise<unknown>} */
function handleList(deps) {
  return async (req, res) => {
    const result = await deps.buildsService.list(req.query);
    res.json(result);
  };
}

/** @param {BuildsRouterDeps} deps @returns {(req: import('express').Request, res: import('express').Response) => Promise<unknown>} */
function handleSync(deps) {
  return async (req, res) => {
    const result = await deps.syncService.diff(req.query, deps.clock());
    res.json(result);
  };
}

/** @param {BuildsRouterDeps} deps @returns {(req: import('express').Request, res: import('express').Response) => Promise<unknown>} */
function handleGet(deps) {
  return async (req, res) => {
    if (!isValidBuildId(req.params.id)) { res.status(400).json({ error: "bad_id" }); return; }
    const doc = await deps.buildsService.getById(req.params.id);
    if (!doc) { res.status(404).json({ error: "not_found" }); return; }
    res.json(doc);
  };
}

/** @param {BuildsRouterDeps} deps @returns {(req: import('express').Request, res: import('express').Response) => Promise<unknown>} */
function handleCreate(deps) {
  return async (req, res) => {
    const result = validate("build", req.body);
    if (!result.ok) { res.status(400).json({ error: "validation", details: result.errors }); return; }
    const created = await deps.buildsService.create(result.value, {
      clientId: /** @type {string} */ (req.clientId),
      now: deps.clock(),
    });
    res.status(201).json(created);
  };
}

/** @param {BuildsRouterDeps} deps @returns {(req: import('express').Request, res: import('express').Response) => Promise<unknown>} */
function handleReplace(deps) {
  return async (req, res) => {
    if (!isValidBuildId(req.params.id)) { res.status(400).json({ error: "bad_id" }); return; }
    const result = validate("build", req.body);
    if (!result.ok) { res.status(400).json({ error: "validation", details: result.errors }); return; }
    const updated = await deps.buildsService.replace(req.params.id, result.value, {
      clientId: /** @type {string} */ (req.clientId),
      now: deps.clock(),
    });
    res.json(updated);
  };
}

/** @param {BuildsRouterDeps} deps @returns {(req: import('express').Request, res: import('express').Response) => Promise<unknown>} */
function handleDelete(deps) {
  return async (req, res) => {
    if (!isValidBuildId(req.params.id)) { res.status(400).json({ error: "bad_id" }); return; }
    await deps.buildsService.softDelete(req.params.id, {
      clientId: /** @type {string} */ (req.clientId),
      now: deps.clock(),
    });
    res.status(204).send();
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

module.exports = { buildBuildsRouter };
