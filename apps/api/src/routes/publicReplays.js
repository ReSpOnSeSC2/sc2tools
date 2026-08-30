"use strict";

const express = require("express");
const rateLimitModule = require("express-rate-limit");
const { parseFilters } = require("../util/parseQuery");

const rateLimit =
  /** @type {any} */ (rateLimitModule).default || rateLimitModule;

const PUBLIC_REPLAYS_RATE_LIMIT_PER_MIN = 300;

/**
 * Explicitly opt-in replay archive. Replay rows, matched Twitch/YouTube links,
 * and original-file downloads are public once the owner enables sharing.
 * Per-game analysis uses the standard account auth gate while still resolving
 * data through the shared owner's identity. Every response is reconstructed
 * from allow-listed fields.
 *
 * @param {{
 *   replayLibrary: import('../services/replayLibrary').ReplayLibraryService,
 *   users: import('../services/types').UsersService,
 *   gameVods: {resolveForGames(userId:string, games:object[], opts?:object): Promise<any>},
 *   perGame: import('../services/types').PerGameComputeService,
 *   replayFiles?: import('../services/replayFiles').ReplayFilesService|null,
 *   auth: import('express').RequestHandler,
 *   rateLimitPerMinute?: number,
 * }} deps
 */
function buildPublicReplaysRouter(deps) {
  if (
    !deps?.replayLibrary
    || !deps?.users
    || !deps?.gameVods
    || !deps?.perGame
    || typeof deps?.auth !== "function"
  ) {
    throw new Error("buildPublicReplaysRouter: replay services required");
  }
  const router = express.Router();
  const max =
    typeof deps.rateLimitPerMinute === "number" && deps.rateLimitPerMinute > 0
      ? deps.rateLimitPerMinute
      : PUBLIC_REPLAYS_RATE_LIMIT_PER_MIN;
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    // Next server-renders public archives, so all viewers can share one web
    // egress IP. Include the player archive slug to prevent traffic to one
    // shared page from exhausting every player's replay-page bucket.
    keyGenerator: (/** @type {import('express').Request} */ req) =>
      `${req.ip}:${String(req.params.handle || "")}`,
    message: { error: { code: "rate_limited", message: "rate_limited" } },
  });
  const downloadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Math.min(max, 20),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (/** @type {import('express').Request} */ req) =>
      `${req.ip}:${String(req.params.handle || "")}`,
    message: { error: { code: "rate_limited", message: "rate_limited" } },
  });

  router.get("/public/replays/:handle", limiter, async (req, res, next) => {
    try {
      const shared = await deps.users.resolveReplaySharing(
        String(req.params.handle || ""),
      );
      if (!shared) return neutralNotFound(res);

      const page = await deps.replayLibrary.list(
        shared.userId,
        parseReplayListQuery(req.query),
      );
      const vods = await resolveVods(
        deps.gameVods,
        shared.userId,
        page.sourceGames,
      );
      publicNoStore(res);
      res.json({
        profile: publicProfile(shared.profile),
        items: page.items.map((item) =>
          publicReplayItem(
            item,
            linksFor(vods, item.gameId),
            Boolean(deps.replayFiles),
          ),
        ),
        page: pageEnvelope(page),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get(
    "/public/replays/:handle/:gameId",
    limiter,
    deps.auth,
    async (req, res, next) => {
      try {
        const shared = await deps.users.resolveReplaySharing(
          String(req.params.handle || ""),
        );
        if (!shared) return neutralNotFound(res);

        const gameId = String(req.params.gameId || "");
        const detail = await deps.replayLibrary.getDetail(shared.userId, gameId);
        if (!detail) return neutralNotFound(res);

        const [macro, build, vods] = await Promise.all([
          readOptional(() => deps.perGame.macroBreakdown(shared.userId, gameId)),
          readOptional(() => deps.perGame.buildOrder(shared.userId, gameId)),
          resolveVods(deps.gameVods, shared.userId, [detail.sourceGame]),
        ]);
        publicNoStore(res);
        res.json({
          profile: publicProfile(shared.profile),
          game: publicReplayItem(
            detail.game,
            [],
            Boolean(deps.replayFiles),
          ),
          macroBreakdown: publicMacroBreakdown(macro),
          buildOrder: publicBuildOrder(build),
          streams: publicStreamLinks(linksFor(vods, detail.game.gameId)),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    "/public/replays/:handle/:gameId/download",
    downloadLimiter,
    async (req, res, next) => {
      try {
        const shared = await deps.users.resolveReplaySharing(
          String(req.params.handle || ""),
        );
        if (!shared) return neutralNotFound(res);
        const gameId = String(req.params.gameId || "");
        const detail = await deps.replayLibrary.getDetail(shared.userId, gameId);
        if (!detail) return neutralNotFound(res);
        if (!deps.replayFiles) {
          throw httpError(
            503,
            "replay_storage_unavailable",
            "Replay storage is unavailable.",
          );
        }
        publicNoStore(res);
        res.json(await deps.replayFiles.prepareDownload(shared.userId, gameId));
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

/** @param {Record<string, unknown>} raw */
function parseReplayListQuery(raw) {
  const query = raw && typeof raw === "object" ? raw : {};
  return {
    filters: parseFilters(query),
    limit: firstQueryValue(query.limit),
    cursor: firstQueryValue(query.cursor),
    search: firstQueryValue(query.search),
    result: firstQueryValue(query.result),
    matchup: firstQueryValue(query.matchup),
    sort: firstQueryValue(query.sort),
  };
}

/** @param {unknown} value */
function firstQueryValue(value) {
  if (typeof value === "string" || typeof value === "number") return value;
  if (!Array.isArray(value)) return undefined;
  const first = value[0];
  return typeof first === "string" || typeof first === "number"
    ? first
    : undefined;
}

/** @param {unknown} profile */
function publicProfile(profile) {
  const row = objectOrEmpty(profile);
  return {
    handle: boundedString(row.handle, 64) || "player",
    displayName: boundedString(row.displayName, 80) || "SC2 Player",
  };
}

/** @param {unknown} raw @param {unknown} rawLinks @param {boolean} [downloadsEnabled] */
function publicReplayItem(raw, rawLinks, downloadsEnabled = true) {
  const row = objectOrEmpty(raw);
  const opponent = objectOrEmpty(row.opponent);
  return {
    gameId: boundedString(row.gameId, 200),
    date: safeDateString(row.date),
    result: boundedString(row.result, 24),
    map: boundedString(row.map, 200),
    durationSec: boundedNumber(row.durationSec, 0, 86_400, true),
    playerCount: boundedNumber(row.playerCount, 1, 16, true),
    matchFormat: validReplayFormat(row.matchFormat),
    myRace: boundedString(row.myRace, 24),
    myBuild: boundedString(row.myBuild, 200),
    myMmr: boundedNumber(row.myMmr, 0, 9_999, true),
    macroScore: boundedNumber(row.macroScore, 0, 100, false),
    opponent: {
      displayName: boundedString(opponent.displayName, 80),
      race: boundedString(opponent.race, 24),
      mmr: boundedNumber(opponent.mmr, 0, 9_999, true),
      strategy: boundedString(opponent.strategy, 200),
    },
    matchup: validMatchup(row.matchup),
    replayAvailable: downloadsEnabled && row.replayAvailable === true,
    replaySizeBytes: downloadsEnabled
      ? boundedNumber(
        row.replaySizeBytes,
        1,
        1024 * 1024 * 1024,
        true,
      )
      : null,
    streams: publicStreamLinks(rawLinks),
  };
}

/** @param {unknown} raw */
function publicMacroBreakdown(raw) {
  const source = objectOrEmpty(raw);
  if (source.ok !== true) return null;
  const out = {
    ok: true,
    macro_score: boundedNumber(source.macro_score, 0, 100, false),
    race: boundedString(source.race, 24),
    game_length_sec: boundedNumber(source.game_length_sec, 0, 86_400, true),
    raw: publicMacroRaw(source.raw),
    all_leaks: publicLeaks(source.all_leaks, 50),
    top_3_leaks: publicLeaks(source.top_3_leaks, 3),
    stats_events: publicStatsEvents(source.stats_events),
    opp_stats_events: publicStatsEvents(source.opp_stats_events),
  };
  return out;
}

/** @param {unknown} raw */
function publicMacroRaw(raw) {
  const source = objectOrEmpty(raw);
  /** @type {Record<string, any>} */
  const out = {};
  for (const key of MACRO_NUMBER_FIELDS) {
    const value = boundedNumber(source[key], -1_000_000, 1_000_000, false);
    if (value !== null) out[key] = value;
  }
  out.supply_block_windows = publicSupplyWindows(source.supply_block_windows);
  out.opp_supply_block_windows = publicSupplyWindows(
    source.opp_supply_block_windows,
  );
  out.chrono_targets = arrayOrEmpty(source.chrono_targets)
    .slice(0, 100)
    .flatMap((entry) => {
      const row = objectOrEmpty(entry);
      const count = boundedNumber(row.count, 0, 10_000, true);
      if (count === null) return [];
      return [{
        name: boundedString(row.name, 100),
        building_name: boundedString(row.building_name, 100),
        count,
      }];
    });
  return out;
}

/** @param {unknown} raw */
function publicSupplyWindows(raw) {
  return arrayOrEmpty(raw).slice(0, 200).flatMap((entry) => {
    const row = objectOrEmpty(entry);
    const start = boundedNumber(row.start, 0, 86_400, false);
    const end = boundedNumber(row.end, 0, 86_400, false);
    if (start === null || end === null || end < start) return [];
    return [{
      start,
      end,
      blocked_sec: boundedNumber(row.blocked_sec, 0, 86_400, false),
      kind: boundedString(row.kind, 40),
    }];
  });
}

/** @param {unknown} raw @param {number} limit */
function publicLeaks(raw, limit) {
  return arrayOrEmpty(raw).slice(0, limit).map((entry) => {
    const row = objectOrEmpty(entry);
    return {
      name: boundedString(row.name, 160),
      detail: boundedString(row.detail, 500),
      penalty: boundedNumber(row.penalty, -1_000, 1_000, false),
      mineral_cost: boundedNumber(row.mineral_cost, 0, 10_000_000, false),
      time: boundedNumber(row.time, 0, 86_400, false),
    };
  });
}

/** @param {unknown} raw */
function publicStatsEvents(raw) {
  return arrayOrEmpty(raw).slice(0, 5_000).flatMap((entry) => {
    const source = objectOrEmpty(entry);
    const time = boundedNumber(source.time, 0, 86_400, false);
    if (time === null) return [];
    /** @type {Record<string, any>} */
    const out = { time };
    for (const key of STATS_NUMBER_FIELDS) {
      if (key === "time") continue;
      const value = boundedNumber(source[key], 0, 1_000_000_000, false);
      if (value !== null) out[key] = value;
    }
    return [out];
  });
}

/** @param {unknown} raw */
function publicBuildOrder(raw) {
  const source = objectOrEmpty(raw);
  if (source.ok !== true) return null;
  return {
    ok: true,
    game_id: boundedString(source.game_id, 200),
    my_build: boundedString(source.my_build, 200),
    my_race: boundedString(source.my_race, 24),
    opp_strategy: boundedString(source.opp_strategy, 200),
    opponent: boundedString(source.opponent, 80),
    opp_race: boundedString(source.opp_race, 24),
    map: boundedString(source.map, 200),
    result: boundedString(source.result, 24),
    events: publicBuildEvents(source.events),
    early_events: publicBuildEvents(source.early_events),
    opp_events: publicBuildEvents(source.opp_events),
    opp_early_events: publicBuildEvents(source.opp_early_events),
    my_status: validBuildStatus(source.my_status),
    opp_status: validBuildStatus(source.opp_status),
  };
}

/** @param {unknown} raw */
function publicBuildEvents(raw) {
  return arrayOrEmpty(raw).slice(0, 2_000).flatMap((entry) => {
    const row = objectOrEmpty(entry);
    const time = boundedNumber(row.time, 0, 86_400, false);
    const name = boundedString(row.name, 160);
    if (time === null || !name) return [];
    return [{
      time,
      time_display: boundedString(row.time_display, 16),
      name,
      display: boundedString(row.display, 160),
      race: boundedString(row.race, 24),
      category: boundedString(row.category, 40),
      tier: boundedNumber(row.tier, 0, 20, true),
      is_building: row.is_building === true,
    }];
  });
}

/** @param {unknown} raw */
function publicStreamLinks(raw) {
  return arrayOrEmpty(raw).slice(0, 8).flatMap((entry) => {
    const link = objectOrEmpty(entry);
    const platform = link.platform;
    const perspective = link.perspective;
    const url = safeProviderUrl(link.url, platform);
    const offsetSec = boundedNumber(link.offsetSec, 0, 86_400, false);
    if (
      (platform !== "twitch" && platform !== "youtube")
      || (perspective !== "me" && perspective !== "opponent")
      || !url
      || offsetSec === null
    ) {
      return [];
    }
    return [{
      platform,
      perspective,
      playerName: boundedString(link.playerName, 80),
      url,
      offsetSec,
      videoId: boundedString(link.videoId, 160),
    }];
  });
}

/** @param {unknown} rawUrl @param {unknown} platform */
function safeProviderUrl(rawUrl, platform) {
  if (typeof rawUrl !== "string" || rawUrl.length > 2_048) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (platform === "twitch" && host !== "twitch.tv") return null;
    if (
      platform === "youtube"
      && host !== "youtube.com"
      && host !== "youtu.be"
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

/** @param {any} gameVods @param {string} userId @param {unknown} sourceGames */
async function resolveVods(gameVods, userId, sourceGames) {
  try {
    return await gameVods.resolveForGames(
      userId,
      Array.isArray(sourceGames) ? sourceGames : [],
      { includeOpponent: true },
    );
  } catch {
    return { configuredPlatforms: [], linksByGameId: {} };
  }
}

/** @param {any} vods @param {unknown} gameId */
function linksFor(vods, gameId) {
  if (typeof gameId !== "string") return [];
  const links = vods?.linksByGameId?.[gameId];
  return Array.isArray(links) ? links : [];
}

/** @param {() => Promise<unknown>} read */
async function readOptional(read) {
  try {
    return await read();
  } catch {
    return null;
  }
}

/** @param {{nextCursor?: string|null, hasMore?: boolean}} page */
function pageEnvelope(page) {
  const nextCursor = typeof page?.nextCursor === "string"
    ? page.nextCursor
    : null;
  return {
    nextCursor,
    hasMore: page?.hasMore === true || nextCursor !== null,
  };
}

/** @param {unknown} raw @param {number} max */
function boundedString(raw, max) {
  if (typeof raw !== "string") return null;
  const value = raw
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
  return value || null;
}

/** @param {unknown} raw @param {number} min @param {number} max @param {boolean} integer */
function boundedNumber(raw, min, max, integer) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw < min || raw > max) return null;
  return integer ? Math.trunc(raw) : raw;
}

/** @param {unknown} raw */
function safeDateString(raw) {
  if (typeof raw !== "string" && !(raw instanceof Date)) return null;
  const value = new Date(raw);
  return Number.isNaN(value.getTime()) ? null : value.toISOString();
}

/** @param {unknown} raw */
function validMatchup(raw) {
  return typeof raw === "string" && /^[PTZR]v[PTZR]$/.test(raw)
    ? raw
    : null;
}

/** @param {unknown} raw */
function validReplayFormat(raw) {
  return raw === "1v1" || raw === "team" || raw === "ffa" || raw === "other"
    ? raw
    : null;
}

/** @param {unknown} raw */
function validBuildStatus(raw) {
  return raw === "ok" || raw === "empty" || raw === "not_extracted"
    ? raw
    : undefined;
}

/** @param {unknown} raw @returns {Record<string, any>} */
function objectOrEmpty(raw) {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? /** @type {Record<string, any>} */ (raw)
    : {};
}

/** @param {unknown} raw @returns {any[]} */
function arrayOrEmpty(raw) {
  return Array.isArray(raw) ? raw : [];
}

/** @param {import('express').Response} res */
function neutralNotFound(res) {
  publicNoStore(res);
  res.status(404).json({
    error: {
      code: "replay_library_not_found",
      message: "This replay archive is private or doesn't exist.",
    },
  });
}

/** @param {import('express').Response} res */
function publicNoStore(res) {
  res.set("Cache-Control", "no-store, max-age=0");
  res.set("X-Robots-Tag", "noindex, nofollow");
}

/** @param {number} status @param {string} code @param {string} message */
function httpError(status, code, message) {
  const error = /** @type {Error & {status:number,code:string}} */ (
    new Error(message || code)
  );
  error.status = status;
  error.code = code;
  return error;
}

const MACRO_NUMBER_FIELDS = [
  "sq",
  "base_score",
  "supply_block_penalty",
  "race_penalty",
  "float_penalty",
  "injects_actual",
  "injects_expected",
  "chronos_actual",
  "chronos_expected",
  "mules_actual",
  "mules_expected",
  "supply_blocked_seconds",
  "mineral_float_spikes",
  "creep_tumors_queen",
  "creep_tumors_spread",
  "creep_tumors_total",
  "creep_tumors_lost",
  "first_tumor_sec",
];

const STATS_NUMBER_FIELDS = [
  "time",
  "food_used",
  "food_made",
  "food_workers",
  "minerals_collection_rate",
  "vespene_collection_rate",
  "minerals_current",
  "vespene_current",
  "minerals_used_in_progress",
  "vespene_used_in_progress",
  "army_value",
];

module.exports = {
  buildPublicReplaysRouter,
  PUBLIC_REPLAYS_RATE_LIMIT_PER_MIN,
  _internals: {
    parseReplayListQuery,
    publicReplayItem,
    publicMacroBreakdown,
    publicBuildOrder,
    publicStreamLinks,
  },
};
