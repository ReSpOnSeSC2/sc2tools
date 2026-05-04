"use strict";

const express = require("express");
const helmetModule = require("helmet");
const cors = require("cors");
const rateLimitModule = require("express-rate-limit");
const pinoHttpModule = require("pino-http");

const helmet = /** @type {any} */ (helmetModule).default || helmetModule;
const rateLimit =
  /** @type {any} */ (rateLimitModule).default || rateLimitModule;
const pinoHttp = /** @type {any} */ (pinoHttpModule).default || pinoHttpModule;

const { LIMITS, SERVICE } = require("./config/constants");
const { requestId } = require("./middleware/requestId");
const { buildErrorHandler } = require("./middleware/errorHandler");
const { buildAuth } = require("./middleware/auth");

const { UsersService } = require("./services/users");
const { OpponentsService } = require("./services/opponents");
const { GamesService } = require("./services/games");
const { CustomBuildsService } = require("./services/customBuilds");
const { DevicePairingsService } = require("./services/devicePairings");
const { OverlayTokensService } = require("./services/overlayTokens");

const { buildHealthRouter } = require("./routes/health");
const { buildMeRouter } = require("./routes/me");
const { buildOpponentsRouter } = require("./routes/opponents");
const { buildGamesRouter } = require("./routes/games");
const { buildCustomBuildsRouter } = require("./routes/customBuilds");
const { buildDevicePairingsRouter } = require("./routes/devicePairings");
const { buildOverlayTokensRouter } = require("./routes/overlayTokens");

const JSON_LIMIT = `${LIMITS.REQUEST_BODY_BYTES}b`;

/**
 * @typedef {{
 *   db: import('./db/connect').DbContext,
 *   logger: import('pino').Logger,
 *   config: ReturnType<typeof import('./config/loader').loadConfig>,
 *   io?: import('socket.io').Server,
 * }} AppDeps
 */

/**
 * Build the Express app. Pure factory: no listen, no DB connect.
 *
 * @param {AppDeps} deps
 * @returns {{app: import('express').Express, services: object}}
 */
function buildApp(deps) {
  const services = makeServices(deps);
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  applyBaseMiddleware(app, deps);
  mountRoutes(app, deps, services);
  app.use(buildErrorHandler(deps.logger));
  return { app, services };
}

/**
 * @param {AppDeps} deps
 */
function makeServices(deps) {
  const users = new UsersService(deps.db);
  const opponents = new OpponentsService(deps.db, deps.config.serverPepper);
  const games = new GamesService(deps.db);
  const customBuilds = new CustomBuildsService(deps.db);
  const pairings = new DevicePairingsService(deps.db);
  const overlayTokens = new OverlayTokensService(deps.db);
  return { users, opponents, games, customBuilds, pairings, overlayTokens };
}

/**
 * @param {import('express').Express} app
 * @param {AppDeps} deps
 */
function applyBaseMiddleware(app, deps) {
  app.use(helmet());
  app.use(
    cors({
      origin: pickCorsOrigin(deps.config.corsAllowedOrigins),
      maxAge: 600,
      credentials: false,
    }),
  );
  app.use(
    pinoHttp({
      logger: deps.logger,
      customProps: () => ({ service: SERVICE.NAME }),
    }),
  );
  app.use(requestId);
  app.use(express.json({ limit: JSON_LIMIT }));
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      max: deps.config.rateLimitPerMinute,
      standardHeaders: true,
      legacyHeaders: false,
      // Per-IP for unauth, per-user once auth runs (we install this
      // before auth, so per-IP is the practical bound for /start polling
      // — acceptable since pairing codes expire in 10min anyway).
    }),
  );
}

/**
 * @param {import('express').Express} app
 * @param {AppDeps} deps
 * @param {ReturnType<typeof makeServices>} services
 */
function mountRoutes(app, deps, services) {
  const auth = buildAuth({
    secretKey: deps.config.clerkSecretKey,
    issuer: deps.config.clerkJwtIssuer,
    audience: deps.config.clerkJwtAudience,
    getDeviceToken: (hash) => services.pairings.findTokenByHash(hash),
    ensureUser: (clerkUserId) => services.users.ensureFromClerk(clerkUserId),
  });

  app.use(SERVICE.ROUTE_PREFIX, buildHealthRouter({ db: deps.db }));
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildMeRouter({ users: services.users, games: services.games, auth }),
  );
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildOpponentsRouter({ opponents: services.opponents, auth }),
  );
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildGamesRouter({
      games: services.games,
      opponents: services.opponents,
      io: deps.io,
      auth,
    }),
  );
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildCustomBuildsRouter({ customBuilds: services.customBuilds, auth }),
  );
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildDevicePairingsRouter({ pairings: services.pairings, auth }),
  );
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildOverlayTokensRouter({ overlayTokens: services.overlayTokens, auth }),
  );
}

/**
 * @param {string[]|undefined} allowed
 * @returns {true | ((origin: string|undefined, cb: (err: Error|null, allow?: boolean) => void) => void)}
 */
function pickCorsOrigin(allowed) {
  if (!allowed || allowed.length === 0) return true;
  return (origin, callback) => {
    if (!origin || allowed.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error("cors_rejected"));
  };
}

module.exports = { buildApp };
