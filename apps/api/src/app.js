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
const { GameVodsService } = require("./services/gameVods");
const { PulseMatchVodsService } = require("./services/pulseMatchVods");
const { GameVodLinksService } = require("./services/gameVodLinks");
const { GameDetailsService } = require("./services/gameDetails");
const { buildStoreFromConfig } = require("./services/gameDetailsStore");
const { buildReplayFilesFromConfig } = require("./services/replayFiles");
const { CustomBuildsService } = require("./services/customBuilds");
const { DevicePairingsService } = require("./services/devicePairings");
const { OverlayTokensService } = require("./services/overlayTokens");
const { TikTokChatRelay } = require("./services/tiktokChatRelay");
const { MultichatStudioService } = require("./services/multichatStudio");
const { MultichatSoundsService } = require("./services/multichatSounds");
const { MultichatEngagementService } = require("./services/multichatEngagement");
const { MultichatViewersService } = require("./services/multichatViewers");
const { TickerFactsService } = require("./services/tickerFacts");
const { TwitchChatBotService } = require("./services/twitchChatBot");
const { buildChatBotSettingsRouter } = require("./routes/chatBotSettings");
const { buildMultichatRouter } = require("./routes/multichat");
const { OverlayLiveService } = require("./services/overlayLive");
const { LiveGameBroker } = require("./services/liveGameBroker");
const { AggregationsService } = require("./services/aggregations");
const { MacroReportService } = require("./services/macroReport");
const { StreakService } = require("./services/streak");
const { BuildsService } = require("./services/builds");
const { StrategyPhasesService } = require("./services/strategyPhases");
const { BuildsMmrStatsService } = require("./services/buildsMmrStats");
const {
  PerGameComputeService,
  MacroBackfillService,
} = require("./services/perGameCompute");
const { ImportService } = require("./services/import");
const { SpatialService } = require("./services/spatial");
const { CatalogService } = require("./services/catalog");
const { MLService } = require("./services/ml");
const { AgentVersionService } = require("./services/agentVersion");
const { GithubReleaseFeed } = require("./services/agentGithubReleases");
const { GdprService } = require("./services/gdpr");
const { CommunityService } = require("./services/community");
const { SeasonsService } = require("./services/seasons");
const { ArcadeService } = require("./services/arcade");
const { PulseMmrService } = require("./services/pulseMmr");
const {
  PulseOpponentIntelService,
} = require("./services/pulseOpponentIntel");
const {
  PulseCharacterLinkService,
} = require("./services/pulseCharacterLinks");
const {
  LeaguePercentilesService,
} = require("./services/leaguePercentiles");
const { buildBenchmarksRouter } = require("./routes/benchmarks");
const { LadderMetaService } = require("./services/ladderMeta");
const { buildLadderMetaRouter } = require("./routes/ladderMeta");
const { PublicProfileService } = require("./services/publicProfile");
const { buildPublicProfileRouter } = require("./routes/publicProfile");
const { ChatbotService } = require("./services/chatbot");
const { buildChatbotRouter } = require("./routes/chatbot");
const {
  SkillFingerprintService,
} = require("./services/skillFingerprint");
const { buildFingerprintRouter } = require("./routes/fingerprint");
const { AdminService } = require("./services/admin");
const { AdminGlobalService } = require("./services/adminGlobal");
const { AdminEventsService } = require("./services/adminEvents");
const { AnalyticsService } = require("./services/analytics");
const { buildPulseResolver } = require("./services/pulseResolver");
const { PulseDirectoryService } = require("./services/pulseDirectory");
const { loadAllMigrations } = require("./db/migrations");

