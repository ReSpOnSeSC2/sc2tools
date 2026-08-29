"use strict";

const express = require("express");
const { parseFilters } = require("../util/parseQuery");

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

  router.get("/replays", deps.auth, async (req, res, next) => {
    try {
      const auth = requireAuth(req);
      const query = parseReplayListQuery(req.query);
      const [page, profile] = await Promise.all([
        deps.replayLibrary.list(auth.userId, query),
        deps.users.getProfile(auth.userId),
      ]);
      const vods = await resolveVods(
        deps.gameVods,
        auth.userId,
        page.sourceGames,
      );
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
  _internals: {
    parseReplayListQuery,
    pageEnvelope,
    linksFor,
  },
};
