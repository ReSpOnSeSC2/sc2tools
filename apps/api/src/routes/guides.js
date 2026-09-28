"use strict";

const express = require("express");
const rateLimitModule = require("express-rate-limit");
const { BoundedRateLimitStore } = require("../middleware/boundedRateLimitStore");
const { SERVICE } = require("../config/constants");
const { GUIDE_CACHE_CONTROL, GUIDE_CURRENT_ERA } = require("../config/guides");
const {
  matchupFromSlug,
  resolveBuild,
  resolveStrategy,
  mapSlug,
  SLUG_ALIASES,
} = require("../config/guideSlugs");
const { PATCH_ERAS } = require("../util/patchEra");
const {
  GUIDE_LEAGUE_BANDS,
  GUIDE_MMR_BANDS,
  leagueLabel,
  mmrBandLabel,
} = require("../services/guideRules");

const rateLimit =
  /** @type {any} */ (rateLimitModule).default || rateLimitModule;

const GUIDES_PATH = "/guides";
const LIMIT_WINDOW_MS = 60_000;
const LIMIT_PER_MINUTE = 300;
const LIMIT_MAX_ENTRIES = 4096;
const HTTP_MOVED_PERMANENTLY = 301;
const HTTP_NOT_FOUND = 404;
const HTTP_SERVER_ERROR = 500;
/**
 * Unknown slugs and not-yet-computed maps: cached at the edge, but for
 * minutes rather than the hour a real page gets. A crawler or scanner
 * hammering junk URLs is absorbed by the CDN, while a map that the next
 * nightly run publishes stops 404ing within five minutes.
 */
const GUIDE_NOT_FOUND_CACHE_CONTROL = "public, s-maxage=300, stale-while-revalidate=600";
/** Signed-in, per-user responses. */
const PRIVATE_NO_STORE = "private, no-store";
/** The default of every /guides response: errors, 429s, the flag-off 404 (a flip must be instant). */
const NO_STORE = "no-store";
/** Every guide URL segment (matchup, build, strategy and map slugs). */
const SEGMENT_RE = /^[a-z0-9-]{1,80}$/;
/** Canonical integers only ("league:04" is not "league:4"). */
const BAND_RE = /^(league|mmr):(0|[1-9]\d{0,4})$/;
const BAND_LEAGUE = "league";

/**
 * /v1/guides — the public SC2 Tools Guides API (docs: contract §6).
 *
 *   GET /guides                              hub: matchups, what's winning, maps, videos
 *   GET /guides/sitemap                      published guide paths
 *   GET /guides/maps/:map                    map guide
 *   GET /guides/:matchup[?band=&era=]        openers of a matchup
 *   GET /guides/:matchup/counter/:strategy   how to beat an opponent opener
 *   GET /guides/:matchup/:build              build guide
 *   GET /guides/me/:matchup/:build           the caller's own numbers (auth)
 *
 * PUBLIC: no ``router.use(auth)`` — only the ``/me`` route applies
 * ``deps.auth`` itself, so the router mounts in app.js's public bundle.
 * When ``enabled`` is false every ``/guides`` path answers 404 (the gate
 * is path-scoped, so unrelated /v1 traffic passing through is untouched).
 * A bounded per-IP-and-path limiter guards the whole prefix. Public 200s and 301s
 * carry GUIDE_CACHE_CONTROL, 404s a five-minute edge cache, ``/me`` is
 * ``private, no-store`` and everything else (429, 5xx) ``no-store``.
 *
 * @param {{
 *   guides: import('../services/guides').GuidesService,
 *   guideSamples: Pick<import('../services/guideSamples').GuideSamplesService, "userHash">,
 *   auth: import('express').RequestHandler,
 *   enabled: boolean,
 *   limitPerMinute?: number,
 *   aliases?: typeof SLUG_ALIASES,
 * }} deps
 *   ``aliases`` defaults to config/guideSlugs.js SLUG_ALIASES (tests inject
 *   a table, since the committed one is empty until a rename needs it).
 */