const { buildHealthRouter } = require("./routes/health");
const { buildMetricsRouter } = require("./routes/metrics");
const { buildMeRouter } = require("./routes/me");
const { buildOpponentsRouter } = require("./routes/opponents");
const { buildGamesRouter } = require("./routes/games");
const { buildReplayFilesRouter } = require("./routes/replayFiles");
const { buildCustomBuildsRouter } = require("./routes/customBuilds");
const { buildDevicePairingsRouter } = require("./routes/devicePairings");
const { buildOverlayTokensRouter } = require("./routes/overlayTokens");
const { buildAggregationsRouter } = require("./routes/aggregations");
const { buildBuildsRouter } = require("./routes/builds");
const { buildBuildsMmrStatsRouter } = require("./routes/buildsMmrStats");
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
const { buildMessagesRouter } = require("./routes/messages");
const { buildArcadeRouter } = require("./routes/arcade");
const {
  buildAgentLiveRouter,
  buildMeLiveRouter,
} = require("./routes/agentLive");

const JSON_LIMIT = `${LIMITS.REQUEST_BODY_BYTES}b`;

/**
 * ``maxUserMessagesPerWindow`` is a test-injected override for the
 * messages route's rate window (see __tests__/userMessages.test.js);
 * loadConfig never produces it, so production always uses the route's
 * built-in default. ``pulseMmr`` / ``pulseIntel`` are likewise
 * test-injected stand-ins (fetch disabled) so ingest suites never hit
 * live SC2Pulse; production builds the real services below.
 *
 * @typedef {{
 *   db: import('./db/connect').DbContext,
 *   logger: import('pino').Logger,
 *   config: ReturnType<typeof import('./config/loader').loadConfig>
 *     & { maxUserMessagesPerWindow?: number },
 *   io?: import('socket.io').Server,
 *   pulseMmr?: import('./services/pulseMmr').PulseMmrService,
 *   pulseIntel?: import('./services/pulseOpponentIntel').PulseOpponentIntelService,
 *   pulseLinks?: import('./services/pulseCharacterLinks').PulseCharacterLinkService,
 * }} AppDeps
 */

/**
 * Build the Express app. Pure factory: no listen, no DB connect.
 *
 * The returned ``adminClerkIds`` set is LIVE: the REST ``isAdmin``
 * gate closes over it, so additions made after boot (e.g. the
 * founder-admin bootstrap in server.js) take effect immediately for
 * both REST and any caller sharing the set (the socket layer).
 *
 * @param {AppDeps} deps
 * @returns {{app: import('express').Express, services: object, adminClerkIds: Set<string>}}
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
  // Live admin allowlist — seeded from SC2TOOLS_ADMIN_USER_IDS and
  // mutated in place by the email-allowlist + admin-grant paths. The
  // REST ``isAdmin`` gate and the socket layer both read this live set;
  // the boot sequence also merges persisted DB admins into it.
  const adminClerkIds = new Set(deps.config.adminUserIds || []);
  mountRoutes(app, deps, services, clerk, adminClerkIds);
  app.use(buildErrorHandler(deps.logger));
  return { app, services, adminClerkIds };
}

/**
 * @param {AppDeps} deps
 */
