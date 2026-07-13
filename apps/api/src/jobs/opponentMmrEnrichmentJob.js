"use strict";

/**
 * Forward-only opponent ladder-metadata enrichment cron.
 *
 * SC2Pulse exposes an opponent's CURRENT per-race 1v1 MMR and league,
 * not necessarily the values they had when a replay was played. We therefore
 * inspect only games inserted inside a short, bounded ``createdAt`` window
 * and never sweep the historical corpus. Older rows intentionally stay null.
 * Five-hundred-point reporting bands tolerate the small rating drift
 * that can still occur inside the recent window.
 *
 * Each missing field has its own one-shot marker. This makes misses bounded
 * while allowing rows whose MMR was already enriched to receive the league
 * metadata older agents omitted. A Mongo advisory lock prevents API replicas
 * from running the same cycle, while a per-tick memo reuses one Pulse result
 * (including a miss) for every game carrying the same id.
 *
 * Disable / tuning knobs (env):
 *   * SC2TOOLS_OPP_MMR_ENRICH_DISABLED=1
 *   * SC2TOOLS_OPP_MMR_ENRICH_INTERVAL_SEC      (default 15 m)
 *   * SC2TOOLS_OPP_MMR_ENRICH_WINDOW_DAYS       (default 30, max 30)
 *   * SC2TOOLS_OPP_MMR_ENRICH_GAMES_PER_TICK    (default 25)
 */

const { randomUUID } = require("crypto");
const { canonicalRaceName, pickRaceMmr } = require("../services/oppMmrStamp");
const { MMR_FLOOR, MMR_CEILING } = require("../util/mmrBracketing");

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 30;
const DEFAULT_GAMES_PER_TICK = 25;
const MAX_GAMES_PER_TICK = 250;
const LOCK_KEY = "opponentMmrEnrichment";
const LOCK_COLLECTION = "jobLocks";
const LOCK_LEAD_MS = 60 * 1000;
const MIN_LOCK_TTL_MS = 60 * 1000;
const PLAYABLE_RACES = new Set(["Protoss", "Terran", "Zerg"]);
const LEAGUE_IDS = /** @type {Readonly<Record<string, number>>} */ (Object.freeze({
  bronze: 0,
  silver: 1,
  gold: 2,
  platinum: 3,
  diamond: 4,
  master: 5,
  grandmaster: 6,
}));

/**
 * @typedef {{
 *   ranAsLeader: boolean,
 *   selected: number,
 *   attempted: number,
 *   enriched: number,
 *   leagueEnriched: number,
 *   missed: number,
 *   pulseErrors: number,
 *   writeErrors: number,
 *   skipped: number,
 *   elapsedMs: number,
 * }} TickResult
 */

/**
 * @param {{
 *   db: import('../db/connect').DbContext,
 *   pulseMmr: { getRaceBreakdown(ids: string[], opts?: object): Promise<Array<any>> },
 *   logger: import('pino').Logger,
 *   intervalMs?: number,
 *   gamesPerTick?: number,
 *   windowDays?: number,
 *   nowFn?: () => number,
 *   onLeagueEnriched?: (summary: TickResult) => Promise<void>|void,
 * }} deps
 */
function buildOpponentMmrEnrichmentJob(deps) {
  validateDeps(deps);
  const config = readConfig(deps);
  const logger = deps.logger.child({ component: "opponentMmrEnrichmentJob" });
  const now = deps.nowFn || (() => Date.now());
  const lock = buildJobLock({
    collection: deps.db.db.collection(LOCK_COLLECTION),
    intervalMs: config.intervalMs,
    logger,
    now,
  });
  const context = {
    config,
    games: deps.db.games,
    lock,
    logger,
    now,
    onLeagueEnriched: deps.onLeagueEnriched,
    pulseMmr: deps.pulseMmr,
  };
  /** @type {NodeJS.Timeout|null} */
  let timer = null;
  /** @type {Promise<TickResult>|null} */
  let inFlight = null;
  let started = false;

  async function runOnce() {
    if (config.disabled) return null;
    if (inFlight) return inFlight;
    inFlight = runCycle(context);
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  function start() {
    if (started || timer) return;
    if (config.disabled) {
      logger.info("opponent_mmr_enrichment_disabled");
      return;
    }
    started = true;
    const trigger = () => {
      runOnce().catch((err) => logger.warn({ err }, "opponent_mmr_enrichment_tick_failed"));
    };
    // Begin healing immediately after a deploy; subsequent bounded batches
    // stay on the normal interval.
    trigger();
    timer = setInterval(trigger, config.intervalMs);
    if (typeof timer.unref === "function") timer.unref();
    logger.info(publicConfig(config), "opponent_mmr_enrichment_started");
  }

  async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    started = false;
    if (inFlight) await inFlight.catch(() => {});
  }

  return { start, stop, runOnce, isRunning: () => started };
}

