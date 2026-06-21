"use strict";

const express = require("express");
const { validateCustomBuild } = require("../validation/customBuild");
const { evaluateRules } = require("../services/buildRulesEvaluator");
const { parseFilters } = require("../util/parseQuery");

const PREVIEW_TRUNCATION_LIMIT = 200;
const PREVIEW_GAME_SCAN_CAP = 600;
const PHASE_CACHE_TTL_MS = 60 * 1000;

/**
 * Permissive matchup filter mirroring the local SPA semantics: a game
 * is in-scope when the requested vsRace is "Any"/missing, when the
 * stored opponent race matches, when no opponent race is recorded
 * (legacy imports), or when the build bucket name's prefix encodes the
 * matchup (e.g. "PvT — …"). Same for myRace.
 *
 * Strict matching here was the cause of the editor showing
 * "0 games scanned" when the user clearly had games — agents that
 * predate the race-normalisation pass leave myRace/opponent.race
 * blank.
 *
 * @param {{myRace?: string|null, oppRace?: string|null, myBuild?: string|null}} g
 * @param {string|undefined} race
 * @param {string|undefined} vsRace
 * @returns {boolean}
 */
function gameMatchesMatchup(g, race, vsRace) {
  return raceMatches(g.myRace, race, g.myBuild, 0)
    && raceMatches(g.oppRace, vsRace, g.myBuild, 2);
}

/**
 * @param {string|null|undefined} actual
 * @param {string|undefined} requested
 * @param {string|null|undefined} buildName
 * @param {number} bucketPos  0 = my-race char of "PvT" bucket, 2 = vs-race char
 * @returns {boolean}
 */
/**
 * Coerce a query-string ``perspective`` value into the union the
 * service expects, or ``undefined`` so the service falls back to the
 * saved build's stored perspective. Unknown values silently fall
 * through to the default — the client UI sends only the two valid
 * values, so a bad input is almost always a stale link.
 *
 * @param {unknown} raw
 * @returns {"you"|"opponent"|undefined}
 */
function pickPerspective(raw) {
  if (raw === "opponent") return "opponent";
  if (raw === "you") return "you";
  return undefined;
}

function raceMatches(actual, requested, buildName, bucketPos) {
  if (!requested || requested === "Any") return true;
  if (!actual) {
    if (typeof buildName === "string" && /^[PTZ]v[PTZ]/.test(buildName)) {
      const letter = requested.charAt(0).toUpperCase();
      if (buildName.charAt(bucketPos) === letter) return true;
    }
    // Legacy import without race info — be permissive so the user
    // doesn't see "0 games scanned" on a brand new build.
    return true;
  }
  const a = actual.charAt(0).toUpperCase();
  const r = requested.charAt(0).toUpperCase();
  return a === r;
}

/**
 * /v1/custom-builds — user's private build library.
 *
 * @param {{
 *   customBuilds: import('../services/types').CustomBuildsService,
 *   perGame?: import('../services/types').PerGameComputeService,
 *   community?: import('../services/community').CommunityService,
 *   auth: import('express').RequestHandler,
 * }} deps
 */