function buildGuidesRouter(deps) {
  const router = express.Router();
  // Uncacheable unless a handler below marks the response public (200,
  // 301, 404) or private: a 429, a 500 or the flag-off 404 must never be
  // stored by a shared cache.
  router.use(GUIDES_PATH, (_req, res, next) => {
    res.set("Cache-Control", NO_STORE);
    if (deps.enabled) return next();
    res.status(HTTP_NOT_FOUND).json({ error: { code: "not_found" } });
  });
  router.use(GUIDES_PATH, rateLimit({
    windowMs: LIMIT_WINDOW_MS,
    max: deps.limitPerMinute || LIMIT_PER_MINUTE,
    standardHeaders: true,
    legacyHeaders: false,
    store: new BoundedRateLimitStore({ maxEntries: LIMIT_MAX_ENTRIES }),
    // Guide pages are server-rendered, so every visitor reaches this API
    // from the web's shared egress IP. Keying on the path too (never the
    // query string) means a flood of junk slugs only fills its own buckets
    // and cannot 429 the real guide pages. Direct callers stay capped per
    // IP by the app-wide limiter.
    keyGenerator: (/** @type {import('express').Request} */ req) => `guides:${req.ip}:${req.path}`,
    message: { error: { code: "rate_limited", message: "rate_limited" } },
  }));
  mountPublicRoutes(router, deps);
  // ``private, no-store`` is set BEFORE auth runs, so the 401 of a
  // signed-out caller is never stored by a shared cache either.
  router.get("/guides/me/:matchup/:build", privateNoStore, deps.auth, handle(async (req, res) => {
    const aliases = (deps.aliases || SLUG_ALIASES).builds;
    const resolved = followAlias(resolveBuild(req.params.matchup, req.params.build, aliases), aliases);
    const userId = req.auth && req.auth.userId;
    if (!resolved || typeof userId !== "string") {
      res.status(HTTP_NOT_FOUND).json({ error: { code: "not_found" } });
      return;
    }
    res.json(await deps.guides.me({
      userId,
      userHash: deps.guideSamples.userHash(userId),
      matchup: resolved.matchup,
      buildKey: resolved.name,
    }));
  }));
  mountPageRoutes(router, deps);
  // Anything else under /guides (deeper paths, other methods) is a plain
  // 404 here rather than falling through to a later auth-eager router's 401.
  router.use(GUIDES_PATH, (_req, res) => sendNotFound(res));
  return router;
}

/**
 * Hub, sitemap and map routes (declared before the ``:matchup`` patterns
 * so "sitemap" / "maps" are never read as matchup slugs).
 *
 * @param {import('express').Router} router
 * @param {{ guides: import('../services/guides').GuidesService }} deps
 */
function mountPublicRoutes(router, deps) {
  router.get("/guides", handle(async (_req, res) => {
    sendPublic(res, await deps.guides.index());
  }));
  router.get("/guides/sitemap", handle(async (_req, res) => {
    sendPublic(res, await deps.guides.sitemap());
  }));
  router.get("/guides/maps/:map", handle(async (req, res) => {
    const slug = String(req.params.map);
    const payload = SEGMENT_RE.test(slug) && mapSlug(slug) === slug ? await deps.guides.map(slug) : null;
    if (!payload) return sendNotFound(res);
    sendPublic(res, payload);
  }));
}

/**
 * Matchup, counter and build pages.
 *
 * @param {import('express').Router} router
 * @param {{ guides: import('../services/guides').GuidesService, aliases?: typeof SLUG_ALIASES }} deps
 */
function mountPageRoutes(router, deps) {
  const aliases = deps.aliases || SLUG_ALIASES;
  router.get("/guides/:matchup", handle(async (req, res) => {
    const matchup = matchupFromSlug(req.params.matchup);
    if (!matchup) return sendNotFound(res);
    sendPublic(res, await deps.guides.matchup(matchup, {
      era: parseEra(req.query.era),
      band: parseBand(req.query.band),
    }));
  }));
  router.get("/guides/:matchup/counter/:strategy", handle(async (req, res) => {
    const resolved = resolveStrategy(req.params.matchup, req.params.strategy, aliases.counters);
    if (!resolved) return sendNotFound(res);
    if ("redirect" in resolved) {
      return sendMoved(res, `${resolved.redirect.matchupSlug}/counter/${resolved.redirect.slug}`);
    }
    sendPublic(res, await deps.guides.counter(resolved));
  }));
  router.get("/guides/:matchup/:build", handle(async (req, res) => {
    const resolved = resolveBuild(req.params.matchup, req.params.build, aliases.builds);
    if (!resolved) return sendNotFound(res);
    if ("redirect" in resolved) return sendMoved(res, `${resolved.redirect.matchupSlug}/${resolved.redirect.slug}`);
    sendPublic(res, await deps.guides.build(resolved));
  }));
}