/** @param {any} deps */
function validateDeps(deps) {
  if (!deps || !deps.db || !deps.db.games) {
    throw new Error("buildOpponentMmrEnrichmentJob: db.games required");
  }
  if (!deps.pulseMmr || typeof deps.pulseMmr.getRaceBreakdown !== "function") {
    throw new Error("buildOpponentMmrEnrichmentJob: pulseMmr required");
  }
  if (!deps.logger) {
    throw new Error("buildOpponentMmrEnrichmentJob: logger required");
  }
}

/** @param {Record<string, any>} deps */
function readConfig(deps) {
  const env = process.env;
  return {
    disabled: env.SC2TOOLS_OPP_MMR_ENRICH_DISABLED === "1",
    intervalMs: clampInterval(
      deps.intervalMs
        || parseSeconds(env.SC2TOOLS_OPP_MMR_ENRICH_INTERVAL_SEC)
        || DEFAULT_INTERVAL_MS,
    ),
    gamesPerTick: boundedPositiveInt(
      deps.gamesPerTick ?? env.SC2TOOLS_OPP_MMR_ENRICH_GAMES_PER_TICK,
      DEFAULT_GAMES_PER_TICK,
      MAX_GAMES_PER_TICK,
    ),
    windowDays: boundedPositiveInt(
      deps.windowDays ?? env.SC2TOOLS_OPP_MMR_ENRICH_WINDOW_DAYS,
      DEFAULT_WINDOW_DAYS,
      MAX_WINDOW_DAYS,
    ),
  };
}

/** @param {{ disabled: boolean, intervalMs: number, gamesPerTick: number, windowDays: number }} config */
function publicConfig(config) {
  return {
    intervalMs: config.intervalMs,
    gamesPerTick: config.gamesPerTick,
    windowDays: config.windowDays,
  };
}

/**
 * @param {{
 *   config: ReturnType<typeof readConfig>,
 *   games: import('mongodb').Collection,
 *   lock: ReturnType<typeof buildJobLock>,
 *   logger: import('pino').Logger,
 *   now: () => number,
 *   onLeagueEnriched?: (summary: TickResult) => Promise<void>|void,
 *   pulseMmr: { getRaceBreakdown(ids: string[], opts?: object): Promise<Array<any>> },
 * }} context
 * @returns {Promise<TickResult>}
 */
async function runCycle(context) {
  const startedAt = context.now();
  const summary = emptySummary();
  await context.lock.ensureIndexes().catch((err) => {
    context.logger.warn({ err }, "opponent_mmr_enrichment_index_failed");
  });
  const owner = await acquireCycleLock(context);
  if (!owner) {
    summary.elapsedMs = context.now() - startedAt;
    return summary;
  }
  summary.ranAsLeader = true;
  try {
    const rows = await findCandidates(context);
    summary.selected = rows.length;
    await processCandidates(context, rows, summary);
  } finally {
    await context.lock.release(owner);
    summary.elapsedMs = context.now() - startedAt;
    context.logger.info(summary, "opponent_mmr_enrichment_cycle");
  }
  if (summary.leagueEnriched > 0 && context.onLeagueEnriched) {
    try {
      await context.onLeagueEnriched(summary);
    } catch (err) {
      context.logger.warn({ err }, "opponent_league_enrichment_refresh_failed");
    }
  }
  return summary;
}

/** @param {any} context @returns {Promise<string|null>} */
async function acquireCycleLock(context) {
  try {
    return await context.lock.acquire();
  } catch (err) {
    context.logger.warn({ err }, "opponent_mmr_enrichment_lock_acquire_failed");
    return null;
  }
}

/** @returns {TickResult} */
function emptySummary() {
  return {
    ranAsLeader: false,
    selected: 0,
    attempted: 0,
    enriched: 0,
    leagueEnriched: 0,
    missed: 0,
    pulseErrors: 0,
    writeErrors: 0,
    skipped: 0,
    elapsedMs: 0,
  };
}

/** @param {any} context */
async function findCandidates(context) {
  const filter = buildCandidateFilter(context.now(), context.config.windowDays);
  return context.games
    .find(filter, {
      projection: {
        _id: 1,
        createdAt: 1,
        "opponent.pulseCharacterId": 1,
        "opponent.race": 1,
        "opponent.mmr": 1,
        "opponent.mmrLookupAttempted": 1,
        "opponent.leagueId": 1,
        "opponent.leagueLookupAttempted": 1,
      },
    })
    .sort({ createdAt: 1, _id: 1 })
    .limit(context.config.gamesPerTick)
    .toArray();
}

/**
 * @param {number} nowMs
 * @param {number} windowDays
 */