function buildCustomBuildsRouter(deps) {
  const router = express.Router();
  router.use(deps.auth);

  // In-process cache for the phase-aware compositions / transitions
  // payloads. Both endpoints are heavy: every request re-fetches the
  // full game set + macroBreakdown blobs, then runs the classifier
  // per game. Scouting / dossier views re-poll on every panel mount,
  // so a tight 60s TTL turns the typical user's "tab three panes in a
  // row" interaction into a single Mongo scan. Keyed on
  // (userId, slug, latestGameDate) so a newly-ingested game blows the
  // entry without waiting for the TTL; explicit ``bust`` is called
  // from the reclassify endpoint where the matched set may shift.
  /** @type {Map<string, {expires: number, value: any}>} */
  const phaseCache = new Map();
  function phaseCacheKey(userId, slug, latestGameMs, kind, perspective, scope, filtersKey) {
    // ``perspective`` is included so the comparison view's two
    // queries don't poison each other's cache slot — left ("you")
    // and right ("opponent") off the same slug must compute
    // independently. ``scope`` is the optional opponent-strategy
    // axis the BuildVsStrategyComparison drill-down passes through —
    // unscoped (BuildDossier) and cell-scoped (drill-down) payloads
    // for the same slug must NOT alias. ``filtersKey`` serialises the
    // global filter bar so timeframe / race / map / mmr / region
    // changes don't alias either.
    return `${userId}|${slug}|${latestGameMs}|${kind}|${perspective}|${scope || ""}|${filtersKey || ""}`;
  }
  /**
   * Stable string key for a parsed filter object. Sorted entries so two
   * URLs with the same filters in a different order share a cache slot.
   * Dates serialise to ms so the value is a single primitive per key.
   *
   * @param {Record<string, any>} filters
   * @returns {string}
   */
  function filtersCacheKey(filters) {
    if (!filters) return "";
    const entries = Object.entries(filters)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => {
        if (v instanceof Date) return [k, v.getTime()];
        if (Array.isArray(v)) return [k, v.slice().sort().join(",")];
        return [k, v];
      })
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return entries.map(([k, v]) => `${k}=${v}`).join("&");
  }
  function phaseCacheGet(key) {
    const hit = phaseCache.get(key);
    if (!hit) return null;
    if (hit.expires <= Date.now()) {
      phaseCache.delete(key);
      return null;
    }
    return hit.value;
  }
  function phaseCacheSet(key, value) {
    phaseCache.set(key, { value, expires: Date.now() + PHASE_CACHE_TTL_MS });
  }
  function phaseCacheBust(userId, slug) {
    const prefix = `${userId}|${slug}|`;
    for (const key of phaseCache.keys()) {
      if (key.startsWith(prefix)) phaseCache.delete(key);
    }
  }
  function latestGameMs(userId) {
    // Cheap probe so a fresh upload invalidates the cache key without
    // waiting for the TTL.
    return deps.customBuilds.latestGameDateMs(userId);
  }

  /**
   * POST /v1/custom-builds/preview-matches
   *
   * Body: {
   *   rules: BuildRule[],
   *   race?: string,           — saver's own race
   *   vsRace?: string,         — opposing race
   *   perspective?: 'you'|'opponent',
   *                            — which side of each replay to scan
   * }
   *
   * Scans the signed-in user's games (capped at PREVIEW_GAME_SCAN_CAP)
   * and returns which games match all rules vs which fail exactly one.
   * Used by the live preview band in the BuildEditor modal.
   *
   * Perspective handling: when "opponent", we evaluate rules against
   * `oppBuildLog`. The myRace / vsRace gate flips accordingly so the
   * filter still asks "is this game's matchup the one this build is
   * for", regardless of which side authored the build.
   */
  router.post("/custom-builds/preview-matches", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      if (!deps.perGame) {
        res.status(503).json({ error: { code: "preview_unavailable" } });
        return;
      }
      const body = req.body || {};
      const rawRules = Array.isArray(body.rules) ? body.rules : [];
      // Drop placeholder rules (empty name) so the user sees a useful
      // preview while typing instead of zero matches + a 500.
      const rules = rawRules.filter(
        (r) =>
          r &&
          typeof r === "object" &&
          typeof r.name === "string" &&
          r.name.trim().length > 0,
      );
      if (rules.length === 0) {
        res.json({
          matches: [],
          almost_matches: [],
          scanned_games: 0,
          truncated: false,
        });
        return;
      }
      const race = typeof body.race === "string" ? body.race : undefined;
      const vsRace = typeof body.vsRace === "string" ? body.vsRace : undefined;
      const perspective = body.perspective === "opponent" ? "opponent" : "you";
      const games = await deps.perGame.listForRulePreview(auth.userId, {
        limit: PREVIEW_GAME_SCAN_CAP,
      });
      /** @type {Array<{game_id: string, build_name: string, map: string|null, result: string|null, date: Date|null}>} */
      const matches = [];
      /** @type {Array<{game_id: string, build_name: string, failed_rule_name?: string, failed_reason: string, map: string|null, result: string|null, date: Date|null}>} */
      const almostMatches = [];
      let evalErrors = 0;
      let scanned = 0;
      for (const g of games) {
        // Build "what race is on each side of this game" relative to
        // the build's perspective, then ask `gameMatchesMatchup` whether
        // the rule's race + vs match.
        const sideRace = perspective === "opponent" ? g.oppRace : g.myRace;
        const otherRace = perspective === "opponent" ? g.myRace : g.oppRace;
        if (
          !gameMatchesMatchup(
            { myRace: sideRace, oppRace: otherRace, myBuild: g.myBuild },
            race,
            vsRace,
          )
        ) {
          continue;
        }
        const events =
          perspective === "opponent" ? g.oppEvents || [] : g.events || [];
        if (events.length === 0) continue;
        scanned++;
        let evalRes;
        try {
          evalRes = evaluateRules(rules, events);
        } catch (e) {
          // One bad game shouldn't fail the whole preview. Log + skip.
          evalErrors++;
          if (req.log) {
            req.log.warn(
              { err: e, gameId: g && g.gameId },
              "preview_eval_failed",
            );
          }
          continue;
        }
        const summary = {
          game_id: g.gameId,
          build_name: g.myBuild || `${g.myRace || "?"} vs ${g.oppRace || "?"}`,
          map: g.map,
          result: g.result,
          date: g.date,
        };
        if (evalRes.pass) {
          if (matches.length < PREVIEW_TRUNCATION_LIMIT) matches.push(summary);
          continue;
        }
        if (
          evalRes.almost &&
          almostMatches.length < PREVIEW_TRUNCATION_LIMIT
        ) {
          almostMatches.push({
            ...summary,
            failed_rule_name: evalRes.failedRule
              ? evalRes.failedRule.name
              : undefined,
            failed_reason: evalRes.failedReason || "rule failed",
          });
        }
      }
      res.json({
        matches,
        almost_matches: almostMatches,
        scanned_games: scanned,
        truncated:
          matches.length >= PREVIEW_TRUNCATION_LIMIT ||
          almostMatches.length >= PREVIEW_TRUNCATION_LIMIT,
        eval_errors: evalErrors > 0 ? evalErrors : undefined,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/custom-builds", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const items = await deps.customBuilds.list(auth.userId);
      res.json({ items });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /v1/custom-builds/stats
   *
   * Aggregate W/L/winRate per saved build by re-running each build's
   * rules against the user's recent games. Lets the BuildsLibrary card
   * grid show real numbers immediately after save, instead of waiting
   * for the agent to reclassify and tag games with `myBuild`.
   */
  router.get("/custom-builds/stats", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      if (!deps.perGame) {
        res.status(503).json({ error: { code: "stats_unavailable" } });
        return;
      }
      const items = await deps.customBuilds.evaluateAllStats(auth.userId);
      res.json(items);
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /v1/custom-builds/:slug/matches
   *
   * Per-build detail mirroring /v1/builds/:name shape. Same totals/
   * byMatchup/byMap/byStrategy/recent fields, but driven by the saved
   * rules so newly-saved builds show their matched games right away.
   */
  router.get("/custom-builds/:slug/matches", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      if (!deps.perGame) {
        res.status(503).json({ error: { code: "stats_unavailable" } });
        return;
      }
      const result = await deps.customBuilds.evaluateBuild(
        auth.userId,
        String(req.params.slug),
      );
      if (!result) {
        res.status(404).json({ error: { code: "not_found" } });
        return;
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /v1/custom-builds/:slug/compositions
   *
   * Per-phase signature aggregator for the scouting widget. Returns
   * the lighter payload (no transitions) so the panel can request it
   * independently of the heavier Sankey.
   */
  router.get("/custom-builds/:slug/compositions", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      if (!deps.perGame) {
        res.status(503).json({ error: { code: "stats_unavailable" } });
        return;
      }
      const slug = String(req.params.slug);
      const perspective = pickPerspective(req.query && req.query.perspective);
      // Optional ``strategy`` query param scopes the saved-build
      // matched set to one cell of the build × strategy matrix. The
      // drill-down passes it through so the left column describes the
      // SAME game set as the cell the user clicked.
      const strategyName =
        req.query && typeof req.query.strategy === "string" && req.query.strategy
          ? String(req.query.strategy)
          : null;
      const filters = parseFilters(req.query);
      const latest = await latestGameMs(auth.userId);
      const key = phaseCacheKey(
        auth.userId,
        slug,
        latest,
        "compositions",
        perspective || "default",
        strategyName ? `s:${strategyName}` : "",
        filtersCacheKey(filters),
      );
      const cached = phaseCacheGet(key);
      if (cached) {
        res.json(cached);
        return;
      }
      const result = await deps.customBuilds.evaluateBuildPhases(
        auth.userId,
        slug,
        { includeTransitions: false, perspective, strategyName, filters },
      );
      if (!result) {
        res.status(404).json({ error: { code: "not_found" } });
        return;
      }
      phaseCacheSet(key, result);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /v1/custom-builds/:slug/transitions
   *
   * Sankey-shaped routing payload for the BuildDetail transitions
   * tab. Computed from the same matched-game set as ``compositions``
   * but only the ``transitions`` half is returned so the heavier
   * payload can be requested independently of the compositions one.
   */
  router.get("/custom-builds/:slug/transitions", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      if (!deps.perGame) {
        res.status(503).json({ error: { code: "stats_unavailable" } });
        return;
      }
      const slug = String(req.params.slug);
      const perspective = pickPerspective(req.query && req.query.perspective);
      const latest = await latestGameMs(auth.userId);
      const key = phaseCacheKey(
        auth.userId, slug, latest, "transitions", perspective || "default",
      );
      const cached = phaseCacheGet(key);
      if (cached) {
        res.json(cached);
        return;
      }
      const result = await deps.customBuilds.evaluateBuildPhases(
        auth.userId,
        slug,
        { includeTransitions: true, perspective },
      );
      if (!result) {
        res.status(404).json({ error: { code: "not_found" } });
        return;
      }
      const payload = {
        slug: result.slug,
        name: result.name,
        perspective: result.perspective,
        transitions: result.transitions,
      };
      phaseCacheSet(key, payload);
      res.json(payload);
    } catch (err) {
      next(err);
    }
  });

  router.get("/custom-builds/:slug", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const item = await deps.customBuilds.get(
        auth.userId,
        String(req.params.slug),
      );
      if (!item) {
        res.status(404).json({ error: { code: "not_found" } });
        return;
      }
      res.json(item);
    } catch (err) {
      next(err);
    }
  });

  router.put("/custom-builds/:slug", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const slug = String(req.params.slug);
      const validation = validateCustomBuild({ ...req.body, slug });
      if (!validation.valid) {
        res.status(400).json({
          error: { code: "bad_request", details: validation.errors },
        });
        return;
      }
      await deps.customBuilds.upsert(
        auth.userId,
        /** @type {any} */ (validation.value),
      );
      // Cloud-side reclassify so `myBuild` on stored games stays in sync
      // with the saved rules. Without this, the BuildDetail view (live
      // rule eval) and the opponent profile / Recent games table (reads
      // stored `myBuild`) drift apart — the user sees their build matched
      // 31 games here but the recent-games column still shows the
      // agent's old auto-classifier label. Skipped when perGame isn't
      // wired (e.g. tests bootstrapping without it) so the save itself
      // never fails on a missing dependency.
      let reclassify = null;
      if (deps.perGame) {
        try {
          reclassify = await deps.customBuilds.reclassify(auth.userId, slug, {
            replace: true,
          });
        } catch (e) {
          if (req.log) {
            req.log.warn(
              { err: e, slug, userId: auth.userId },
              "custom_build_upsert_reclassify_failed",
            );
          }
        }
      }
      // Honour the build's community-share state on every save. This is
      // what makes the editor's "Share with community" toggle (and the
      // sheet's "Build is public" toggle) actually do something — without
      // it the flag was stored on the doc and silently ignored, so a
      // build "shared" from a replay never reached the community tab.
      //
      // `isPublic` on the private doc is the single source of truth and
      // is kept in lock-step with the community collection here. A
      // publish hiccup is reported in the response but never fails the
      // save itself (the private build is already persisted).
      const community = await applyShareState(deps, auth.userId, slug, {
        wantPublic: desiredShareState(req.body),
        title: validation.value.name,
        description: validation.value.description,
        log: req.log,
      });
      res.status(200).json({ ok: true, reclassify, community });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/custom-builds/:slug", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      await deps.customBuilds.softDelete(auth.userId, String(req.params.slug));
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /v1/custom-builds/:slug/reclassify
   *
   * Re-evaluate the saved build's rules against every stored game and
   * write `myBuild = build.name` on each match (and clear the tag from
   * games that previously matched but no longer do, unless the body
   * sets `replace: false`). Returns counts so the UI can show
   * "Tagged 12, cleared 0".
   *
   * This is the "no-agent reclassify" path: the cloud already has the
   * parsed buildLog/oppBuildLog for every uploaded game, so this is a
   * single Mongo updateMany loop — not a round-trip to the desktop
   * agent.
   */
  router.post("/custom-builds/:slug/reclassify", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      if (!deps.perGame) {
        res.status(503).json({ error: { code: "reclassify_unavailable" } });
        return;
      }
      const body = req.body || {};
      const slug = String(req.params.slug);
      const result = await deps.customBuilds.reclassify(
        auth.userId,
        slug,
        { replace: body.replace !== false },
      );
      if (!result) {
        res.status(404).json({ error: { code: "not_found" } });
        return;
      }
      // Matched-set may have shifted — drop any cached compositions /
      // transitions for this build so the next read recomputes.
      phaseCacheBust(auth.userId, slug);
      res.json({ ok: true, ...result });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /v1/custom-builds/reclassify-all
   *
   * Re-evaluate every saved build against every stored game in one
   * pass. Useful after editing several builds at once, or after the
   * user adds many new replays. First-write-wins on conflicts, ranked
   * by the build's most recent edit timestamp.
   */
  router.post("/custom-builds/reclassify-all", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      if (!deps.perGame) {
        res.status(503).json({ error: { code: "reclassify_unavailable" } });
        return;
      }
      const body = req.body || {};
      const out = await deps.customBuilds.reclassifyAll(auth.userId, {
        clearUnmatched: !!body.clearUnmatched,
      });
      res.json({ ok: true, ...out });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/**
 * Read the caller's intended community-share state from a save body.
 * Accepts either `shareWithCommunity` (the rich BuildEditor toggle) or
 * `isPublic` (the BuildEditorSheet toggle) — they're two UIs for the
 * same concept. Returns `undefined` when neither flag is present, so
 * saves from callers that don't manage sharing (e.g. the
 * "Save to my library" community fork) never accidentally publish or
 * unpublish a build.
 *
 * @param {Record<string, any> | undefined} body
 * @returns {boolean | undefined}
 */
function desiredShareState(body) {
  if (!body || typeof body !== "object") return undefined;
  if (typeof body.shareWithCommunity === "boolean") {
    return body.shareWithCommunity;
  }
  if (typeof body.isPublic === "boolean") return body.isPublic;
  return undefined;
}

/**
 * Reconcile the community collection with the desired share state
 * captured at save time. The community service mirrors the result back
 * onto the private doc's `isPublic` flag, so this only orchestrates and
 * reports. Resilient by design: any failure is logged and returned as
 * `{ error }` but never thrown, because the private save has already
 * succeeded and must not be rolled back over a publish glitch.
 *
 * @param {{
 *   community?: import('../services/community').CommunityService,
 * }} deps
 * @param {string} userId
 * @param {string} slug
 * @param {{
 *   wantPublic: boolean | undefined,
 *   title?: string,
 *   description?: string,
 *   log?: { warn: Function } | undefined,
 * }} opts
 * @returns {Promise<
 *   | null
 *   | { action: 'published' | 'updated' | 'unpublished', slug?: string }
 *   | { error: string }
 * >}
 */
async function applyShareState(deps, userId, slug, opts) {
  // No community service wired (e.g. unit tests build the router in
  // isolation) or no share flag in the body → nothing to do.
  if (!deps.community || opts.wantPublic === undefined) return null;
  try {
    if (opts.wantPublic) {
      const { slug: publicSlug, created } = await deps.community.publish(
        userId,
        slug,
        { title: opts.title, description: opts.description },
      );
      return { action: created ? "published" : "updated", slug: publicSlug };
    }
    await deps.community.unpublishBySource(userId, slug);
    return { action: "unpublished" };
  } catch (e) {
    if (opts.log) {
      opts.log.warn(
        { err: e, slug, userId, wantPublic: opts.wantPublic },
        "custom_build_share_state_failed",
      );
    }
    const message =
      e && typeof e === "object" && "message" in e
        ? String(/** @type {any} */ (e).message)
        : "share_failed";
    return { error: message };
  }
}

module.exports = { buildCustomBuildsRouter };
