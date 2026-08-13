"use strict";

const express = require("express");
const { validateCustomBuild } = require("../validation/customBuild");
const { evaluateRules } = require("../services/buildRulesEvaluator");
const { parseFilters } = require("../util/parseQuery");

const PREVIEW_TRUNCATION_LIMIT = 200;
const PREVIEW_GAME_SCAN_CAP = 600;
const PREVIEW_PAGE_SIZE = 50;
const PREVIEW_MAX_CONCURRENT = 2;
const PREVIEW_MAX_WAITERS = 4;
const PHASE_CACHE_TTL_MS = 60 * 1000;
const PHASE_CACHE_MAX_ENTRIES = 32;
const PHASE_MAX_CONCURRENT = 1;
const PHASE_MAX_WAITERS = 8;
const PHASE_RETRY_AFTER_SEC = 2;
const PHASE_BUSY = Symbol("phase_busy");
const PHASE_CANCELLED = Symbol("phase_cancelled");

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

/**
 * @param {string|null|undefined} actual
 * @param {string|undefined} requested
 * @param {string|null|undefined} buildName
 * @param {number} bucketPos  0 = my-race char of "PvT" bucket, 2 = vs-race char
 * @returns {boolean}
 */
function raceMatches(actual, requested, buildName, bucketPos) {
  if (!requested || requested === "Any") return true;
  if (!actual) {
    if (typeof buildName === "string" && /^[PTZ]v[PTZ]/.test(buildName)) {
      const letter = requested.charAt(0).toUpperCase();
      if (buildName.charAt(bucketPos) === letter) return true;
    }
    // Without race metadata or a trustworthy PvX bucket prefix, the replay
    // cannot be assigned to a matchup safely. Keep preview and durable
    // classification aligned instead of showing a match that cannot persist.
    return false;
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

  // Custom-build previews are detail-store reads, not cheap metadata calls.
  // Bound them independently of replay ingest and supersede an older preview
  // from the same editor/user when a new debounce request arrives.
  let activePreviews = 0;
  /** @type {Array<{signal: AbortSignal, resolve: (release: (() => void) | null) => void}>} */
  const previewWaiters = [];
  /** @type {Map<string, AbortController>} */
  const previewByUser = new Map();
  /**
   * @param {AbortSignal} signal
   * @returns {Promise<(() => void) | null>}
   */
  function acquirePreviewSlot(signal) {
    if (signal.aborted) return Promise.resolve(null);
    if (activePreviews < PREVIEW_MAX_CONCURRENT) {
      activePreviews += 1;
      return Promise.resolve(releasePreviewSlot);
    }
    if (previewWaiters.length >= PREVIEW_MAX_WAITERS) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      let settled = false;
      /** @type {() => void} */
      let onAbort = () => {};
      /** @param {(() => void) | null} release */
      const finish = (release) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(release);
      };
      const waiter = { signal, resolve: finish };
      onAbort = () => {
        const index = previewWaiters.indexOf(waiter);
        if (index >= 0) previewWaiters.splice(index, 1);
        finish(null);
      };
      previewWaiters.push(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
      // Abort may race between the initial check and listener registration.
      if (signal.aborted) onAbort();
    });
  }
  function releasePreviewSlot() {
    activePreviews = Math.max(0, activePreviews - 1);
    while (previewWaiters.length > 0) {
      const waiter = previewWaiters.shift();
      if (!waiter || waiter.signal.aborted) continue;
      activePreviews += 1;
      waiter.resolve(releasePreviewSlot);
      break;
    }
  }

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
  /**
   * @type {Map<string, {
   *   controller: AbortController,
   *   promise: Promise<any | typeof PHASE_BUSY | typeof PHASE_CANCELLED>,
   *   subscribers: number,
   *   settled: boolean,
   * }>}
   */
  const phaseInFlight = new Map();
  let activePhaseComputations = 0;
  /** @type {Array<{
   *   signal: AbortSignal,
   *   resolve: (release: (() => void) | null) => void,
   * }>} */
  const phaseWaiters = [];
  /**
   * @param {string} userId
   * @param {string} slug
   * @param {number} latestGameMs
   * @param {string} kind
   * @param {string} perspective
   * @param {string} [scope]
   * @param {string} [filtersKey]
   */
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
  /** @param {string} key */
  function phaseCacheGet(key) {
    const hit = phaseCache.get(key);
    if (!hit) return null;
    if (hit.expires <= Date.now()) {
      phaseCache.delete(key);
      return null;
    }
    // Map insertion order doubles as a tiny LRU. A frequently-read dossier
    // stays resident while one-off filter combinations age out first.
    phaseCache.delete(key);
    phaseCache.set(key, hit);
    return hit.value;
  }
  /** @param {string} key @param {unknown} value */
  function phaseCacheSet(key, value) {
    const now = Date.now();
    for (const [cachedKey, entry] of phaseCache) {
      if (entry.expires <= now) phaseCache.delete(cachedKey);
    }
    phaseCache.delete(key);
    phaseCache.set(key, { value, expires: now + PHASE_CACHE_TTL_MS });
    while (phaseCache.size > PHASE_CACHE_MAX_ENTRIES) {
      const oldest = phaseCache.keys().next().value;
      if (oldest === undefined) break;
      phaseCache.delete(oldest);
    }
  }
  /** @param {string} userId @param {string} slug */
  function phaseCacheBust(userId, slug) {
    const prefix = `${userId}|${slug}|`;
    for (const key of phaseCache.keys()) {
      if (key.startsWith(prefix)) phaseCache.delete(key);
    }
    const matchesKey = `matches|${userId}|${slug}`;
    const statsKey = `stats|${userId}`;
    for (const [key, entry] of phaseInFlight) {
      if (
        key.startsWith(prefix)
        || key === matchesKey
        || key === statsKey
      ) {
        entry.controller.abort();
        phaseInFlight.delete(key);
      }
    }
  }
  /** @param {string} userId */
  function latestGameMs(userId) {
    // Cheap probe so a fresh upload invalidates the cache key without
    // waiting for the TTL.
    return deps.customBuilds.latestGameDateMs(userId);
  }

  /**
   * @param {AbortSignal} signal
   * @returns {Promise<(() => void) | null>}
   */
  function acquirePhaseSlot(signal) {
    if (signal.aborted) return Promise.resolve(null);
    if (activePhaseComputations < PHASE_MAX_CONCURRENT) {
      activePhaseComputations += 1;
      return Promise.resolve(releasePhaseSlot);
    }
    if (phaseWaiters.length >= PHASE_MAX_WAITERS) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      let settled = false;
      /** @type {() => void} */
      let onAbort = () => {};
      /** @param {(() => void) | null} release */
      const finish = (release) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(release);
      };
      const waiter = { signal, resolve: finish };
      onAbort = () => {
        const index = phaseWaiters.indexOf(waiter);
        if (index >= 0) phaseWaiters.splice(index, 1);
        finish(null);
      };
      phaseWaiters.push(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  function releasePhaseSlot() {
    activePhaseComputations = Math.max(0, activePhaseComputations - 1);
    while (phaseWaiters.length > 0) {
      const next = phaseWaiters.shift();
      if (!next || next.signal.aborted) continue;
      activePhaseComputations += 1;
      next.resolve(releasePhaseSlot);
      break;
    }
  }

  /**
   * Share identical phase work, while admitting distinct scans through one
   * process-wide lane for this router. The small waiter cap prevents a burst
   * of unique filters from becoming an unbounded queue of retained requests.
   * @param {string} key
   * @param {(signal: AbortSignal) => Promise<any>} compute
   * @param {AbortSignal} subscriberSignal
   * @returns {Promise<any | typeof PHASE_BUSY | typeof PHASE_CANCELLED>}
   */
  async function runPhaseComputation(key, compute, subscriberSignal) {
    if (subscriberSignal.aborted) return PHASE_CANCELLED;
    let entry = phaseInFlight.get(key);
    // The last subscriber may have disconnected one tick before a replacement
    // request arrived. Never attach that replacement to work whose shared
    // controller is already cancelled: an iterator may resolve with a partial
    // result instead of throwing on abort.
    if (entry && entry.controller.signal.aborted && !entry.settled) {
      if (phaseInFlight.get(key) === entry) phaseInFlight.delete(key);
      entry = undefined;
    }
    if (!entry) {
      const controller = new AbortController();
      entry = {
        controller,
        promise: Promise.resolve(PHASE_CANCELLED),
        subscribers: 0,
        settled: false,
      };
      entry.promise = (async () => {
        const release = await acquirePhaseSlot(controller.signal);
        if (!release) {
          return controller.signal.aborted ? PHASE_CANCELLED : PHASE_BUSY;
        }
        try {
          const value = await compute(controller.signal);
          return controller.signal.aborted ? PHASE_CANCELLED : value;
        } catch (error) {
          if (controller.signal.aborted) return PHASE_CANCELLED;
          throw error;
        } finally {
          release();
        }
      })();
      phaseInFlight.set(key, entry);
      const createdEntry = entry;
      const settle = () => {
        createdEntry.settled = true;
        if (phaseInFlight.get(key) === createdEntry) {
          phaseInFlight.delete(key);
        }
      };
      // Both branches consume settlement so a computation whose final
      // subscriber disconnects cannot produce an unhandled rejection.
      void entry.promise.then(settle, settle);
    }

    entry.subscribers += 1;
    let detached = false;
    /** @type {() => void} */
    let onAbort = () => {};
    const disconnected = new Promise((resolve) => {
      onAbort = () => resolve(PHASE_CANCELLED);
      subscriberSignal.addEventListener("abort", onAbort, { once: true });
      if (subscriberSignal.aborted) onAbort();
    });
    try {
      return await Promise.race([entry.promise, disconnected]);
    } finally {
      subscriberSignal.removeEventListener("abort", onAbort);
      if (!detached) {
        detached = true;
        entry.subscribers = Math.max(0, entry.subscribers - 1);
        if (entry.subscribers === 0 && !entry.settled) {
          entry.controller.abort();
        }
      }
    }
  }

  /**
   * Tie one phase subscriber to its HTTP connection. A closed tab should
   * release queued admission immediately, while a normally-finished response
   * must not cancel a shared computation after its payload is written.
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   */
  function phaseRequestAbort(req, res) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const close = () => {
      if (!res.writableEnded) abort();
    };
    req.once("aborted", abort);
    res.once("close", close);
    return {
      signal: controller.signal,
      cleanup() {
        req.removeListener("aborted", abort);
        res.removeListener("close", close);
      },
    };
  }

  /** @param {import('express').Response} res */
  function sendPhaseBusy(res) {
    res.set("Retry-After", String(PHASE_RETRY_AFTER_SEC));
    res.status(503).json({ error: { code: "phase_analysis_busy" } });
  }

  /**
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   */
  function sendPhaseCancelled(req, res) {
    if (req.destroyed || res.headersSent) return;
    res.set("Retry-After", String(PHASE_RETRY_AFTER_SEC));
    res.status(409).json({ error: { code: "analysis_invalidated" } });
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
      // ``any[]``: untrusted req.body payload — the filter below is the
      // runtime validation (object with a non-empty string ``name``).
      /** @type {any[]} */
      const rawRules = Array.isArray(body.rules) ? body.rules : [];
      if (rawRules.length > 30) {
        res.status(400).json({
          error: { code: "bad_request", details: ["rules must contain at most 30 items"] },
        });
        return;
      }
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
      const previous = previewByUser.get(auth.userId);
      if (previous) previous.abort();
      const controller = new AbortController();
      previewByUser.set(auth.userId, controller);
      req.once("aborted", () => controller.abort());
      res.once("close", () => {
        if (!res.writableEnded) controller.abort();
      });
      /** @type {(() => void) | null} */
      let release = null;
      /** @type {Array<{game_id: string, build_name: string, map: string|null, result: string|null, date: Date|null}>} */
      const matches = [];
      /** @type {Array<{game_id: string, build_name: string, failed_rule_name?: string, failed_reason: string, map: string|null, result: string|null, date: Date|null}>} */
      const almostMatches = [];
      let evalErrors = 0;
      let scanned = 0;
      let candidates = 0;
      let sampleTruncated = false;
      try {
      release = await acquirePreviewSlot(controller.signal);
      if (!release) {
        if (!req.destroyed && !res.headersSent) {
          res.status(controller.signal.aborted ? 409 : 503).json({
            error: { code: controller.signal.aborted
              ? "preview_superseded"
              : "preview_busy" },
          });
        }
        return;
      }
      let lastPageHadMore = false;
      const pages = typeof deps.perGame.iterateRulePreviewPages === "function"
        ? deps.perGame.iterateRulePreviewPages(auth.userId, {
          limit: PREVIEW_GAME_SCAN_CAP,
          pageSize: PREVIEW_PAGE_SIZE,
          perspective,
          signal: controller.signal,
          metadataFilter: (g) => {
            const sideRace = perspective === "opponent" ? g.opponent?.race : g.myRace;
            const otherRace = perspective === "opponent" ? g.myRace : g.opponent?.race;
            return gameMatchesMatchup(
              { myRace: sideRace, oppRace: otherRace, myBuild: g.myBuild },
              race,
              vsRace,
            );
          },
        })
        : legacyPreviewPages(deps.perGame, auth.userId, perspective);
      for await (const page of pages) {
        if (controller.signal.aborted) break;
        candidates += page.candidates;
        lastPageHadMore = page.hasMore;
        for (const g of page.games) {
        // Build "what race is on each side of this game" relative to
        // the build's perspective, then ask `gameMatchesMatchup` whether
        // the rule's race + vs match.
        // The paged production path applied this gate before hydration.
        // Retain it for narrow test doubles using the legacy fallback.
        const sideRace = perspective === "opponent" ? g.oppRace : g.myRace;
        const otherRace = perspective === "opponent" ? g.myRace : g.oppRace;
        if (!gameMatchesMatchup(
          { myRace: sideRace, oppRace: otherRace, myBuild: g.myBuild }, race, vsRace,
        )) continue;
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
      }
      sampleTruncated = lastPageHadMore && candidates >= PREVIEW_GAME_SCAN_CAP;
      } finally {
        if (release) release();
        if (previewByUser.get(auth.userId) === controller) {
          previewByUser.delete(auth.userId);
        }
      }
      if (controller.signal.aborted || res.headersSent) {
        if (!req.destroyed && !res.headersSent) {
          res.status(409).json({ error: { code: "preview_superseded" } });
        }
        return;
      }
      res.json({
        matches,
        almost_matches: almostMatches,
        scanned_games: scanned,
        truncated:
          sampleTruncated ||
          matches.length >= PREVIEW_TRUNCATION_LIMIT ||
          almostMatches.length >= PREVIEW_TRUNCATION_LIMIT,
        sampled_games: candidates,
        eval_errors: evalErrors > 0 ? evalErrors : undefined,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        if (!req.destroyed && !res.headersSent) {
          res.status(409).json({ error: { code: "preview_superseded" } });
        }
        return;
      }
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
      const requestAbort = phaseRequestAbort(req, res);
      let items;
      try {
        items = await runPhaseComputation(
          `stats|${auth.userId}`,
          (signal) => deps.customBuilds.evaluateAllStats(
            auth.userId,
            { signal },
          ),
          requestAbort.signal,
        );
      } finally {
        requestAbort.cleanup();
      }
      if (items === PHASE_CANCELLED) {
        sendPhaseCancelled(req, res);
        return;
      }
      if (items === PHASE_BUSY) {
        sendPhaseBusy(res);
        return;
      }
      res.json(items);
    } catch (err) {
      next(err);
    }
  });

  /** Pollable, user-scoped lifecycle for durable replay matching. */
  router.get("/custom-builds/reclassify-status", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const status = await deps.customBuilds.getReclassifyStatus(auth.userId);
      res.json(status);
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
      const slug = String(req.params.slug);
      const requestAbort = phaseRequestAbort(req, res);
      let result;
      try {
        result = await runPhaseComputation(
          `matches|${auth.userId}|${slug}`,
          (signal) => deps.customBuilds.evaluateBuild(
            auth.userId,
            slug,
            { signal },
          ),
          requestAbort.signal,
        );
      } finally {
        requestAbort.cleanup();
      }
      if (result === PHASE_CANCELLED) {
        sendPhaseCancelled(req, res);
        return;
      }
      if (result === PHASE_BUSY) {
        sendPhaseBusy(res);
        return;
      }
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
      const requestAbort = phaseRequestAbort(req, res);
      let result;
      try {
        result = await runPhaseComputation(
          key,
          (signal) => deps.customBuilds.evaluateBuildPhases(
            auth.userId,
            slug,
            {
              includeTransitions: false,
              perspective,
              strategyName,
              filters,
              signal,
            },
          ),
          requestAbort.signal,
        );
      } finally {
        requestAbort.cleanup();
      }
      if (result === PHASE_CANCELLED) {
        sendPhaseCancelled(req, res);
        return;
      }
      if (result === PHASE_BUSY) {
        sendPhaseBusy(res);
        return;
      }
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
      const requestAbort = phaseRequestAbort(req, res);
      let result;
      try {
        result = await runPhaseComputation(
          key,
          (signal) => deps.customBuilds.evaluateBuildPhases(
            auth.userId,
            slug,
            { includeTransitions: true, perspective, signal },
          ),
          requestAbort.signal,
        );
      } finally {
        requestAbort.cleanup();
      }
      if (result === PHASE_CANCELLED) {
        sendPhaseCancelled(req, res);
        return;
      }
      if (result === PHASE_BUSY) {
        sendPhaseBusy(res);
        return;
      }
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
      const rawBody = req.body && typeof req.body === "object" ? req.body : {};
      const reclassifyExplicit = rawBody.reclassify === true;
      // Older clients omitted this flag and expected save-time matching. New
      // clients send false for Save and true for Save & Reclassify.
      const reclassifyRequested = rawBody.reclassify !== false;
      const candidate = { ...rawBody, slug };
      delete candidate.reclassify;
      const validation = validateCustomBuild(candidate);
      if (!validation.valid) {
        res.status(400).json({
          error: { code: "bad_request", details: validation.errors },
        });
        return;
      }
      const previousBuild = /** @type {import('../services/types').CustomBuildRecord|null} */ (
        await deps.customBuilds.get(auth.userId, slug)
      );
      await deps.customBuilds.upsert(
        auth.userId,
        /** @type {any} */ (validation.value),
      );
      // The key tracks replay freshness, not build edits. Invalidate now so a
      // rule/name change cannot serve the prior phase analysis for 60 seconds.
      phaseCacheBust(auth.userId, slug);
      // Cloud-side reclassify so `myBuild` on stored games stays in sync
      // with the saved rules. Without this, the BuildDetail view (live
      // rule eval) and the opponent profile / Recent games table (reads
      // stored `myBuild`) drift apart — the user sees their build matched
      // 31 games here but the recent-games column still shows the
      // agent's old auto-classifier label. Skipped when perGame isn't
      // wired (e.g. tests bootstrapping without it) so the save itself
      // never fails on a missing dependency.
      let reclassify = null;
      let reclassifyError = null;
      if (reclassifyRequested && deps.perGame) {
        try {
          reclassify = await deps.customBuilds.enqueueReclassify(auth.userId, slug, {
            replace: true,
            previousNames: previousBuild && previousBuild.name
              ? [previousBuild.name]
              : [],
          });
        } catch (e) {
          reclassifyError = "reclassify_queue_failed";
          if (req.log) {
            req.log.warn(
              { err: e, slug, userId: auth.userId },
              "custom_build_upsert_reclassify_failed",
            );
          }
        }
      } else if (reclassifyRequested && reclassifyExplicit) {
        reclassifyError = "reclassify_unavailable";
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
      // validateCustomBuild types ``value`` as plain ``object``;
      // BUILD_SCHEMA guarantees ``name`` (required string) and
      // ``description`` (optional string), so narrow the two fields
      // the share payload reads.
      const validated = /** @type {{ name: string, description?: string }} */ (
        validation.value
      );
      const community = await applyShareState(deps, auth.userId, slug, {
        wantPublic: desiredShareState(req.body),
        title: validated.name,
        description: validated.description,
        log: req.log,
      });
      const payload = {
        ok: reclassifyError === null,
        saved: true,
        reclassifyRequested,
        reclassify,
        reclassifyError,
        community,
      };
      // The private build is already durable. Keep this a 200 partial-success
      // contract so clients do not tell the user their save failed; `ok:false`
      // and `reclassifyError` make the matching failure explicit and retryable.
      res.status(200).json(payload);
    } catch (err) {
      next(err);
    }
  });

  router.delete("/custom-builds/:slug", async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      const slug = String(req.params.slug);
      // Remove the public snapshot before soft-deleting its private source.
      // If the community write fails, leave the private row live so the same
      // DELETE can be retried safely. If softDelete fails after this succeeds,
      // unpublishBySource is idempotent and the retry can finish cleanup.
      if (deps.community) {
        await deps.community.unpublishBySource(auth.userId, slug);
      }
      await deps.customBuilds.softDelete(auth.userId, slug);
      phaseCacheBust(auth.userId, slug);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /v1/custom-builds/:slug/reclassify
   *
   * Queue a durable, memory-bounded all-history classifier. One background
   * worker hydrates small pages, chooses the closest saved-build match, and
   * only publishes tags after a successful complete scan.
   *
   * This is the "no-agent reclassify" path: the cloud already has the
   * parsed buildLog/oppBuildLog for uploaded games, so the worker pages
   * through cloud data without a round-trip to the desktop agent.
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
      const build = /** @type {import('../services/types').CustomBuildRecord|null} */ (
        await deps.customBuilds.get(auth.userId, slug)
      );
      if (!build) {
        res.status(404).json({ error: { code: "not_found" } });
        return;
      }
      const result = await deps.customBuilds.enqueueReclassify(auth.userId, slug, {
        replace: body.replace !== false,
        previousNames: build.name ? [build.name] : [],
      });
      // Matched-set may have shifted — drop any cached compositions /
      // transitions for this build so the next read recomputes.
      phaseCacheBust(auth.userId, slug);
      res.status(202).json({ ok: true, slug, name: build.name || slug, ...result });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /v1/custom-builds/reclassify-all
   *
   * Queue one deterministic all-build pass. More-specific rule sets win;
   * the saved build's most recent edit timestamp breaks equal-rule ties.
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
      const job = await deps.customBuilds.enqueueReclassifyAll(auth.userId, {
        clearUnmatched: !!body.clearUnmatched,
      });
      const buildCount = Math.max(0, Number(job.builds) || 0);
      res.status(202).json({
        ok: true,
        status: "queued",
        builds: buildCount,
        job,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/**
 * @param {import('../services/types').PerGameComputeService} perGame
 * @param {string} userId
 * @param {'you'|'opponent'} perspective
 * @returns {AsyncGenerator<{games: import('../services/types').PerGameComputeServiceListedGame[], candidates: number, hasMore: boolean}>}
 */
async function* legacyPreviewPages(perGame, userId, perspective) {
  const games = await perGame.listForRulePreview(userId, {
    limit: PREVIEW_GAME_SCAN_CAP,
    perspective,
  });
  yield { games, candidates: games.length, hasMore: false };
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
