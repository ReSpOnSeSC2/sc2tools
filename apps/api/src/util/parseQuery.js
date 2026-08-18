"use strict";

/**
 * Query-string parsing helpers shared across analytics routes.
 *
 * Mirrors the global filter bar accepted by the legacy
 * stream-overlay-backend/analyzer.js endpoints so the cloud SPA can
 * keep its existing `?since=...&until=...&race=Z&...` URLs.
 */

const RACE_LETTERS = new Set(["P", "T", "Z", "R"]);
const RESULT_BUCKETS = new Set(["win", "loss"]);
// Battle.net region labels we accept on the ``regions`` filter.
// Mirrors regionFromToonHandle's output set so values produced at
// ingest time round-trip through the URL unchanged.
const REGION_CODES = new Set(["NA", "EU", "KR", "CN", "SEA"]);

/**
 * @typedef {{
 *   since?: Date,
 *   until?: Date,
 *   race?: 'P'|'T'|'Z'|'R',
 *   oppRace?: 'P'|'T'|'Z'|'R',
 *   map?: string,
 *   mmrMin?: number,
 *   mmrMax?: number,
 *   oppStrategy?: string,
 *   groupByRacePlayed?: boolean,
 *   build?: string,
 *   leak?: string,
 *   macroMin?: number,
 *   macroMax?: number,
 *   minMinutes?: number,
 *   maxMinutes?: number,
 *   excludeTooShort?: boolean,
 *   regions?: string[],
 *   mapPool?: 'ladder'|'nonladder',
 *   gameSize?: '1v1'|'team',
 * }} GlobalFilters
 */

/**
 * Parse the standard global filter bar from `req.query`.
 *
 * Returns a normalised filter object the services consume directly.
 * Unknown / invalid params are dropped silently — never throws on bad
 * input from the browser.
 *
 * @param {Record<string, unknown>} q
 * @returns {GlobalFilters}
 */
function parseFilters(q) {
  /** @type {GlobalFilters} */
  const out = {};
  if (!q || typeof q !== "object") return out;
  const since = parseDate(q.since);
  if (since) out.since = since;
  const until = parseDate(q.until);
  if (until) out.until = until;
  const race = parseRaceLetter(q.race);
  if (race) out.race = race;
  const oppRace = parseRaceLetter(q.opp_race);
  if (oppRace) out.oppRace = oppRace;
  if (typeof q.map === "string" && q.map.trim()) {
    out.map = q.map.trim().toLowerCase();
  }
  const mmrMin = parseFiniteInt(q.mmr_min);
  if (mmrMin !== undefined) out.mmrMin = mmrMin;
  const mmrMax = parseFiniteInt(q.mmr_max);
  if (mmrMax !== undefined) out.mmrMax = mmrMax;
  if (typeof q.opp_strategy === "string" && q.opp_strategy.trim()) {
    out.oppStrategy = q.opp_strategy.trim();
  }
  if (parseBool(q.group_by_race_played)) {
    out.groupByRacePlayed = true;
  }
  if (typeof q.build === "string" && q.build.trim()) {
    out.build = q.build.trim();
  }
  // Macro Report click-throughs. ``leak`` filters to games whose slim
  // top3Leaks carries that category name (exact match — the agent
  // emits a small fixed vocabulary: "Supply Blocked", "Mineral Float",
  // "Chrono Efficiency", ...). ``macro_min`` / ``macro_max`` bound the
  // game's macroScore: min is inclusive, max is EXCLUSIVE so adjacent
  // score buckets (60–69, 70–79) tile without double-counting.
  if (typeof q.leak === "string" && q.leak.trim()) {
    out.leak = q.leak.trim().slice(0, 120);
  }
  const macroMin = parseFiniteInt(q.macro_min);
  if (macroMin !== undefined) out.macroMin = macroMin;
  const macroMax = parseFiniteInt(q.macro_max);
  if (macroMax !== undefined) out.macroMax = macroMax;
  // Global "Game length" filter. Bounds arrive as whole minutes and are
  // applied against ``durationSec`` -- the SAME field the Macro Report
  // buckets its game-length segments on (macroReport.js
  // DURATION_BUCKETS). That field is derived from
  // ``replay.length.seconds`` and holds real elapsed seconds, NOT the
  // ~1.4x Blizzard "Faster" game clock that older extractor output used
  // for event timestamps (see db/migrations/2026-05-17-rescale-timebase
  // -- durationSec was explicitly left alone there because it was always
  // on the real scale). Sharing the source is what makes the Macro tab's
  // "10-14 min" bar and ``min_minutes=10&max_minutes=14`` describe the
  // same cohort instead of two answers that differ by 40%.
  const { minMinutes, maxMinutes } = parseMinuteBounds(
    q.min_minutes,
    q.max_minutes,
  );
  if (minMinutes !== undefined) out.minMinutes = minMinutes;
  if (maxMinutes !== undefined) out.maxMinutes = maxMinutes;
  if (parseBool(q.exclude_too_short)) {
    out.excludeTooShort = true;
  }
  const regions = parseRegionList(q.regions);
  if (regions) out.regions = regions;
  // Ranked/custom game filter. The public query key remains
  // ``map_pool`` for backwards compatibility with the FilterBar, but
  // classification comes from the replay's authoritative matchmaking
  // category (``isLadderGame``), not the map name. ``all`` remains an
  // explicit no-op sentinel for the web controls.
  if (q.map_pool === "ladder" || q.map_pool === "nonladder") {
    out.mapPool = q.map_pool;
  }
  // Match-format filter. ``matchFormat`` distinguishes team games from
  // FFA/custom lobbies that merely have more than two players. ``all``
  // remains an explicit no-op sentinel for the web controls.
  if (q.game_size === "1v1" || q.game_size === "team") {
    out.gameSize = q.game_size;
  }
  return out;
}

