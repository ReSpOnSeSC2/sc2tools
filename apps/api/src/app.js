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
const { AggregationsService } = require("./services/aggregations");
const { BuildsService } = require("./services/builds");
const {
  PerGameComputeService,
  MacroBackfillService,
} = require("./services/perGameCompute");
const { ImportService } = require("./services/import");
const { SpatialService } = require("./services/spatial");
const { CatalogService } = require("./services/catalog");
const { MLService } = require("./services/ml");
const { AgentVersionService } = require("./services/agentVersion");
const { GdprService } = require("./services/gdpr");
const { CommunityService } = require("./services/community");

const { buildHealthRouter } = require("./routes/health");
const { buildMeRouter } = require("./routes/me");
const { buildOpponentsRouter } = require("./routes/opponents");
const { buildGamesRouter } = require("./routes/games");
const { buildCustomBuildsRouter } = require("./routes/customBuilds");
const { buildDevicePairingsRouter } = require("./routes/devicePairings");
const { buildOverlayTokensRouter } = require("./routes/overlayTokens");
const { buildAggregationsRouter } = require("./routes/aggregations");
const { buildBuildsRouter } = require("./routes/builds");
const {
  buildPerGameRouter,
  buildMacroBackfillRouter,
} = require("./routes/perGame");
const { buildImportsRouter } = require("./routes/imports");
const { buildSpatialRouter } = require("./routes/spatial");
const { buildCatalogRouter } = require("./routes/catalog");
const { buildMlRouter } = require("./routes/ml");
const { buildAgentVersionRouter } = require("./routes/agentVersion");
const { buildCommunityRouter } = require("./routes/community");

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
  const aggregations = new AggregationsService(deps.db);
  const builds = new BuildsService(deps.db);
  const catalog = new CatalogService(deps.db);
  const perGame = new PerGameComputeService(deps.db, {
    catalog: catalog.catalogLookup(),
  });
  const macroBackfill = new MacroBackfillService(deps.db, { io: deps.io });
  const imports = new ImportService(deps.db, { io: deps.io });
  const spatial = new SpatialService(deps.db);
  const ml = new MLService(deps.db, { io: deps.io });
  const agentVersion = new AgentVersionService(deps.db);
  const gdpr = new GdprService(deps.db);
  const community = new CommunityService(deps.db);
  return {
    users,
    opponents,
    games,
    customBuilds,
    pairings,
    overlayTokens,
    aggregations,
    builds,
    catalog,
    perGame,
    macroBackfill,
    imports,
    spatial,
    ml,
    agentVersion,
    gdpr,
    community,
  };
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

  // Public routers (no `router.use(auth)` — public endpoints OR per-route
  // auth) MUST mount before any auth-using router. Express runs every
  // mounted router in order, and each auth-using router's top-level
  // `router.use(auth)` fires for ANY request entering /v1 — including
  // ones the auth-using router won't even handle. Mounting public routes
  // first short-circuits before those auth-eager middlewares get a turn.
  app.use(SERVICE.ROUTE_PREFIX, buildHealthRouter({ db: deps.db }));
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildAgentVersionRouter({
      agentVersion: services.agentVersion,
      adminToken: deps.config.agentReleaseAdminToken,
    }),
  );
  // devicePairings has unauth /start and /:code (the agent has no token
  // yet) plus auth-required /claim and /devices. Per-route auth inside
  // the router handles both — it just needs to mount with the public
  // routers so the unauth'd endpoints aren't intercepted upstream.
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildDevicePairingsRouter({ pairings: services.pairings, auth }),
  );
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildMeRouter({
      users: services.users,
      games: services.games,
      gdpr: services.gdpr,
      auth,
      logger: deps.logger,
    }),
  );
  // Community is partly public (build directory + author profiles +
  // k-anon opponent profiles) and partly authed (publish, vote,
  // report). Per-route auth inside the router handles both — but the
  // router MUST mount with the public bundle so no later
  // `router.use(auth)` intercepts the unauthed GETs.
  const adminIds = new Set(deps.config.adminUserIds || []);
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildCommunityRouter({
      community: services.community,
      auth,
      isAdmin: (req) => Boolean(req.auth && adminIds.has(req.auth.userId)),
    }),
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
    buildCustomBuildsRouter({
      customBuilds: services.customBuilds,
      perGame: services.perGame,
      auth,
    }),
  );
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildOverlayTokensRouter({
      overlayTokens: services.overlayTokens,
      auth,
      io: deps.io,
    }),
  );
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildAggregationsRouter({ aggregations: services.aggregations, auth }),
  );
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildBuildsRouter({ builds: services.builds, auth }),
  );
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildPerGameRouter({ perGame: services.perGame, auth, io: deps.io }),
  );
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildMacroBackfillRouter({
      macroBackfill: services.macroBackfill,
      auth,
    }),
  );
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildImportsRouter({ imports: services.imports, auth }),
  );
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildSpatialRouter({ spatial: services.spatial, auth }),
  );
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildCatalogRouter({ catalog: services.catalog, auth }),
  );
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildMlRouter({ ml: services.ml, auth }),
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