function buildCandidateFilter(nowMs, windowDays) {
  const now = new Date(nowMs);
  const cutoff = new Date(nowMs - windowDays * DAY_MS);
  return {
    createdAt: { $gte: cutoff, $lte: now },
    "opponent.pulseCharacterId": { $type: "string", $ne: "" },
    "opponent.race": { $regex: /^(?:p|protoss|t|terran|z|zerg)$/i },
    $and: [
      {
        $or: [
          { isLadderGame: true },
          { "opponent.leagueId": { $exists: true } },
        ],
      },
      {
        $or: [
          {
            "opponent.mmr": { $not: { $type: "number" } },
            "opponent.mmrLookupAttempted": { $ne: true },
          },
          {
            "opponent.leagueId": { $not: { $type: "number" } },
            "opponent.leagueLookupAttempted": { $ne: true },
          },
        ],
      },
    ],
  };
}

/**
 * @param {any} context
 * @param {any[]} rows
 * @param {TickResult} summary
 */
async function processCandidates(context, rows, summary) {
  /** @type {Map<string, Promise<{races: any[], failed: boolean}>>} */
  const cache = new Map();
  for (const row of rows) {
    const status = await attemptCandidate(context, row, cache, summary);
    if (status === "skipped") summary.skipped += 1;
    else if (status === "write_error") summary.writeErrors += 1;
    else {
      summary.attempted += 1;
      if (status === "enriched") summary.enriched += 1;
      else if (status === "pulse_error") summary.pulseErrors += 1;
      else summary.missed += 1;
    }
  }
  if (summary.writeErrors > 0) {
    context.logger.warn(
      { count: summary.writeErrors },
      "opponent_mmr_enrichment_write_errors",
    );
  }
}

/**
 * @param {any} context
 * @param {any} row
 * @param {Map<string, Promise<{races: any[], failed: boolean}>>} cache
 * @param {TickResult} summary
 * @returns {Promise<'enriched'|'missed'|'pulse_error'|'write_error'|'skipped'>}
 */
async function attemptCandidate(context, row, cache, summary) {
  const opponent = row.opponent || {};
  const needsMmr = !isFiniteNumber(opponent.mmr)
    && opponent.mmrLookupAttempted !== true;
  const needsLeague = !isFiniteNumber(opponent.leagueId)
    && opponent.leagueLookupAttempted !== true;
  if (!needsMmr && !needsLeague) return "skipped";

  const id = String(row.opponent.pulseCharacterId);
  const lookup = await cachedRaceBreakdown(cache, context.pulseMmr, id);
  // Transport failures remain retryable. Only a completed Pulse response is
  // allowed to consume either one-shot marker.
  if (lookup.failed) return "pulse_error";
  const mmr = selectRaceMmr(lookup.races, row.opponent.race);
  const leagueId = selectRaceLeagueId(lookup.races, row.opponent.race);
  let matched = false;
  let enriched = false;
  let writeError = false;

  if (needsMmr) {
    const result = await stampMissingField(context.games, row._id, {
      field: "opponent.mmr",
      marker: "opponent.mmrLookupAttempted",
      value: mmr,
    });
    matched = matched || result.matched;
    enriched = enriched || (result.matched && mmr !== null);
    writeError = writeError || result.failed;
  }

  if (needsLeague) {
    const result = await stampMissingField(context.games, row._id, {
      field: "opponent.leagueId",
      marker: "opponent.leagueLookupAttempted",
      value: leagueId,
    });
    matched = matched || result.matched;
    enriched = enriched || (result.matched && leagueId !== null);
    if (result.matched && leagueId !== null) summary.leagueEnriched += 1;
    writeError = writeError || result.failed;
  }

  if (writeError) return "write_error";
  if (!matched) return "skipped";
  if (enriched) return "enriched";
  return "missed";
}

/**
 * Stamp one server-owned field without overwriting a concurrent replay
 * re-upload. Attempt markers are independent so an existing MMR never blocks
 * league repair (and vice versa).
 *
 * @param {import('mongodb').Collection} games
 * @param {any} rowId
 * @param {{field: string, marker: string, value: number|null}} input
 * @returns {Promise<{matched: boolean, failed: boolean}>}
 */
async function stampMissingField(games, rowId, input) {
  /** @type {Record<string, boolean|number>} */
  const set = { [input.marker]: true };
  if (input.value !== null) set[input.field] = input.value;
  try {
    const res = await games.updateOne(
      {
        _id: rowId,
        [input.field]: { $not: { $type: "number" } },
        [input.marker]: { $ne: true },
      },
      { $set: set },
    );
    return { matched: (res.matchedCount || 0) > 0, failed: false };
  } catch {
    return { matched: false, failed: true };
  }
}

