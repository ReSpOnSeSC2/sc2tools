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
// Blizzard battle.net region labels we accept on the ``regions`` filter.
// Mirrors regionFromToonHandle's output set so values produced at ingest
// time round-trip through the URL unchanged.
const REGION_CODES = new Set(["NA", "EU", "KR", "CN", "SEA"]);

/**
 * Parse the standard global filter bar from `req.query`.
 *
 * Returns a normalised filter object the services consume directly.
 * Unknown / invalid params are dropped silently — never throws on bad
 * input from the browser.
 *
 * @param {Record<string, unknown>} q
 * @returns {{
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
 * }}
 */
function parseFilters(q) {
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
  if (parseBool(q.exclude_too_short)) {
    out.excludeTooShort = true;
  }
  const regions = parseRegionList(q.regions);
  if (regions) out.regions = regions;
  return out;
}

/**
 * Parse the global region filter. Accepts a CSV ("NA,EU") or a single
 * value ("NA"); unknown labels are dropped. Returns an array preserving
 * input order, or undefined when nothing valid was supplied.
 *
 * The filter is a SET — the caller treats undefined as "all regions
 * pass" (no constraint), and an empty result of selected regions as
 * "no opponent matches" (drop the row).
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
  const match = { userId };
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
  // Region filter. Drives the global FilterBar's region picker —
  // applies uniformly to every analyzer tab (Opponents, Strategies,
  // Trends, Maps, Builds) since they all $match through this stage.
  // Two-tier match because not every games row has been re-ingested
  // since region became a stored field: trust ``opponent.region`` when
  // present, otherwise derive from the ``opponent.toonHandle`` leading
  // byte (cheap regex, no index needed at the small filter cardinality
  // this collection sees).
  if (Array.isArray(f.regions) && f.regions.length > 0) {
    const codes = regionCodesToHandlePrefixes(f.regions);
    if (codes.length > 0) {
      match.$or = [
        { "opponent.region": { $in: f.regions } },
        {
          "opponent.region": { $in: [null, ""] },
          "opponent.toonHandle": {
            $regex: `^(${codes.join("|")})-`,
          },
        },
        {
          "opponent.region": { $exists: false },
          "opponent.toonHandle": {
            $regex: `^(${codes.join("|")})-`,
          },
        },
      ];
    }
  }
  return match;
}

/**
 * Map our user-facing region labels back to the leading-byte codes
 * Blizzard puts on toon_handle. The inverse of regionFromToonHandle
 * — kept here (instead of imported) to keep parseQuery.js
 * dependency-free. Unknown labels are silently dropped.
 *
 * @param {string[]} regions
 * @returns {string[]}
 */
function regionCodesToHandlePrefixes(regions) {
  const map = { NA: "1", EU: "2", KR: "3", CN: "5", SEA: "6" };
  /** @type {string[]} */
  const out = [];
  for (const r of regions) {
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
  const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
