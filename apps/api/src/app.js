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
const { buildClerkClient, noopClerkClient } = require("./services/clerkClient");
const { OpponentsService } = require("./services/opponents");
const { GamesService } = require("./services/games");
const { GameDetailsService } = require("./services/gameDetails");
const { buildStoreFromConfig } = require("./services/gameDetailsStore");
const { CustomBuildsService } = require("./services/customBuilds");
const { DevicePairingsService } = require("./services/devicePairings");
const { OverlayTokensService } = require("./services/overlayTokens");
const { OverlayLiveService } = require("./services/overlayLive");
const { LiveGameBroker } = require("./services/liveGameBroker");
const { AggregationsService } = require("./services/aggregations");
const { StreakService } = require("./services/streak");
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
const { SeasonsService } = require("./services/seasons");
const { PulseMmrService } = require("./services/pulseMmr");
const { AdminService } = require("./services/admin");
const { buildPulseResolver } = require("./services/pulseResolver");
const { loadAllMigrations } = require("./db/migrations");

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
const { buildMapImageRouter } = require("./routes/mapImage");
const { buildMlRouter } = require("./routes/ml");
const { buildAgentVersionRouter } = require("./routes/agentVersion");
const { buildCommunityRouter } = require("./routes/community");
const { buildPublicReplayRouter } = require("./routes/publicReplay");
const { buildSeasonsRouter } = require("./routes/seasons");
const { buildClerkWebhookRouter } = require("./routes/clerkWebhook");
const { buildAdminRouter } = require("./routes/admin");
const {
  buildAgentLiveRouter,
  buildMeLiveRouter,
} = require("./routes/agentLive");

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
  // Register schema migrations BEFORE any service touches Mongo so
  // a v1 opponents doc loaded during boot already knows how to roll
  // forward. ``loadAllMigrations`` is idempotent — repeated boots
  // (or test harnesses calling buildApp many times in one process)
  // skip duplicate registrations.
  loadAllMigrations();
  const services = makeServices(deps);
  const clerk = deps.config.clerkSecretKey
    ? buildClerkClient({
        secretKey: deps.config.clerkSecretKey,
        logger: deps.logger,
      })
    : noopClerkClient();
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  applyBaseMiddleware(app, deps);
  mountRoutes(app, deps, services, clerk);
  app.use(buildErrorHandler(deps.logger));
  return { app, services };
}

/**
 * @param {AppDeps} deps
 */
