"use strict";

const express = require("express");
const helmetModule = require("helmet");
const cors = require("cors");
const pinoHttpModule = require("pino-http");
const { LIMITS, SERVICE } = require("./constants");
const { requestId } = require("./middleware/requestId");
const { buildErrorHandler } = require("./middleware/errorHandler");
const { buildHealthRouter } = require("./routes/health");
const { buildHandshakeRouter } = require("./routes/handshake");
const { buildBuildsRouter } = require("./routes/builds");
const { buildVotesRouter } = require("./routes/votes");

const helmet = /** @type {any} */ (helmetModule).default || helmetModule;
const pinoHttp = /** @type {any} */ (pinoHttpModule).default || pinoHttpModule;

const JSON_LIMIT = `${LIMITS.REQUEST_BODY_BYTES}b`;

/**
 * @typedef {{
 *   db: {
 *     builds: import('mongodb').Collection,
 *     votes: import('mongodb').Collection,
 *     flags: import('mongodb').Collection,
 *   },
 *   logger: import('pino').Logger,
 *   pepper: Buffer,
 *   trustProxy?: number,
 *   corsAllowedOrigins?: string[],
 *   clock?: () => number,
 * }} AppDeps
 */

/**
 * Build the Express app. Pure factory — no side effects (no listen, no
 * mongo connection). Tests inject a fake `db`.
 *
 * @param {AppDeps} deps
 * @returns {import('express').Express}
 */
function buildApp(deps) {
  const clock = deps.clock || (() => Date.now());
  const app = express();
  app.set("trust proxy", deps.trustProxy ?? 1);
  app.disable("x-powered-by");
  applyBaseMiddleware(app, deps);
  mountRoutes(app, deps, clock);
  app.use(buildErrorHandler(deps.logger));
  return app;
}

/**
 * @param {import('express').Express} app
 * @param {AppDeps} deps
 */
function applyBaseMiddleware(app, deps) {
  app.use(helmet());
  app.use(cors({ origin: pickCorsOrigin(deps.corsAllowedOrigins), maxAge: 600 }));
  app.use(/** @type {import('express').RequestHandler} */ (
    pinoHttp({ logger: deps.logger, customProps: () => ({ service: SERVICE.NAME }) })
  ));
  app.use(requestId);
  app.use(/** @type {import('express').RequestHandler} */ (
    express.json({ limit: JSON_LIMIT, verify: captureRawBody })
  ));
}

/**
 * @param {import('express').Express} app
 * @param {AppDeps} deps
 * @param {() => number} clock
 */
function mountRoutes(app, deps, clock) {
  const { BuildsService } = require("./services/buildsService");
  const { VotesService } = require("./services/votesService");
  const { SyncService } = require("./services/syncService");

  const buildsService = new BuildsService(deps.db);
  const votesService = new VotesService(deps.db);
  const syncService = new SyncService(deps.db);
  const routerDeps = { buildsService, votesService, syncService, pepper: deps.pepper, clock };

  app.use(SERVICE.ROUTE_PREFIX, buildHealthRouter());
  app.use(SERVICE.ROUTE_PREFIX, buildHandshakeRouter(deps.pepper));
  app.use(SERVICE.ROUTE_PREFIX, buildBuildsRouter(routerDeps));
  app.use(SERVICE.ROUTE_PREFIX, buildVotesRouter(routerDeps));
}

/**
 * @param {string[]|undefined} allowed
 * @returns {true | ((origin: string|undefined, cb: (err: Error|null, allow?: boolean) => void) => void)}
 */
function pickCorsOrigin(allowed) {
  if (!allowed || allowed.length === 0) return true;
  return (origin, callback) => {
    if (!origin || allowed.includes(origin)) { callback(null, true); return; }
    callback(new Error("cors_rejected"));
  };
}

/**
 * @param {import('http').IncomingMessage & { rawBody?: Buffer }} req
 * @param {import('http').ServerResponse} _res
 * @param {Buffer} buf
 */
function captureRawBody(req, _res, buf) {
  if (buf && buf.length > 0) req.rawBody = Buffer.from(buf);
  else req.rawBody = Buffer.alloc(0);
}

module.exports = { buildApp };