/**
 * @param {Map<string, Promise<{races: any[], failed: boolean}>>} cache
 * @param {{getRaceBreakdown(ids: string[], opts?: object): Promise<Array<any>>}} pulseMmr
 * @param {string} id
 */
function cachedRaceBreakdown(cache, pulseMmr, id) {
  const cached = cache.get(id);
  if (cached) return cached;
  const pending = Promise.resolve()
    .then(() => pulseMmr.getRaceBreakdown([id], { throwOnError: true }))
    .then((races) => ({ races: Array.isArray(races) ? races : [], failed: false }))
    .catch(() => ({ races: [], failed: true }));
  cache.set(id, pending);
  return pending;
}

/**
 * @param {any[]} races
 * @param {unknown} playedRace
 * @returns {number|null}
 */
function selectRaceMmr(races, playedRace) {
  const canonical = canonicalRaceName(playedRace);
  if (!canonical || !PLAYABLE_RACES.has(canonical)) return null;
  const picked = pickRaceMmr(races, canonical);
  if (!picked) return null;
  const mmr = Math.round(Number(picked.mmr));
  if (!Number.isFinite(mmr) || mmr < MMR_FLOOR || mmr > MMR_CEILING) {
    return null;
  }
  return mmr;
}

/**
 * Select the league from the same race-specific Pulse row used for MMR.
 * Pulse currently exposes display labels here; numeric and ``{type}`` forms
 * are accepted as well so the job remains tolerant of upstream shape changes.
 *
 * @param {any[]} races
 * @param {unknown} playedRace
 * @returns {number|null}
 */
function selectRaceLeagueId(races, playedRace) {
  const canonical = canonicalRaceName(playedRace);
  if (!canonical || !PLAYABLE_RACES.has(canonical) || !Array.isArray(races)) {
    return null;
  }
  const picked = races.find((row) => canonicalRaceName(row && row.race) === canonical);
  if (!picked) return null;
  return normalizeLeagueId(picked.leagueId ?? picked.league);
}

/** @param {unknown} raw @returns {number|null} */
function normalizeLeagueId(raw) {
  const source = /** @type {any} */ (raw);
  const value = source && typeof source === "object" ? source.type : source;
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") {
    const label = LEAGUE_IDS[value.trim().toLowerCase()];
    if (label !== undefined) return label;
  }
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 6) return null;
  return numeric;
}

/** @param {unknown} value */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * @param {{
 *   collection: import('mongodb').Collection,
 *   intervalMs: number,
 *   logger: import('pino').Logger,
 *   now: () => number,
 * }} deps
 */
function buildJobLock(deps) {
  async function ensureIndexes() {
    await deps.collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await deps.collection.createIndex({ key: 1 }, { unique: true });
  }

  async function acquire() {
    const owner = randomUUID();
    const now = deps.now();
    const leaseMs = Math.max(MIN_LOCK_TTL_MS, deps.intervalMs - LOCK_LEAD_MS);
    try {
      const doc = await deps.collection.findOneAndUpdate(
        {
          key: LOCK_KEY,
          $or: [
            { expiresAt: { $lte: new Date(now) } },
            { expiresAt: { $exists: false } },
          ],
        },
        {
          $set: {
            key: LOCK_KEY,
            owner,
            acquiredAt: new Date(now),
            expiresAt: new Date(now + leaseMs),
          },
        },
        { upsert: true, returnDocument: "after" },
      );
      return doc && doc.owner === owner ? owner : null;
    } catch (err) {
      if (isDuplicateKey(err)) return null;
      throw err;
    }
  }

  /** @param {string} owner */
  async function release(owner) {
    try {
      await deps.collection.deleteOne({ key: LOCK_KEY, owner });
    } catch (err) {
      deps.logger.warn({ err }, "opponent_mmr_enrichment_lock_release_failed");
    }
  }

  return { ensureIndexes, acquire, release };
}

/** @param {unknown} err */
function isDuplicateKey(err) {
  const e = /** @type {{code?: unknown, codeName?: unknown}} */ (err);
  return Boolean(e && (e.code === 11000 || e.codeName === "DuplicateKey"));
}

/** @param {unknown} raw @returns {number} */
function parseSeconds(raw) {
  const n = Number.parseFloat(String(raw || ""));
  return Number.isFinite(n) && n > 0 ? Math.floor(n * 1000) : 0;
}

/** @param {unknown} raw @param {number} fallback @param {number} max */
function boundedPositiveInt(raw, fallback, max) {
  const n = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

/** @param {unknown} raw */
function clampInterval(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, Math.floor(n));
}

module.exports = {
  buildOpponentMmrEnrichmentJob,
  __internal: {
    buildCandidateFilter,
    selectRaceMmr,
    selectRaceLeagueId,
    normalizeLeagueId,
    boundedPositiveInt,
    clampInterval,
    parseSeconds,
  },
};