/**
 * A live build resolution, following one alias hop (the private ``/me``
 * route serves the canonical build instead of redirecting).
 *
 * @param {ReturnType<typeof resolveBuild>} resolved
 * @param {typeof SLUG_ALIASES.builds} aliases
 * @returns {{ matchup: string, name: string, slug: string }|null}
 */
function followAlias(resolved, aliases) {
  if (!resolved) return null;
  if (!("redirect" in resolved)) return resolved;
  const next = resolveBuild(resolved.redirect.matchupSlug, resolved.redirect.slug, aliases);
  return next && !("redirect" in next) ? next : null;
}

/**
 * First scalar string of a query value (repeated params → the first).
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
function queryString(raw) {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? value.trim() : null;
}

/**
 * `era=after|before`; anything else is the current era.
 *
 * @param {unknown} raw
 * @returns {string}
 */
function parseEra(raw) {
  const era = queryString(raw);
  return era && /** @type {ReadonlyArray<string>} */ (PATCH_ERAS).includes(era) ? era : GUIDE_CURRENT_ERA;
}

/**
 * `band=league:<0..6>` or `band=mmr:<ladder-meta band floor>`; anything
 * else means "all bands" (null).
 *
 * Example: `parseBand("league:4")` → `{ type: "league", value: 4, label: "Diamond" }`.
 *
 * @param {unknown} raw
 * @returns {{ type: "league"|"mmr", value: number, label: string }|null}
 */
function parseBand(raw) {
  const text = queryString(raw);
  const match = text ? BAND_RE.exec(text) : null;
  if (!match) return null;
  const value = Number(match[2]);
  if (match[1] === BAND_LEAGUE) {
    return GUIDE_LEAGUE_BANDS.includes(value) ? { type: "league", value, label: leagueLabel(value) } : null;
  }
  const label = GUIDE_MMR_BANDS.includes(value) ? mmrBandLabel(value) : null;
  return label ? { type: "mmr", value, label } : null;
}

/** @type {import('express').RequestHandler} */
function privateNoStore(_req, res, next) {
  res.set("Cache-Control", PRIVATE_NO_STORE);
  next();
}

/**
 * @param {import('express').Response} res
 * @param {object} payload
 */
function sendPublic(res, payload) {
  res.set("Cache-Control", GUIDE_CACHE_CONTROL).json(payload);
}

/** @param {import('express').Response} res */
function sendNotFound(res) {
  res.set("Cache-Control", GUIDE_NOT_FOUND_CACHE_CONTROL)
    .status(HTTP_NOT_FOUND)
    .json({ error: { code: "not_found" } });
}

/**
 * 301 to the canonical guide of a retired (aliased) slug.
 *
 * @param {import('express').Response} res
 * @param {string} rest path after "/guides/"
 */
function sendMoved(res, rest) {
  res.set("Cache-Control", GUIDE_CACHE_CONTROL)
    .set("Location", `${SERVICE.ROUTE_PREFIX}${GUIDES_PATH}/${rest}`)
    .status(HTTP_MOVED_PERMANENTLY)
    .json({ movedTo: `${GUIDES_PATH}/${rest}` });
}

/**
 * Async handler wrapper: coded 4xx errors become JSON, the rest go to the
 * app error handler.
 *
 * @param {(req: import('express').Request, res: import('express').Response) => Promise<void>} fn
 * @returns {import('express').RequestHandler}
 */
function handle(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (e && typeof e.status === "number" && e.status < HTTP_SERVER_ERROR && typeof e.code === "string") {
        res.status(e.status).json({ error: { code: e.code } });
        return;
      }
      next(err);
    }
  };
}

module.exports = {
  buildGuidesRouter,
  parseBand,
  parseEra,
  GUIDE_NOT_FOUND_CACHE_CONTROL,
};
