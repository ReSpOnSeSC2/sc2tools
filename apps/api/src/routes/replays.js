"use strict";

const express = require("express");
const { parseFilters } = require("../util/parseQuery");
const { isPublicReplayReference } = require("../util/publicReplayReference");

// enrich=none answers without VOD, channel or SC2Pulse lookups (ADR 0069, 2026-11-01 amendment).
const NO_VODS = Object.freeze({ configuredPlatforms: [], linksByGameId: Object.freeze({}) });

/**
 * Authenticated replay-library and sharing-control routes. Authentication is
 * applied per route so this router can later host the explicitly shared read
 * surface without a top-level auth middleware intercepting unrelated paths.
 *
 * @param {{
 *   replayLibrary: import('../services/replayLibrary').ReplayLibraryService,
 *   users: import('../services/types').UsersService,
 *   gameVods: {resolveForGames(userId:string, games:object[], opts?:object): Promise<any>},
 *   auth: import('express').RequestHandler,
 * }} deps
 */
function buildReplaysRouter(deps) {
  if (!deps?.replayLibrary || !deps?.users || !deps?.gameVods) {
    throw new Error("buildReplaysRouter: replay services required");
  }
  if (typeof deps.auth !== "function") {
    throw new Error("buildReplaysRouter: auth required");
  }
  const router = express.Router();

  router.get("/me/replay-sharing", deps.auth, async (req, res, next) => {
    try {
      const auth = requireAuth(req);
      const state = await deps.users.getReplaySharing(auth.userId);
      privateNoStore(res);
      res.json(state);
    } catch (err) {
      next(err);
    }
  });

  router.put("/me/replay-sharing", deps.auth, async (req, res, next) => {
    try {
      const auth = requireAuth(req);
      const body = req.body;
      if (
        !body
        || typeof body !== "object"
        || Array.isArray(body)
        || Object.keys(body).length !== 1
        || typeof body.enabled !== "boolean"
      ) {
        throw httpError(400, "invalid_replay_sharing", "Body must be { enabled: boolean }.");
      }
      const state = await deps.users.setReplaySharing(auth.userId, body.enabled);
      privateNoStore(res);
      res.json(state);
    } catch (err) {
      next(err);
    }
  });

  router.post("/me/replay-sharing/reference", deps.auth, replaySharingReference(deps.replayLibrary));

  router.get("/replays", deps.auth, async (req, res, next) => {
    try {
      const auth = requireAuth(req);
      const query = parseReplayListQuery(req.query), mode = replayListMode(req.query);
      const [page, profile] = await Promise.all([
        listReplays(deps.replayLibrary, auth.userId, query, mode),
        deps.users.getProfile(auth.userId),
      ]);
      const vods = mode.enrich === "none" ? NO_VODS : await resolveVods(deps.gameVods, auth.userId, page.sourceGames);
      privateNoStore(res);
      res.json({
        profile: playerProfile(
          auth.userId,
          profile && typeof profile === "object" ? profile.displayName : null,
        ),
        // Explicit response assembly keeps sourceGames (toon/Pulse VOD
        // matching inputs) server-only.
        items: page.items.map((item) => ({
          ...item,
          streams: linksFor(vods, item.gameId),
        })),
        page: pageEnvelope(page),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** Resolve a game's archive reference for its owner before copying or
 * enabling publication. The same detector-view eligibility check guards
 * the public card. The reference itself does not grant access.
 * @param {Pick<import('../services/replayLibrary').ReplayLibraryService, 'getDetail'>} library
 * @returns {import('express').RequestHandler}
 */
function replaySharingReference(library) {
  return async (req, res, next) => {
    privateNoStore(res);
    try {
      const auth = requireAuth(req);
      const { gameId } = req.body ?? {};
      if (typeof gameId !== "string" || !gameId.trim() || gameId.length > 200
        || /[\u0000-\u001f\u007f]/u.test(gameId) || Object.keys(req.body).length !== 1) {
        throw httpError(400, "invalid_replay_sharing_reference", "Choose a game from your replay library.");
      }
      const detail = await library.getDetail(auth.userId, gameId, { view: "detector" });
      const reference = detail?.game.publicReference;
      if (!isPublicReplayReference(reference)) {
        throw httpError(404, "replay_not_shareable", "This game is unavailable in your public replay archive.");
      }
      res.json({ reference });
    } catch (err) {
      next(err);
    }
  };
}

/** @param {Record<string, unknown>} raw */
function parseReplayListQuery(raw) {
  const query = raw && typeof raw === "object" ? raw : {};
  return {
    filters: {
      ...parseFilters(query),
      ...(query.include_excluded === "1" ? { includeExcluded: true } : {}),
      ...(query.include_excluded === "1" && query.excluded_only === "1" ? { excludedOnly: true } : {}),
    },
    limit: firstQueryValue(query.limit),
    cursor: firstQueryValue(query.cursor),
    search: firstQueryValue(query.search),
    result: firstQueryValue(query.result),
    matchup: firstQueryValue(query.matchup),
    sort: firstQueryValue(query.sort),
    // The owner's own list may match private note text; the public
    // archive route has its own parser and never sets this.
    searchNotes: true,
    ...parseReviewQueueQuery(query),
  };
}

/**
 * The owner-only review queue filters, allowlisted: ``review=todo|done``,
 * ``review_tag=<tag>`` and ``notes=has``. Anything else is ignored.
 * Example: parseReviewQueueQuery({ review: "todo", notes: "has" })
 *   → { review: "todo", hasNotes: true }
 * @param {Record<string, unknown>} raw
 * @returns {{review?: "todo"|"done", reviewTag?: string, hasNotes?: true}}
 */
function parseReviewQueueQuery(raw) {
  const query = raw && typeof raw === "object" ? raw : {};
  /** @type {{review?: "todo"|"done", reviewTag?: string, hasNotes?: true}} */
  const out = {};
  const review = firstQueryValue(query.review);
  if (review === "todo" || review === "done") out.review = review;
  const tag = firstQueryValue(query.review_tag);
  if (typeof tag === "string" && tag.trim() && tag.length <= 48) out.reviewTag = tag.trim();
  if (firstQueryValue(query.notes) === "has") out.hasNotes = true;
  return out;
}

/**
 * Quick search's read options. Only the exact strings opt in; anything else,
 * arrays included, keeps the route's default behaviour.
 * Example: replayListMode({ window: "recent", enrich: "none" }).
 * @param {Record<string, unknown>} raw
 * @returns {{window: "recent"|"all", enrich: "none"|"default"}}
 */
function replayListMode(raw) {
  const query = raw && typeof raw === "object" ? raw : {};
  return {
    window: query.window === "recent" ? "recent" : "all",
    enrich: query.enrich === "none" ? "none" : "default",
  };
}

/**
 * window=recent reads one newest-first page of the latest games. Its failures
 * become fixed errors: a database message can echo the search filter.
 * @param {import('../services/replayLibrary').ReplayLibraryService} replayLibrary
 * @param {string} userId
 * @param {ReturnType<typeof parseReplayListQuery>} query
 * @param {ReturnType<typeof replayListMode>} mode
 */
async function listReplays(replayLibrary, userId, query, mode) {
  if (mode.window !== "recent") return replayLibrary.list(userId, query);
  if (query.cursor !== undefined || query.sort === "date_asc") {
    throw httpError(400, "bad_request", "window=recent reads one newest-first page.");
  }
  try {
    return await replayLibrary.listRecent(userId, query);
  } catch (err) {
    const failure = /** @type {{code?: unknown, codeName?: unknown}} */ (err || {});
    const deadline = failure.code === 50 || failure.codeName === "MaxTimeMSExpired";
    throw httpError(503, deadline ? "replay_search_deadline" : "replay_search_unavailable", "Recent games are unavailable.");
  }
}

/** @param {unknown} value */
function firstQueryValue(value) {
  if (typeof value === "string" || typeof value === "number") return value;
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === "string" || typeof first === "number"
      ? first
      : undefined;
  }
  return undefined;
}

/**
 * VOD enrichment is decorative. Provider failure must not make the user's
 * replay archive unavailable.
 *
 * @param {any} gameVods
 * @param {string} userId
 * @param {unknown} sourceGames
 */
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

/** @param {string} handle @param {unknown} rawName */
function playerProfile(handle, rawName) {
  const displayName = typeof rawName === "string" && rawName.trim()
    ? rawName.trim().slice(0, 80)
    : "SC2 Player";
  return { handle, displayName };
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

/** @param {import('express').Request} req */
function requireAuth(req) {
  if (req.auth && typeof req.auth.userId === "string" && req.auth.userId) {
    return req.auth;
  }
  throw httpError(401, "auth_required", "Authentication required.");
}

/** @param {number} status @param {string} code @param {string} message */
function httpError(status, code, message) {
  const err = /** @type {Error & {status:number,code:string}} */ (
    new Error(message || code)
  );
  err.status = status;
  err.code = code;
  return err;
}

/** @param {import('express').Response} res */
function privateNoStore(res) {
  res.set("Cache-Control", "private, no-store");
}

module.exports = {
  buildReplaysRouter,
  parseReviewQueueQuery,
  _internals: {
    parseReplayListQuery,
    replayListMode,
    pageEnvelope,
    linksFor,
  },
};