function makeServices(deps) {
  const users = new UsersService(deps.db);
  // Pluggable backend for the per-game heavy blob. Defaults to
  // ``MongoDetailsStore`` (in-database); flips to ``R2DetailsStore``
  // when ``GAME_DETAILS_STORE=r2`` is set with the R2 connection
  // block populated. See ``services/gameDetailsStore.js`` for the
  // selection logic. Built first because both ``opponents`` and
  // ``perGame`` consume it for the post-cutover read paths.
  const gameDetailsStore = buildStoreFromConfig({
    db: deps.db,
    config: {
      gameDetailsStore: deps.config.gameDetailsStore,
      r2: deps.config.r2,
    },
  });
  const gameDetails = new GameDetailsService(gameDetailsStore);
  // Cloud-side SC2Pulse resolver — drives the backfill cron's
  // recovery path for opponents whose pulseCharacterId never landed
  // on first ingest (typically because sc2pulse.nephest.com was
  // unreachable / rate-limited at that moment). Built once and
  // shared so the in-process LRU cache survives across requests.
  const pulseResolver = buildPulseResolver({ logger: deps.logger });
  const opponents = new OpponentsService(
    deps.db,
    deps.config.serverPepper,
    { gameDetails, logger: deps.logger, pulseResolver },
  );
  // PulseMmrService — Tier-3 fallback for the session widget when no
  // game in the user's history carries a usable myMmr. Constructed
  // once and shared so the in-process cache survives across requests.
  const pulseMmr = new PulseMmrService();
  // GamesService persists heavy fields through GameDetailsService,
  // not directly to a collection — the indirection is what makes
  // the R2 swap a config change instead of a code change. It also
  // borrows UsersService so ``todaySession`` can stamp the streamer's
  // region onto the overlay's session widget, and PulseMmrService for
  // the SC2Pulse MMR fallback when no game carries `myMmr`. The pino
  // logger comes through too so todaySession can emit one structured
  // line per resolution attempt — without it, an operator can't tell
  // which of the five fallback tiers is failing for a streamer who
  // sees ``— MMR`` on the overlay.
  const games = new GamesService(deps.db, {
    gameDetails,
    users,
    pulseMmr,
    logger: deps.logger,
  });
  const pairings = new DevicePairingsService(deps.db);
  const overlayTokens = new OverlayTokensService(deps.db);
  // OverlayLiveService has no per-user state; constructed once and
  // shared across requests. It pulls from the same ``games`` /
  // ``opponents`` collections every other read service touches.
  const overlayLive = new OverlayLiveService(deps.db);
  // LiveGameBroker — in-process pub/sub for the agent → web SSE
  // bridge AND the agent → OBS overlay Socket.io fan-out.
  // Constructed once at app boot so every agent POST shares the
  // subscriber set with the user's web tabs. The broker also fans
  // each envelope out to every ``overlay:<token>`` room belonging to
  // the publishing user as ``overlay:liveGame`` — that's how the
  // hosted Browser Source widgets (OverlayWidgetClient) see pre-game
  // state without the agent having a Socket.io client of its own.
  //
  // The ``enrich`` hook lets the cloud add ``streamerHistory`` (H2H
  // / RIVAL tag / recent games / best-answer) to the envelope before
  // fan-out — see ``OverlayLiveService.enrichEnvelope`` for the
  // per-(user, opponent) cache and the rest of the rationale.
  // Without enrichment the scouting widget pre-game can only show
  // the opponent's identity + Pulse MMR; with it, the pre-game card
  // matches the post-game one.
  const liveGameBroker = new LiveGameBroker({
    io: deps.io,
    overlayTokens,
    logger: deps.logger,
    enrich: (userId, envelope) =>
      overlayLive.enrichEnvelope(userId, envelope),
  });
  const aggregations = new AggregationsService(deps.db);
  const streak = new StreakService(deps.db);
  const builds = new BuildsService(deps.db);
  const catalog = new CatalogService(deps.db);
  // Eager-load the JSON catalog so the first build-order /
  // macro-breakdown request after a cold start gets a populated
  // ``isBuilding`` flag. Without this, the lookup hits the lazy load
  // path and returns null for every name on the first request — every
  // building then misclassifies as a unit and the Buildings roster
  // reads empty. Failure is non-fatal: ``parseBuildLogLines`` falls
  // through to the local KNOWN_BUILDING_NAMES set.
  Promise.resolve(catalog.catalog()).catch(() => {});
  const perGame = new PerGameComputeService(deps.db, {
    catalog: catalog.catalogLookup(),
    gameDetails,
  });
  const customBuilds = new CustomBuildsService(deps.db, { perGame });
  const macroBackfill = new MacroBackfillService(deps.db, { io: deps.io });
  const imports = new ImportService(deps.db, { io: deps.io });
  const spatial = new SpatialService(deps.db);
  const ml = new MLService(deps.db, { io: deps.io, gameDetails });
  const agentVersion = new AgentVersionService(deps.db);
  const gdpr = new GdprService(deps.db, {
    opponents,
    logger: deps.logger,
  });
  const community = new CommunityService(deps.db);
  const seasons = new SeasonsService();
  // AdminService composes db + gdpr; deliberately near the bottom so
  // its dependencies are already constructed.
  const admin = new AdminService({ db: deps.db, gdpr });
  return {
    users,
    opponents,
    games,
    gameDetails,
    customBuilds,
    pairings,
    overlayTokens,
    overlayLive,
    liveGameBroker,
    aggregations,
    streak,
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
    seasons,
    admin,
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
  // Stash the raw bytes alongside the parsed body so the Clerk webhook
  // route can verify the Svix HMAC against the exact payload Clerk
  // signed (re-stringifying req.body would canonicalize whitespace and
  // break the signature). Cheap — Buffer ref, not a copy.
  app.use(
    express.json({
      limit: JSON_LIMIT,
      verify: (req, _res, buf) => {
        /** @type {any} */ (req).rawBody = buf;
      },
    }),
  );
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
 * @param {import('./services/clerkClient').ClerkClient} clerk
 */
function mountRoutes(app, deps, services, clerk) {
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
  app.use(SERVICE.ROUTE_PREFIX, buildSeasonsRouter({ seasons: services.seasons }));
  // Public marketing-page replay preview. Unauth'd by design — the
  // landing page demo accepts a single .SC2Replay upload and returns
  // a parsed dossier. Rate-limited per IP inside the router.
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildPublicReplayRouter({ logger: deps.logger }),
  );
  // Map minimaps (used by <img src> in the SPA). MUST sit with the
  // public routers — bearer tokens can't be attached to image
  // requests. See routes/mapImage.js for details.
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildMapImageRouter({ catalog: services.catalog }),
  );
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
  // SC2TOOLS_ADMIN_USER_IDS is a CSV of *Clerk* user IDs (the
  // `user_xxx` strings from the Clerk dashboard), so the gate compares
  // against `req.auth.clerkUserId`. Device-auth requests don't carry
  // a Clerk ID and therefore can never be admins, which is what we
  // want — moderation is a web-only surface.
  const adminIds = new Set(deps.config.adminUserIds || []);
  /** @param {import('express').Request} req */
  const isAdmin = (req) =>
    Boolean(req.auth && req.auth.clerkUserId && adminIds.has(req.auth.clerkUserId));
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildMeRouter({
      users: services.users,
      games: services.games,
      gdpr: services.gdpr,
      pairings: services.pairings,
      clerk,
      auth,
      isAdmin,
      logger: deps.logger,
    }),
  );
  // Clerk webhook receiver. Mounted with the public bundle because
  // it carries no Authorization header — its identity comes from the
  // Svix signature verified inside the router.
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildClerkWebhookRouter({
      users: services.users,
      secret: deps.config.clerkWebhookSecret,
      logger: deps.logger,
    }),
  );
  // Community is partly public (build directory + author profiles +
  // k-anon opponent profiles) and partly authed (publish, vote,
  // report). Per-route auth inside the router handles both — but the
  // router MUST mount with the public bundle so no later
  // `router.use(auth)` intercepts the unauthed GETs.
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildCommunityRouter({
      community: services.community,
      auth,
      isAdmin,
    }),
  );
  // Operational admin router — gated on isAdmin(req) inside the
  // router. Mounted alongside the rest of the v1 prefix so
  // /v1/admin/* shares CORS, rate-limit, and JSON parsing config.
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildAdminRouter({
      admin: services.admin,
      gdpr: services.gdpr,
      auth,
      isAdmin,
      gameDetailsStoreKind: deps.config.gameDetailsStore,
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
      users: services.users,
      customBuilds: services.customBuilds,
      overlayLive: services.overlayLive,
      overlayTokens: services.overlayTokens,
      liveGameBroker: services.liveGameBroker,
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
      overlayLive: services.overlayLive,
      auth,
      io: deps.io,
    }),
  );
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildAggregationsRouter({
      aggregations: services.aggregations,
      streak: services.streak,
      auth,
    }),
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
  // Live Game Bridge — agent POST + per-user SSE.
  // Mounted late so the public/auth-flexible routers above keep
  // their precedence; both endpoints here use the standard auth
  // middleware (device tokens for the agent push, Clerk session
  // for the web subscriber).
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildAgentLiveRouter({
      broker: services.liveGameBroker,
      auth,
      logger: deps.logger,
    }),
  );
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildMeLiveRouter({
      broker: services.liveGameBroker,
      auth,
      logger: deps.logger,
    }),
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