function makeServices(deps) {
  // Admin notification stream — wired BEFORE UsersService so the
  // user-creation paths (ensureFromClerk first-touch, webhook upsert)
  // can fire signup events without a forward reference.
  const adminEvents = new AdminEventsService({
    db: deps.db,
    io: deps.io,
    logger: deps.logger,
  });
  const users = new UsersService(deps.db, { adminEvents });
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
  const replayFiles = buildReplayFilesFromConfig(deps.db, deps.config);
  // Cloud-side SC2Pulse resolver — drives the backfill cron's
  // recovery path for opponents whose pulseCharacterId never landed
  // on first ingest (typically because sc2pulse.nephest.com was
  // unreachable / rate-limited at that moment). Built once and
  // shared so the in-process LRU cache survives across requests.
  // Global, cross-user SC2Pulse cache. Built before the resolver +
  // OpponentsService so both can write through to (and read from) it:
  // the first user to encounter an opponent pays the SC2Pulse cost,
  // and every later user — across replicas and process restarts —
  // gets a fully-filled opponent profile from this shared collection.
  const pulseDirectory = new PulseDirectoryService(deps.db, {
    logger: deps.logger,
  });
  const pulseResolver = buildPulseResolver({
    logger: deps.logger,
    directory: pulseDirectory,
  });
  // PulseMmrService — shared across services. Originally added as the
  // Tier-3 MMR fallback for the session widget; OpponentsService also
  // uses it to populate ``opponent.mmr`` / ``opponent.region`` on the
  // opponents row at game ingest, since sc2reader almost never carries
  // those for ranked ladder replays. Constructed once so the in-process
  // 5-minute cache survives across requests. Tests inject their own
  // (with a disabled fetch) so ingest suites never hit live SC2Pulse —
  // a real fetch mid-test overwrites fixture MMRs with the actual
  // player's current ladder rating.
  const pulseMmr = deps.pulseMmr || new PulseMmrService();
  // SC2Pulse ladder-context intel for opponent dossiers (league,
  // percentile, MMR history, pro identity). Separate client from
  // PulseMmrService because it hits a different endpoint family with a
  // much longer cache TTL; also injectable for tests.
  const pulseIntel =
    deps.pulseIntel ||
    new PulseOpponentIntelService({ logger: deps.logger });
  // SC2Pulse character → account/pro linkage cache. Powers the
  // Opponents tab's "group by player" view (merging rows SC2Pulse
  // says are the same human). Shared, cross-user collection; the
  // batch fetch budget lives in the service. Injectable for tests so
  // route suites never hit live SC2Pulse.
  const pulseLinks =
    deps.pulseLinks ||
    new PulseCharacterLinkService(deps.db.pulseCharacterLinks, {
      logger: deps.logger,
    });
  // League-percentile benchmark tables — nightly aggregate over slim
  // game rows (jobs/leaguePercentilesRecomputeJob), served by
  // routes/benchmarks.js for the Macro tab's percentile framing.
  const leaguePercentiles = new LeaguePercentilesService(deps.db, {
    logger: deps.logger,
  });
  // Ladder Meta Radar — effectiveness-weighted opener meta by league
  // band + matchup from the corpus (jobs/ladderMetaRecomputeJob),
  // served PUBLICLY by routes/ladderMeta.js for the /meta SEO page.
  const ladderMeta = new LadderMetaService(deps.db, { logger: deps.logger });
  // Skill Fingerprint — per-user multi-axis skill radar (percentiles
  // against the leaguePercentiles band tables + playstyle label),
  // served by routes/fingerprint.js for the Trends tab.
  const skillFingerprint = new SkillFingerprintService(deps.db, {
    leaguePercentiles,
    logger: deps.logger,
  });
  const opponents = new OpponentsService(
    deps.db,
    deps.config.serverPepper,
    {
      gameDetails,
      logger: deps.logger,
      pulseResolver,
      pulseMmr,
      pulseDirectory,
      pulseLinks,
    },
  );
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
  // Timestamped game archives combine two independent public signals:
  // configured Twitch/YouTube channels matched by broadcast interval, and
  // SC2Pulse's participant-scoped Twitch index. The composite preserves
  // whichever source is healthy and deduplicates them into at most one icon
  // per platform/player perspective.
  const directGameVods = new GameVodsService({
    users,
    pulseIntel,
    log: deps.logger,
  });
  const pulseMatchVods = new PulseMatchVodsService({ logger: deps.logger });
  const gameVods = new GameVodLinksService({
    archives: directGameVods,
    pulseMatches: pulseMatchVods,
    log: deps.logger,
  });
  const pairings = new DevicePairingsService(deps.db);
  const overlayTokens = new OverlayTokensService(deps.db);
  // TikTok chat relay for the multichat overlay widget — one upstream
  // TikTok connection per streamer username, fanned out to every OBS
  // Browser Source over SSE. Constructed once so the connection pool
  // and its caps are process-global.
  const tiktokChatRelay = new TikTokChatRelay({ log: deps.logger });
  // Stream-studio state (highlight / poll / goals / recap) shared by
  // the dock and the multichat widget family, broadcast per token.
  // Live viewer counts for the dock — TTL-cached per channel, and it
  // reads TikTok's count off the relay connection above rather than
  // opening a second one.
  const multichatViewers = new MultichatViewersService({
    tiktokRelay: tiktokChatRelay,
    log: deps.logger,
  });
  const multichatStudio = new MultichatStudioService(deps.db, { io: deps.io });
  const multichatSounds = new MultichatSoundsService(deps.db);
  // users + overlayTokens let the service resolve the streamer's own
  // channel identities, so the broadcaster never headlines their own
  // supporter wall or oracle board.
  const multichatEngagement = new MultichatEngagementService(deps.db, {
    io: deps.io,
    users,
    overlayTokens,
  });
  // OverlayLiveService has no per-user state; constructed once and
  // shared across requests. It pulls from the same ``games`` /
  // ``opponents`` collections every other read service touches.
  // The ``gameDetails`` handle is what powers the scouting card's
  // phase forecast — the per-game ``macroBreakdown`` blob lives in
  // the detail store post-v0.4.3 cutover, not on the slim games row.
  // ``pulseMmr`` gives the rank widget the streamer's REAL current
  // league + tier from SC2Pulse instead of an MMR-threshold guess.
  const overlayLive = new OverlayLiveService(deps.db, {
    gameDetails,
    pulseMmr,
  });
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
  // Nightbot/StreamElements custom-API lines (!opponent/!mmr/!build) —
  // the overlay token in the URL path is the credential, same trust
  // model as the OBS Browser Source.
  const chatbot = new ChatbotService(deps.db, {
    overlayTokens,
    liveGameBroker,
    games,
    logger: deps.logger,
  });
  // The bot that talks back IN chat (Twitch IRC). Reuses the
  // ChatbotService line composers for !mmr/!opponent/!build and the
  // engagement service for !rank + vote/XP ingest. Engagement
  // broadcasts flow back through the onEvent hook below so the bot
  // can announce Crystal Ball opens/settles and level-ups.
  const twitchChatBot = new TwitchChatBotService({
    db: deps.db,
    users,
    overlayTokens,
    engagement: multichatEngagement,
    chatbot,
    logger: deps.logger,
  });
  multichatEngagement.onEvent = (token, msg) => {
    void twitchChatBot.handleEngagementEvent(token, msg).catch(() => {});
  };
  // Reconnect every enabled bot on boot — best-effort, non-blocking.
  void twitchChatBot.restoreAll();
  const aggregations = new AggregationsService(deps.db);
  const macroReport = new MacroReportService(deps.db);
  const streak = new StreakService(deps.db);
  const builds = new BuildsService(deps.db);
  const buildsMmrStats = new BuildsMmrStatsService(deps.db);
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
  const strategyPhases = new StrategyPhasesService(deps.db, { perGame });
  const macroBackfill = new MacroBackfillService(deps.db, { io: deps.io });
  const imports = new ImportService(deps.db, { io: deps.io });
  const spatial = new SpatialService(deps.db);
  const ml = new MLService(deps.db, { io: deps.io, gameDetails });
  // The GitHub feed makes an `agent-v*` tag push a complete release:
  // the updater's /v1/agent/version poll then sees the newest GitHub
  // release even when nobody ran the manual POST /v1/agent/releases
  // publish. Repo defaults to this monorepo; override or disable via
  // env for forks / air-gapped deploys.
  const githubReleaseRepo =
    process.env.AGENT_RELEASE_GITHUB_REPO || "ReSpOnSeSC2/sc2tools";
  const [ghOwner, ghRepo] = githubReleaseRepo.split("/");
  // Off under jest (NODE_ENV=test) so route tests never fetch the live
  // GitHub API; AGENT_RELEASE_GITHUB_FALLBACK=on re-enables for a test
  // that wants the real feed, "off" force-disables it in production.
  const githubFallbackSetting = process.env.AGENT_RELEASE_GITHUB_FALLBACK || "";
  const githubFeedEnabled =
    githubFallbackSetting === "on" ||
    (githubFallbackSetting !== "off" && process.env.NODE_ENV !== "test");
  const githubFeed =
    !githubFeedEnabled || !ghOwner || !ghRepo
      ? null
      : new GithubReleaseFeed({
          owner: ghOwner,
          repo: ghRepo,
          token: process.env.GITHUB_TOKEN || null,
          logger: deps.logger,
        });
  const agentVersion = new AgentVersionService(deps.db, { githubFeed });
  const gdpr = new GdprService(deps.db, {
    opponents,
    logger: deps.logger,
    // Store-aware heavy-blob deleter: without it, delete-account and
    // wipe-history leave R2 objects behind when GAME_DETAILS_STORE=r2.
    gameDetails,
    replayFiles,
  });
  const community = new CommunityService(deps.db);
  // Opt-in public player pages (/p/:handle). Derives entirely from
  // existing services — a public profile exists iff the user published
  // a community build under a public authorName (the community opt-in),
  // so no new user state and no GDPR change.
  const publicProfile = new PublicProfileService(deps.db, {
    community,
    aggregations,
    builds,
  });
  const seasons = new SeasonsService();
  const arcade = new ArcadeService(deps.db, { games, gameDetails });
  // Stats-ticker fun-facts pool — career stats, records, and trivia
  // for the overlay's scrolling bottom line. Composes the fingerprint,
  // arcade unit trivia, and season catalog as best-effort extras; the
  // core pool only needs the games collection. TTL-cached per user.
  const tickerFacts = new TickerFactsService(deps.db, {
    skillFingerprint,
    arcade,
    seasons,
  });
  // AdminService composes db + gdpr; deliberately near the bottom so
  // its dependencies are already constructed.
  const admin = new AdminService({ db: deps.db, gdpr });
  // Cross-user global tracking for the admin Global tab — merges every
  // user's opponents / games into platform-wide player, strategy,
  // build, and map records. Reads the shared Pulse cache for resolve /
  // MMR coverage counters.
  const adminGlobal = new AdminGlobalService({
    db: deps.db,
    pulseDirectory,
  });
  // Google Analytics 4 reader for the admin Analytics tab. Pure
  // adapter over the GA4 Data API; ``config.analytics.enabled`` is
  // false when GA isn't wired up, in which case the routes return a
  // "not configured" payload instead of calling Google.
  const analytics = new AnalyticsService({
    config: deps.config.analytics || {
      enabled: false,
      propertyId: null,
      credentials: null,
      keyFile: null,
    },
  });
  return {
    users,
    opponents,
    games,
    gameVods,
    gameDetails,
    replayFiles,
    customBuilds,
    pairings,
    overlayTokens,
    overlayLive,
    liveGameBroker,
    tiktokChatRelay,
    multichatStudio,
    multichatSounds,
    multichatEngagement,
    multichatViewers,
    aggregations,
    macroReport,
    streak,
    builds,
    strategyPhases,
    buildsMmrStats,
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
    arcade,
    tickerFacts,
    twitchChatBot,
    admin,
    adminGlobal,
    adminEvents,
    analytics,
    pulseMmr,
    pulseIntel,
    pulseLinks,
    leaguePercentiles,
    skillFingerprint,
    ladderMeta,
    publicProfile,
    chatbot,
    pulseDirectory,
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
 * @param {Set<string>} adminClerkIds live admin set — see buildApp docs.
 */
function mountRoutes(app, deps, services, clerk, adminClerkIds) {
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
  // Prometheus scrape endpoint. Mounted only when METRICS_TOKEN is
  // configured (the route enforces the bearer token itself).
  if (deps.config.metricsToken) {
    app.use(
      SERVICE.ROUTE_PREFIX,
      buildMetricsRouter({
        token: deps.config.metricsToken,
        liveGameBroker: services.liveGameBroker,
      }),
    );
  }
  app.use(SERVICE.ROUTE_PREFIX, buildSeasonsRouter({ seasons: services.seasons }));
  // Public, corpus-wide, k-anonymous meta report (no user data) — SEO
  // surface, mounts with the public routers.
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildLadderMetaRouter({ ladderMeta: services.ladderMeta }),
  );
  // Public marketing-page replay preview. Unauth'd by design — the
  // landing page demo accepts a single .SC2Replay upload and returns
  // a parsed dossier. Rate-limited per IP inside the router.
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildPublicReplayRouter({ logger: deps.logger }),
  );
  // Chat-bot lines — PUBLIC bundle (Nightbot's urlfetch can't send
  // headers; the overlay token in the path is the credential).
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildChatbotRouter({ chatbot: services.chatbot, logger: deps.logger }),
  );
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildChatBotSettingsRouter({
      auth,
      users: services.users,
      twitchChatBot: services.twitchChatBot,
    }),
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
      adminEvents: services.adminEvents,
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
  // Seeded from SC2TOOLS_ADMIN_USER_IDS in buildApp; the founder-admin
  // bootstrap in server.js adds DB-granted admins after boot. The gate
  // reads the live set, so those grants apply without a restart.
  const adminIds = adminClerkIds || new Set(deps.config.adminUserIds || []);
  /** @param {import('express').Request} req */
  const isAdmin = (req) =>
    Boolean(req.auth && req.auth.clerkUserId && adminIds.has(req.auth.clerkUserId));
  // Email allowlist — the deterministic admin path. Lower-cased at load;
  // an empty set disables it. ``isAdminEmail`` is what the /v1/me route
  // consults to promote a matching user on sight; ``onAdminGranted``
  // merges the freshly-granted Clerk id into the live allowlist so the
  // /v1/admin gate + socket layer pick it up without a restart.
  const adminEmails = new Set(deps.config.adminEmails || []);
  /** @param {string} email */
  const isAdminEmail = (email) =>
    typeof email === "string" && adminEmails.has(email.toLowerCase());
  /** @param {string} clerkUserId */
  const onAdminGranted = (clerkUserId) => {
    if (clerkUserId) adminIds.add(clerkUserId);
  };
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildMeRouter({
      users: services.users,
      games: services.games,
      gdpr: services.gdpr,
      pairings: services.pairings,
      imports: services.imports,
      multichatSounds: services.multichatSounds,
      replayArchiveEnabled: Boolean(services.replayFiles),
      clerk,
      pulseMmr: services.pulseMmr,
      auth,
      isAdmin,
      isAdminEmail,
      onAdminGranted,
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
  // Opt-in public player pages — unauth GET /v1/public/profile/:handle,
  // rate-limited in the router. Public bundle (before authed routers).
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildPublicProfileRouter({ publicProfile: services.publicProfile }),
  );
  // Multichat overlay relays — overlay-token auth (path segment), no
  // Clerk session, so it mounts with the public bundle.
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildMultichatRouter({
      overlayTokens: services.overlayTokens,
      users: services.users,
      tiktokRelay: services.tiktokChatRelay,
      studio: services.multichatStudio,
      sounds: services.multichatSounds,
      engagement: services.multichatEngagement,
      viewers: services.multichatViewers,
      customBuilds: services.customBuilds,
      buildsList: (userId) => services.builds.list(userId, {}),
      tickerFacts: services.tickerFacts,
    }),
  );
  // Operational admin router — gated on isAdmin(req) inside the
  // router. Mounted alongside the rest of the v1 prefix so
  // /v1/admin/* shares CORS, rate-limit, and JSON parsing config.
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildAdminRouter({
      admin: services.admin,
      adminGlobal: services.adminGlobal,
      adminEvents: services.adminEvents,
      analytics: services.analytics,
      gdpr: services.gdpr,
      games: services.games,
      opponents: services.opponents,
      perGame: services.perGame,
      users: services.users,
      auth,
      isAdmin,
      // Push freshly-granted admins into the live allowlist so their
      // next request is authorized without waiting for a restart.
      onAdminGranted: (clerkUserId) => {
        if (clerkUserId) adminClerkIds.add(clerkUserId);
      },
      gameDetailsStoreKind: deps.config.gameDetailsStore,
    }),
  );
  // User → admin messaging (bug reports). Auth-gated per-path inside
  // the router; persists each message as a ``user_message`` admin
  // event so it shares the /admin/notifications inbox.
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildMessagesRouter({
      adminEvents: services.adminEvents,
      users: services.users,
      auth,
      maxPerWindow: deps.config.maxUserMessagesPerWindow,
    }),
  );
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildBenchmarksRouter({
      leaguePercentiles: services.leaguePercentiles,
      auth,
    }),
  );
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildFingerprintRouter({
      skillFingerprint: services.skillFingerprint,
      auth,
    }),
  );
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildOpponentsRouter({
      opponents: services.opponents,
      auth,
      pulseIntel: services.pulseIntel,
      pulseLinks: services.pulseLinks,
      // Distinct resolved character ids across the caller's opponent
      // rows — the id set the grouping endpoint asks SC2Pulse about.
      listPulseCharacterIds: async (userId) => {
        const ids = await deps.db.opponents.distinct("pulseCharacterId", {
          userId,
          pulseCharacterId: { $type: "string", $ne: "" },
        });
        return ids.filter((id) => typeof id === "string" && id.length > 0);
      },
      // Lean ownership + identity lookup for the pulse-intel route:
      // undefined = not the caller's opponent (404), null = theirs but
      // the SC2Pulse character id hasn't resolved yet (card hidden).
      resolvePulseCharacterId: async (userId, pulseId) => {
        const row = await deps.db.opponents.findOne(
          { userId, pulseId },
          { projection: { _id: 0, pulseCharacterId: 1 } },
        );
        if (!row) return undefined;
        return typeof row.pulseCharacterId === "string" && row.pulseCharacterId
          ? row.pulseCharacterId
          : null;
      },
    }),
  );
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildReplayFilesRouter({
      replayFiles: services.replayFiles,
      auth,
    }),
  );
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildGamesRouter({
      games: services.games,
      gameVods: services.gameVods,
      opponents: services.opponents,
      users: services.users,
      customBuilds: services.customBuilds,
      overlayLive: services.overlayLive,
      overlayTokens: services.overlayTokens,
      liveGameBroker: services.liveGameBroker,
      engagement: services.multichatEngagement,
      ladderMapPool: services.seasons ? services.seasons.ladderMapPool : undefined,
      io: deps.io,
      auth,
    }),
  );
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildCustomBuildsRouter({
      customBuilds: services.customBuilds,
      perGame: services.perGame,
      community: services.community,
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
      macroReport: services.macroReport,
      streak: services.streak,
      auth,
    }),
  );
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildBuildsRouter({
      builds: services.builds,
      strategyPhases: services.strategyPhases,
      auth,
    }),
  );
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildBuildsMmrStatsRouter({
      buildsMmrStats: services.buildsMmrStats,
      auth,
    }),
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
  app.use(
    SERVICE.ROUTE_PREFIX,
    buildArcadeRouter({ arcade: services.arcade, auth }),
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
      engagement: services.multichatEngagement,
      overlayTokens: services.overlayTokens,
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