/**
 * Upper limit accepted on a game-length bound, in minutes.
 *
 * Ten hours is far past any real StarCraft II game (the longest
 * recorded professional games run one to two hours), so the cap never
 * touches a legitimate filter. It exists so a hand-edited URL cannot
 * push an absurd number into the match stage.
 */
const MAX_GAME_LENGTH_MINUTES = 600;

/**
 * Parse the "Game length" bounds off the query string.
 *
 * Whole minutes, clamped to [0, MAX_GAME_LENGTH_MINUTES]; anything
 * unparseable is dropped rather than throwing, matching every other
 * filter here.
 *
 * A transposed pair (min above max) is swapped rather than honoured
 * literally. Read at face value it selects nothing, and answering an
 * obvious typo with a blank dashboard is worse than answering with the
 * range the user plainly meant.
 *
 * @param {unknown} rawMin
 * @param {unknown} rawMax
 * @returns {{minMinutes?: number, maxMinutes?: number}}
 */
function parseMinuteBounds(rawMin, rawMax) {
  let min = clampMinutes(parseFiniteInt(rawMin));
  let max = clampMinutes(parseFiniteInt(rawMax));
  if (min !== undefined && max !== undefined && min > max) {
    const swap = min;
    min = max;
    max = swap;
  }
  /** @type {{minMinutes?: number, maxMinutes?: number}} */
  const out = {};
  // A zero lower bound is the absence of a constraint, not a
  // constraint of its own -- keep it off the wire so an "any length"
  // selection produces the same query it always did.
  if (min !== undefined && min > 0) out.minMinutes = min;
  if (max !== undefined && max > 0) out.maxMinutes = max;
  return out;
}

/** @param {number|undefined} value @returns {number|undefined} */
function clampMinutes(value) {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.min(value, MAX_GAME_LENGTH_MINUTES);
}

/**
 * Parse the global region filter. Accepts a CSV ("NA,EU") or a
 * single value ("NA"); unknown labels are dropped. Returns an array
 * preserving input order, or ``undefined`` when nothing valid was
 * supplied (so the caller treats it as "all regions pass").
 *
 * @param {unknown} raw
 * @returns {string[]|undefined}
 */
function parseRegionList(raw) {
  if (raw === undefined || raw === null) return undefined;
  const tokens = Array.isArray(raw)
    ? raw.flatMap((v) => String(v).split(","))
    : String(raw).split(",");
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const tok of tokens) {
    const code = tok.trim().toUpperCase();
    if (!REGION_CODES.has(code) || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Build the Mongo $match stage that applies a parsed filter object to
 * the per-user games collection.
 *
 * @param {string} userId
 * @param {ReturnType<typeof parseFilters>} filters
 * @returns {Record<string, any>}
 */
function gamesMatchStage(userId, filters) {
  /** @type {Record<string, any>} */
  const match = { userId, isResumedFromReplay: { $ne: true } };
  const f = filters || {};
  if (f.since || f.until) {
    /** @type {Record<string, Date>} */
    const range = {};
    if (f.since) range.$gte = f.since;
    if (f.until) range.$lte = f.until;
    match.date = range;
  }
  if (f.race) {
    match.myRace = raceMatcher(f.race);
  }
  if (f.oppRace) {
    match["opponent.race"] = raceMatcher(f.oppRace);
  }
  if (f.map) {
    match.map = caseInsensitiveContains(f.map);
  }
  if (typeof f.mmrMin === "number" || typeof f.mmrMax === "number") {
    /** @type {Record<string, number>} */
    const mmr = {};
    if (typeof f.mmrMin === "number") mmr.$gte = f.mmrMin;
    if (typeof f.mmrMax === "number") mmr.$lte = f.mmrMax;
    match["opponent.mmr"] = mmr;
  }
  if (f.oppStrategy) {
    match["opponent.strategy"] = f.oppStrategy;
  }
  if (f.build) {
    match.myBuild = f.build;
  }
  if (f.leak) {
    match["top3Leaks.name"] = f.leak;
  }
  if (typeof f.macroMin === "number" || typeof f.macroMax === "number") {
    /** @type {Record<string, number>} */
    const score = {};
    if (typeof f.macroMin === "number") score.$gte = f.macroMin;
    // Exclusive upper bound — see parseFilters: score buckets tile.
    if (typeof f.macroMax === "number") score.$lt = f.macroMax;
    match.macroScore = score;
  }
  // "Game length" filter, driving every analyzer tab. Minutes convert
  // to seconds because ``durationSec`` is the stored unit -- and is the
  // same field the Macro Report's game-length segments bucket on, so
  // the two surfaces agree by construction.
  //
  // Lower bound inclusive, upper bound EXCLUSIVE, matching macro_min /
  // macro_max: adjacent length bands ("6-10", "10-14") then tile
  // without a game that ended at exactly 10:00 being counted twice.
  //
  // Rows with no numeric ``durationSec`` fall out of both explicit
  // bounds. That is deliberate and matches how mapPool / gameSize treat
  // a missing canonical flag below: a game whose length was never
  // recorded cannot honestly be claimed for a length band.
  if (typeof f.minMinutes === "number" || typeof f.maxMinutes === "number") {
    /** @type {Record<string, number>} */
    const duration = {};
    if (typeof f.minMinutes === "number") duration.$gte = f.minMinutes * 60;
    if (typeof f.maxMinutes === "number") duration.$lt = f.maxMinutes * 60;
    match.durationSec = duration;
  }
  // "Exclude too-short games": the strategy detector emits a
  // matchup-prefixed "<X>v<Y> - Game Too Short" label (also surfaced
  // as race-prefixed "<Race> - Game Too Short" when my_race wasn't
  // available) for replays that ended in under 30 seconds. The same
  // suffix lands on both ``myBuild`` and ``opponent.strategy``, so a
  // negated regex on either field drops the cohort. Only apply to
  // fields the user has NOT already constrained — an explicit
  // myBuild / opp_strategy filter is more specific and wins
  // automatically (an exact build name either matches a too-short
  // bucket, in which case the user explicitly asked for these games,
  // or it doesn't, in which case the exact-match already excludes
  // them).
  if (f.excludeTooShort) {
    const notTooShort = { $not: /Game Too Short$/ };
    if (match.myBuild === undefined) {
      match.myBuild = notTooShort;
    }
    if (match["opponent.strategy"] === undefined) {
      match["opponent.strategy"] = notTooShort;
    }
  }
  // Region filter. Drives the global FilterBar's region picker
  // across every analyzer tab (Opponents, Strategies, Trends, Maps,
  // Builds) since they all $match through this stage.
  //
  // Two-tier match because not every games row has been re-ingested
  // since ``opponent.region`` became a stored field: trust the
  // stored value when present, otherwise derive from the
  // ``opponent.toonHandle`` leading byte at filter time (cheap
  // regex). This means old data still matches without a backfill.
  if (Array.isArray(f.regions) && f.regions.length > 0) {
    const prefixes = regionLabelsToHandlePrefixes(f.regions);
    if (prefixes.length > 0) {
      match.$or = [
        { "opponent.region": { $in: f.regions } },
        {
          "opponent.region": { $in: [null, ""] },
          "opponent.toonHandle": { $regex: `^(${prefixes.join("|")})-` },
        },
        {
          "opponent.region": { $exists: false },
          "opponent.toonHandle": { $regex: `^(${prefixes.join("|")})-` },
        },
      ];
    }
  }
  // Ranked/custom filter, driving every analyzer tab. ``isLadderGame``
  // is authored from the replay's matchmaking category and is the only
  // trustworthy discriminator: custom games can be played on ladder
  // maps, so the historical ``isLadderMap`` proxy must not participate.
  // Missing canonical flags are intentionally excluded from both
  // explicit buckets. Keep these clauses inside ``$and`` so they can
  // coexist with the region filter's top-level ``$or``.
  if (f.mapPool === "ladder") {
    addAndClause(match, { isLadderGame: true });
  } else if (f.mapPool === "nonladder") {
    addAndClause(match, { isLadderGame: false });
  }
  // Match-format filter. New rows carry the authoritative normalized
  // ``matchFormat``. For 1v1 only, retain the safe legacy fallback of a
  // two-player replay when matchFormat is absent. Team is strict:
  // ``playerCount > 2`` also describes FFA, so count cannot identify it.
  if (f.gameSize === "1v1") {
    addAndClause(match, {
      $or: [
        { matchFormat: "1v1" },
        { matchFormat: { $exists: false }, playerCount: 2 },
      ],
    });
  } else if (f.gameSize === "team") {
    addAndClause(match, { matchFormat: "team" });
  }
  return match;
}

/**
 * Append a Mongo clause without consuming the top-level ``$or`` used by
 * the region fallback matcher.
 *
 * @param {Record<string, any>} match
 * @param {Record<string, any>} clause
 */
function addAndClause(match, clause) {
  if (!Array.isArray(match.$and)) match.$and = [];
  match.$and.push(clause);
}

/**
 * Inverse of regionFromToonHandle. Used by the region filter so old
 * games rows that pre-date the stored ``opponent.region`` field still
 * match via a regex on the toon_handle's leading byte. Kept local
 * (instead of imported) to keep parseQuery.js dependency-free.
 *
 * @param {string[]} labels
 * @returns {string[]}
 */
function regionLabelsToHandlePrefixes(labels) {
  /** @type {Record<string, string>} */
  const map = { NA: "1", EU: "2", KR: "3", CN: "5", SEA: "6" };
  /** @type {string[]} */
  const out = [];
  for (const r of labels) {
    const code = map[r];
    if (code) out.push(code);
  }
  return out;
}

/**
 * Standardise a race letter ("Protoss", "P", "p", "Random") into a
 * single-letter code matching the canonical {P, T, Z, R} alphabet.
 *
 * @param {unknown} raw
 * @returns {'P'|'T'|'Z'|'R'|null}
 */
function parseRaceLetter(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().toUpperCase();
  if (s.length === 0) return null;
  const head = s.charAt(0);
  return RACE_LETTERS.has(head) ? /** @type {'P'|'T'|'Z'|'R'} */ (head) : null;
}

/**
 * Build a regex that matches both the long ("Protoss") and short ("P")
 * forms used across legacy data so the same filter works regardless of
 * how the agent recorded the race.
 *
 * @param {'P'|'T'|'Z'|'R'} letter
 * @returns {RegExp}
 */
function raceMatcher(letter) {
  return new RegExp(`^${letter}`, "i");
}

/**
 * Build a case-insensitive substring matcher safe for Mongo queries.
 *
 * @param {string} value
 * @returns {RegExp}
 */
function caseInsensitiveContains(value) {
  // Length cap: metacharacters are escaped below, but a very long
  // input still compiles (and scans with) a costly case-insensitive
  // pattern per document. No legitimate map/filter string approaches
  // this bound.
  const capped = String(value).slice(0, 128);
  const escaped = capped.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped, "i");
}

/** @param {unknown} raw @returns {Date | null} */
function parseDate(raw) {
  if (!raw || typeof raw !== "string") return null;
  const t = Date.parse(raw.replace(" ", "T"));
  return Number.isFinite(t) ? new Date(t) : null;
}

/** @param {unknown} raw @returns {number | undefined} */
function parseFiniteInt(raw) {
  if (raw === null || raw === undefined || raw === "") return undefined;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : undefined;
}

/** @param {unknown} raw @returns {boolean} */
function parseBool(raw) {
  if (raw === true || raw === 1) return true;
  if (typeof raw === "string") {
    const s = raw.toLowerCase();
    return s === "1" || s === "true" || s === "yes" || s === "on";
  }
  return false;
}

/**
 * @param {unknown} raw
 * @param {number} fallback
 * @param {number} [maxValue]
 * @returns {number}
 */
function clampInt(raw, fallback, maxValue) {
  const n =
    typeof raw === "number" ? raw : Number.parseInt(String(raw || ""), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  if (typeof maxValue === "number") return Math.min(n, maxValue);
  return n;
}

/**
 * Normalise the result strings the agent uploads ("Victory"/"Defeat"/
 * "Tie") into the simpler "win"/"loss" buckets used by the analytics
 * surface. Accepts the legacy lowercase forms as well so docs migrated
 * from `meta_database.json` still classify correctly.
 *
 * @param {unknown} raw
 * @returns {'win' | 'loss' | null}
 */
function resultBucket(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.toLowerCase();
  if (s === "victory" || s === "win") return "win";
  if (s === "defeat" || s === "loss") return "loss";
  return null;
}

module.exports = {
  MAX_GAME_LENGTH_MINUTES,
  parseFilters,
  parseDate,
  parseFiniteInt,
  parseBool,
  clampInt,
  parseRaceLetter,
  caseInsensitiveContains,
  gamesMatchStage,
  resultBucket,
};
