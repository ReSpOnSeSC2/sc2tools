"use strict";

const crypto = require("crypto");
const { isDeepStrictEqual } = require("node:util");
const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");
const { STATS_GAME_MATCH, OwnerRevisions } = require("../util/gameVisibility");
const { parseAccounts, accountMatchHandles } = require("../util/accountFilter");
const { caseInsensitiveContains } = require("../util/parseQuery");
const {
  canonicalTimeZone,
  parsePlainDate,
  plainDateSerial,
  localWindow,
  recurrenceBuckets,
  recurrenceGroupExpression,
  bucketKeyFor,
} = require("../util/recurrenceBuckets");
const { COUNTED_BY_CHECKIN_EXPR, parseBuildKey } = require("./buildIntentShape");
const { deliverNotification } = require("./notificationDelivery");

/**
 * Personal goals ("play 50 ranked PvZ games this week", "average 80+ SQ",
 * "reach 4,500 MMR this season") with automatic progress from the player's
 * own games.
 *
 * Storage: one ``player_goals`` row per goal, ``{userId, id, type, params,
 * filters, window, status, slot?, pinned, completedAt, outcome, result,
 * criteriaRevision?, metNotifiedKey, metNotifiedAt}``. At most MAX_ACTIVE goals are active:
 * each active goal holds one of the slots 0..7 under a unique partial index
 * on ``{userId, slot}``, so two concurrent creates can never pass the cap.
 * A goal leaves its slot when it completes.
 *
 * Windows: ``{recurrence, startsOn, endsOn, tz, season?}`` with inclusive
 * local dates. Bucket math is the coaching assignments' own
 * (util/recurrenceBuckets.js): "weekly" is the Monday-start local week in
 * the goal's zone, across DST. A "season" window is one ladder season,
 * resolved to its dates by the client's season picker; it is a single
 * bucket. Games belong to a bucket by ``date`` (the replay end), the field
 * every analyzer date filter uses, so a goal's deep link lists exactly the
 * games it counted.
 *
 * Progress is computed lazily: ONE aggregation per evaluation, an indexed
 * ``{userId, date}`` match over the active goals' windows followed by a
 * ``$facet`` with one sub-pipeline per goal. Results are memoised per user
 * for MEMO_TTL_MS; the memo is fenced by OwnerRevisions and dropped on every
 * game write (``invalidateForUser``) and goal write.
 *
 * Minimum samples: a win rate counts from ``minGames`` decided games (at
 * least 20); averages from ``minGames`` scored games (at least 5). Below
 * that the view reports how many more games are needed, never a rate.
 *
 * Notifications: when a goal's current bucket is met, a conditional update
 * claims ``metNotifiedKey`` (the bucket key) and only the winner calls the
 * existing notification center with ``goal_met``. A once/season goal is
 * completed by the same update. The claim runs after ingest (the cheap
 * check: one indexed read when the player has no active goals) and after
 * any evaluation, so a met goal notifies exactly once wherever it is seen.
 */

const MAX_ACTIVE = 8;
const MAX_PINNED = 3;
const MAX_COMPLETED_LISTED = 50;
const MAX_WINDOW_DAYS = 366;
const MEMO_TTL_MS = 60_000;
const MEMO_LIMIT = 500;
const MAX_CONCURRENT_CHECKS = 8;
const QUERY_MAX_TIME_MS = 5000;
const TITLE_MAX = 80;
const MAP_MAX = 200;
const BUILD_NAME_MAX = 200;
const DAY_MS = 86_400_000;
/** A create loses a slot race only to another create that took that slot, so
 * MAX_ACTIVE + 1 attempts always end in success or a full cap. */
const SLOT_ATTEMPTS = 9;
const RECURRENCES = Object.freeze(["once", "daily", "weekly", "monthly", "season"]);
const MATCHUP_RE = /^([PTZ])v([PTZ])$/i;

/**
 * Per type: target bounds, whether the target is a whole number, the
 * minimum-sample rule (``[floor, ceiling, default]``) and the recurrences
 * that make sense for it.
 */
const GOAL_TYPES = Object.freeze({
  games_played: { min: 1, max: 1000, integer: true, minGames: null, recurrences: RECURRENCES },
  win_rate: { min: 1, max: 100, integer: false, minGames: [20, 500, 20], recurrences: RECURRENCES },
  mmr_reach: { min: 1, max: 8000, integer: true, minGames: null, recurrences: ["once", "season"] },
  macro_avg: { min: 1, max: 100, integer: false, minGames: [5, 500, 10], recurrences: RECURRENCES },
  apm_avg: { min: 1, max: 1000, integer: false, minGames: [5, 500, 10], recurrences: RECURRENCES },
  sq_avg: { min: 1, max: 200, integer: false, minGames: [5, 500, 10], recurrences: RECURRENCES },
  build_reps: { min: 1, max: 1000, integer: true, minGames: null, recurrences: RECURRENCES },
});

/** Slim-row field each average reads. */
const AVERAGE_FIELD = Object.freeze({ macro_avg: "macroScore", apm_avg: "apm", sq_avg: "spq" });

const WIN_EXPR = { $in: [{ $toLower: { $ifNull: ["$result", ""] } }, ["victory", "win"]] };
const LOSS_EXPR = { $in: [{ $toLower: { $ifNull: ["$result", ""] } }, ["defeat", "loss"]] };

/** The narrow slim-row projection every facet reads. */
const FACET_PROJECTION = Object.freeze({
  _id: 1, date: 1, result: 1, myRace: 1, "opponent.race": 1, map: 1, isLadderGame: 1,
  matchFormat: 1, playerCount: 1, myMmr: 1, myMmrSource: 1, myToonHandle: 1, macroScore: 1, apm: 1, spq: 1,
  myBuild: 1, _customBuildSlug: 1, "buildIntent.status": 1, "buildIntent.applied": 1,
  "buildIntent.build": 1, "buildIntent.detected": 1,
});

/** @param {number} status @param {string} code @param {string} message */
function goalError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

/** @param {unknown} value */
function plainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @param {number} max */
function plainText(value, max) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) return null;
  return text;
}

/** @param {unknown} raw @returns {string | null} */
function normalizeMatchup(raw) {
  if (typeof raw !== "string") return null;
  const m = MATCHUP_RE.exec(raw.trim());
  return m ? `${m[1].toUpperCase()}v${m[2].toUpperCase()}` : null;
}

/**
 * @param {unknown} raw
 * @returns {{matchup: string | null, map: string | null, ranked: boolean, build?: ReturnType<typeof normalizeBuild>}}
 */
function normalizeFilters(raw) {
  const input = plainObject(raw) ? /** @type {Record<string, unknown>} */ (raw) : {};
  const matchup = input.matchup == null || input.matchup === "" ? null : normalizeMatchup(input.matchup);
  if (input.matchup != null && input.matchup !== "" && !matchup) {
    throw goalError(400, "invalid_goal", "matchup must look like PvZ.");
  }
  const map = input.map == null || input.map === "" ? null : plainText(input.map, MAP_MAX);
  if (input.map != null && input.map !== "" && !map) throw goalError(400, "invalid_goal", "map must be a map name.");
  const build = input.build == null ? null : normalizeBuild(input.build);
  return { matchup, map, ranked: input.ranked !== false, ...(build ? { build } : {}) };
}

/**
 * @param {unknown} raw
 * @returns {{key: string, name: string, slug: string | null, source: "catalog" | "custom"}}
 */
function normalizeBuild(raw) {
  if (!plainObject(raw)) throw goalError(400, "invalid_goal", "Choose a build for this goal.");
  const input = /** @type {Record<string, unknown>} */ (raw);
  const name = plainText(input.name, BUILD_NAME_MAX);
  const parsed = parseBuildKey(input.key);
  if (!name || !parsed) throw goalError(400, "invalid_goal", "The build needs a valid key and name.");
  if (parsed.source === "custom") return { key: `custom:${parsed.slug}`, name, slug: parsed.slug, source: "custom" };
  return { key: parsed.key, name, slug: null, source: "catalog" };
}

/**
 * @param {keyof typeof GOAL_TYPES} type
 * @param {unknown} raw
 * @param {{matchup: string | null}} filters
 */
function normalizeParams(type, raw, filters) {
  const spec = GOAL_TYPES[type];
  const input = plainObject(raw) ? /** @type {Record<string, unknown>} */ (raw) : {};
  const target = Number(input.target);
  if (!Number.isFinite(target) || target < spec.min || target > spec.max || (spec.integer && !Number.isInteger(target))) {
    throw goalError(400, "invalid_goal", `target must be ${spec.integer ? "a whole number" : "a number"} from ${spec.min} to ${spec.max}.`);
  }
  /** @type {Record<string, any>} */
  const params = { target: spec.integer ? target : Math.round(target * 10) / 10 };
  if (spec.minGames) {
    const [floor, ceiling, fallback] = spec.minGames;
    const minGames = input.minGames == null ? fallback : Number(input.minGames);
    if (!Number.isInteger(minGames) || minGames < floor || minGames > ceiling) {
      throw goalError(400, "invalid_goal", `minGames must be a whole number from ${floor} to ${ceiling}.`);
    }
    params.minGames = minGames;
  }
  if (type === "mmr_reach") {
    params.toon = null;
    if (input.toon != null && input.toon !== "") {
      try { params.toon = /** @type {string[]} */ (parseAccounts(String(input.toon)))[0]; }
      catch { throw goalError(400, "invalid_goal", "toon must be one account handle."); }
    }
  }
  if (type === "build_reps") {
    if (!filters.matchup) throw goalError(400, "invalid_goal", "Choose a matchup for a build goal.");
    params.build = normalizeBuild(input.build);
  }
  return params;
}

/**
 * Validate a window and resolve its exclusive UTC bounds.
 *
 * @param {unknown} raw
 * @param {keyof typeof GOAL_TYPES} type
 */
function normalizeWindow(raw, type) {
  if (!plainObject(raw)) throw goalError(400, "invalid_goal_window", "Choose when this goal runs.");
  const input = /** @type {Record<string, unknown>} */ (raw);
  const recurrence = typeof input.recurrence === "string" ? input.recurrence.trim().toLowerCase() : "";
  if (!RECURRENCES.includes(recurrence) || !GOAL_TYPES[type].recurrences.includes(recurrence)) {
    throw goalError(400, "invalid_goal_window", `recurrence must be one of ${GOAL_TYPES[type].recurrences.join(", ")}.`);
  }
  const tz = canonicalTimeZone(input.tz);
  if (!tz) throw goalError(400, "invalid_timezone", "Choose a valid IANA timezone.");
  let start;
  let end;
  try {
    start = parsePlainDate(input.startsOn, "startsOn");
    end = parsePlainDate(input.endsOn, "endsOn");
  } catch (error) {
    throw goalError(400, "invalid_goal_window", /** @type {Error} */ (error).message);
  }
  const days = Math.round((plainDateSerial(end) - plainDateSerial(start)) / DAY_MS) + 1;
  if (days < 1 || days > MAX_WINDOW_DAYS) {
    throw goalError(400, "invalid_goal_window", `The window must cover 1 to ${MAX_WINDOW_DAYS} local dates.`);
  }
  let season = null;
  if (recurrence === "season") {
    season = Number(input.season);
    if (!Number.isInteger(season) || season < 1 || season > 999) {
      throw goalError(400, "invalid_goal_window", "Choose a ladder season.");
    }
  }
  const bounds = localWindow(start, end, tz);
  if (!bounds) throw goalError(400, "invalid_goal_window", "Those local dates do not form a valid time window.");
  const window = {
    recurrence, startsOn: String(input.startsOn).trim(), endsOn: String(input.endsOn).trim(),
    tz, season, startsAt: bounds.startsAt, endsAt: bounds.endsAt,
  };
  try {
    recurrenceBuckets(bucketRequirement(window));
  } catch {
    throw goalError(400, "invalid_goal_window", "Those local dates do not form a valid time window.");
  }
  return window;
}

/**
 * The util/recurrenceBuckets requirement of a stored window. A season is a
 * single bucket.
 *
 * @param {{recurrence: string, startsOn: string, endsOn: string, tz: string, startsAt: Date, endsAt: Date}} window
 */
function bucketRequirement(window) {
  return {
    recurrence: window.recurrence === "season" ? "once" : window.recurrence,
    timeZone: window.tz,
    startsOn: window.startsOn,
    endsOn: window.endsOn,
    startsAt: window.startsAt,
    endsAt: window.endsAt,
  };
}

/**
 * Full validation of a create body.
 *
 * @param {unknown} body
 */
function normalizeGoalInput(body) {
  if (!plainObject(body)) throw goalError(400, "invalid_goal", "Send a goal object.");
  const input = /** @type {Record<string, unknown>} */ (body);
  const type = /** @type {keyof typeof GOAL_TYPES} */ (String(input.type || ""));
  if (!Object.hasOwn(GOAL_TYPES, type)) {
    throw goalError(400, "invalid_goal", `type must be one of ${Object.keys(GOAL_TYPES).join(", ")}.`);
  }
  const filters = normalizeFilters(input.filters);
  if (type === "mmr_reach") filters.ranked = true;
  if (type === "build_reps") delete filters.build;
  const params = normalizeParams(type, input.params, filters);
  const window = normalizeWindow(input.window, type);
  const title = input.title == null || input.title === "" ? null : plainText(input.title, TITLE_MAX);
  if (input.title != null && input.title !== "" && !title) {
    throw goalError(400, "invalid_goal", `title must be plain text up to ${TITLE_MAX} characters.`);
  }
  return { type, params, filters, window, title };
}

// ---------------- labels ----------------

const PERIOD_SUFFIX = Object.freeze({ once: "", daily: " each day", weekly: " each week", monthly: " each month" });

/** @param {{matchup: string | null, map: string | null, ranked: boolean}} filters */
function scopeWords(filters) {
  return [filters.ranked ? "ranked" : "", filters.matchup || ""].filter(Boolean).join(" ");
}

/** @param {number} value */
function formatNumber(value) {
  return Number.isInteger(value) ? value.toLocaleString("en-US") : String(value);
}

/**
 * The goal as a sentence, e.g. "Play 50 ranked PvZ games each week" or
 * "Reach 4,500 MMR in Season 68". A custom title wins.
 *
 * @param {Record<string, any>} goal
 * @returns {string}
 */
function goalLabel(goal) {
  if (goal.title) return goal.title;
  const target = Number(goal.params?.target) || 0;
  const filters = goal.filters || { matchup: null, map: null, ranked: true };
  const scope = scopeWords(filters);
  const games = scope ? `${scope} games` : "games";
  const onMap = filters.map ? ` on ${filters.map}` : "";
  const withBuild = filters.build ? ` with ${filters.build.name}` : "";
  const window = goal.window || {};
  const period = window.recurrence === "season"
    ? ` in Season ${window.season}`
    : /** @type {Record<string, string>} */ (PERIOD_SUFFIX)[window.recurrence] || "";
  switch (goal.type) {
    case "games_played":
      return `Play ${formatNumber(target)} ${target === 1 ? games.replace(/games$/, "game") : games}${withBuild}${onMap}${period}`;
    case "win_rate":
      return `Win ${formatNumber(target)}% of ${games}${withBuild}${onMap}${period}`;
    case "mmr_reach":
      return `Reach ${formatNumber(target)} MMR${withBuild}${onMap}${period}`;
    case "macro_avg":
      return `Average a ${formatNumber(target)}+ macro score in ${games}${withBuild}${onMap}${period}`;
    case "apm_avg":
      return `Average ${formatNumber(target)}+ APM in ${games}${withBuild}${onMap}${period}`;
    case "sq_avg":
      return `Average ${formatNumber(target)}+ SQ in ${games}${withBuild}${onMap}${period}`;
    case "build_reps":
      return `Play ${goal.params?.build?.name || "a build"} ${formatNumber(target)} time${target === 1 ? "" : "s"}${filters.matchup ? ` in ${filters.matchup}` : ""}${onMap}${period}`;
    default:
      return "Goal";
  }
}

// ---------------- progress ----------------

/**
 * Per-goal ``$match`` inside its facet: the exact window, the goal's
 * filters and the rows its metric can read.
 *
 * @param {Record<string, any>} goal
 */
function goalMatch(goal) {
  /** @type {Record<string, any>[]} */
  const and = [{ $or: [{ matchFormat: "1v1" }, { matchFormat: { $exists: false }, playerCount: 2 }] }];
  /** @type {Record<string, any>} */
  const match = { date: { $gte: goal.window.startsAt, $lt: goal.window.endsAt }, $and: and };
  if (goal.filters.ranked || goal.type === "mmr_reach") match.isLadderGame = true;
  if (goal.filters.matchup) {
    // Same prefix matchers as the analyzer filter bar (util/parseQuery.js),
    // so the goal's deep link lists the games it counted.
    match.myRace = new RegExp(`^${goal.filters.matchup[0]}`, "i");
    match["opponent.race"] = new RegExp(`^${goal.filters.matchup[2]}`, "i");
  }
  // The analyzer's map filter is a case-insensitive "contains" match, so a
  // map-pool name ("Alcyone LE") and the deep link select the same games.
  if (goal.filters.map) match.map = caseInsensitiveContains(goal.filters.map.toLowerCase());
  if (goal.type === "mmr_reach") {
    match.myMmr = { $type: "number", $gt: 0 };
    match.myMmrSource = "replay";
    if (goal.params.toon) match.myToonHandle = { $in: accountMatchHandles(goal.params.toon) };
  }
  const averageField = /** @type {Record<string, string>} */ (AVERAGE_FIELD)[goal.type];
  if (averageField) match[averageField] = { $type: "number", $gte: 0 };
  // Match the effective build. Confirmed check-ins write the selected label
  // and custom slug onto the slim row (services/buildIntentShape.js).
  const build = goal.type === "build_reps" ? goal.params.build : goal.filters.build;
  if (build?.source === "custom" && build.slug) match._customBuildSlug = build.slug;
  else if (build?.name) match.myBuild = build.name;
  return match;
}

/** @param {Record<string, any>} goal */
function goalAccumulators(goal) {
  /** @type {Record<string, any>} */
  const out = { games: { $sum: 1 }, lastGameAt: { $max: "$date" } };
  if (goal.type === "win_rate") {
    out.wins = { $sum: { $cond: [WIN_EXPR, 1, 0] } };
    out.losses = { $sum: { $cond: [LOSS_EXPR, 1, 0] } };
  } else if (goal.type === "mmr_reach") {
    out.peak = { $max: "$myMmr" };
    out.latest = { $top: { sortBy: { date: -1, _id: -1 }, output: "$myMmr" } };
    out.first = { $bottom: { sortBy: { date: -1, _id: -1 }, output: "$myMmr" } };
  } else if (goal.type === "build_reps") {
    out.checkins = { $sum: COUNTED_BY_CHECKIN_EXPR };
  } else if (Object.hasOwn(AVERAGE_FIELD, goal.type)) {
    out.average = { $avg: `$${/** @type {Record<string, string>} */ (AVERAGE_FIELD)[goal.type]}` };
  }
  return out;
}

/** @param {Record<string, any>} goal */
function goalFacet(goal) {
  return [
    { $match: goalMatch(goal) },
    { $group: { _id: recurrenceGroupExpression(bucketRequirement(goal.window), "$date"), ...goalAccumulators(goal) } },
  ];
}

/** @param {number} value */
function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

/** @param {number | null | undefined} value @param {number} digits */
function round(value, digits) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/**
 * One bucket's measurement against the goal.
 *
 * @param {Record<string, any>} goal
 * @param {Record<string, any> | undefined} row the facet group row
 */
function measureBucket(goal, row) {
  const target = Number(goal.params.target);
  const games = Number(row?.games) || 0;
  /** @type {Record<string, any>} */
  const out = { games, value: null, fraction: 0, met: false, phase: "progress", needed: null, minGames: null };
  if (goal.type === "games_played" || goal.type === "build_reps") {
    out.value = games;
    out.fraction = clamp01(games / target);
    out.met = games >= target;
    if (goal.type === "build_reps") out.checkins = Number(row?.checkins) || 0;
    return out;
  }
  if (goal.type === "win_rate") {
    const wins = Number(row?.wins) || 0;
    const losses = Number(row?.losses) || 0;
    const decided = wins + losses;
    Object.assign(out, { wins, losses, games: decided, minGames: goal.params.minGames });
    if (decided < goal.params.minGames) {
      return { ...out, phase: "sample", needed: goal.params.minGames - decided,
        fraction: clamp01(decided / goal.params.minGames) };
    }
    const rate = (100 * wins) / decided;
    return { ...out, value: round(rate, 1), fraction: clamp01(rate / target), met: rate >= target };
  }
  if (goal.type === "mmr_reach") {
    const latest = typeof row?.latest === "number" ? row.latest : null;
    const peak = typeof row?.peak === "number" ? row.peak : null;
    const first = typeof row?.first === "number" ? row.first : null;
    Object.assign(out, { value: latest, peak, first });
    if (latest === null || peak === null) return { ...out, phase: "sample", noRatedGames: true };
    const met = peak >= target;
    const span = first !== null && target > first ? target - first : 0;
    const fraction = met ? 1 : span > 0 ? clamp01((latest - /** @type {number} */ (first)) / span) : 0;
    return { ...out, met, fraction };
  }
  // Averages.
  out.minGames = goal.params.minGames;
  if (games < goal.params.minGames) {
    return { ...out, phase: "sample", needed: goal.params.minGames - games, fraction: clamp01(games / goal.params.minGames) };
  }
  const average = Number(row?.average);
  return { ...out, value: round(average, 1), fraction: clamp01(average / target), met: average >= target };
}

/**
 * A goal's progress at ``now`` from its facet rows: the current bucket, its
 * measurement, and (for recurring goals) how many elapsed buckets were met.
 *
 * @param {Record<string, any>} goal
 * @param {Record<string, any>[]} rows facet output
 * @param {number} now
 */
function goalProgress(goal, rows, now) {
  const requirement = bucketRequirement(goal.window);
  const buckets = recurrenceBuckets(requirement);
  /** @type {Map<string, Record<string, any>>} */
  const byKey = new Map();
  for (const row of rows) {
    const key = bucketKeyFor(requirement, row._id);
    if (key) byKey.set(key, row);
  }
  const startsAt = goal.window.startsAt.getTime();
  const endsAt = goal.window.endsAt.getTime();
  const current = buckets.find((bucket) =>
    Date.parse(String(bucket.startsAt)) <= now && now < Date.parse(String(bucket.endsAt))) || null;
  // After the window, the view shows the last bucket's final measurement.
  const shown = current || (now >= endsAt ? buckets[buckets.length - 1] || null : null);
  const measure = measureBucket(goal, shown ? byKey.get(shown.key) : undefined);
  const elapsed = buckets.filter((bucket) => Date.parse(String(bucket.startsAt)) <= now);
  const metBuckets = elapsed.filter((bucket) => measureBucket(goal, byKey.get(bucket.key)).met).length;
  let state = "active";
  if (now < startsAt) state = "upcoming";
  else if (measure.met && current) state = "met";
  else if (now >= endsAt) state = "ended";
  return {
    state,
    target: Number(goal.params.target),
    current: shown ? { key: shown.key, startsAt: shown.startsAt, endsAt: shown.endsAt } : null,
    ...measure,
    buckets: requirement.recurrence === "once" ? null : { total: buckets.length, elapsed: elapsed.length, met: metBuckets },
  };
}

/** Outcome of a goal whose window has ended. @param {Record<string, any>} goal @param {Record<string, any>} progress */
function endedOutcome(goal, progress) {
  if (!progress.buckets) return progress.met ? "met" : "missed";
  return progress.buckets.total > 0 && progress.buckets.met === progress.buckets.total ? "met" : "missed";
}

/** @param {Record<string, any>} progress */
function resultSnapshot(progress) {
  const keys = ["target", "value", "fraction", "games", "minGames", "needed", "phase", "met", "wins", "losses",
    "peak", "first", "checkins", "noRatedGames", "buckets", "current"];
  /** @type {Record<string, any>} */
  const out = {};
  for (const key of keys) if (progress[key] !== undefined) out[key] = progress[key];
  return out;
}

/** @param {Date | null | undefined} value */
function iso(value) {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

/**
 * Client view of a stored goal. Never includes the userId or Mongo id.
 *
 * @param {Record<string, any>} goal
 * @param {Record<string, any> | null} progress
 */
function serializeGoal(goal, progress) {
  return {
    id: goal.id,
    type: goal.type,
    params: goal.params,
    filters: goal.filters,
    window: {
      recurrence: goal.window.recurrence, startsOn: goal.window.startsOn, endsOn: goal.window.endsOn,
      tz: goal.window.tz, season: goal.window.season ?? null,
      startsAt: iso(goal.window.startsAt), endsAt: iso(goal.window.endsAt),
    },
    title: goal.title || null,
    label: goalLabel(goal),
    pinned: goal.pinned === true,
    status: goal.status,
    outcome: goal.outcome || null,
    completedAt: iso(goal.completedAt),
    createdAt: iso(goal.createdAt),
    progress: progress || (goal.result ? { state: goal.outcome === "met" ? "met" : "ended", ...goal.result } : null),
  };
}

// ---------------- service ----------------

class PlayerGoalsService {
  /**
   * @param {{playerGoals: import('mongodb').Collection, games: import('mongodb').Collection,
   *   users: import('mongodb').Collection}} db
   * @param {{notifications?: import('./notifications').NotificationsService | null,
   *   logger?: import('pino').Logger | null, now?: () => number}} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.coll = db.playerGoals;
    this.notifications = opts.notifications || null;
    this.logger = opts.logger || null;
    this.now = opts.now || Date.now;
    this.revisions = new OwnerRevisions();
    /** @type {Map<string, {at: number, value: Record<string, any>}>} */
    this.memo = new Map();
    /** @type {Map<string, {promise: Promise<void>, again: boolean}>} */
    this.checks = new Map();
    this.counters = { evaluations: 0, notified: 0, checks_skipped: 0 };
  }

  /** Drop the memo and fence in-flight reads after any game or goal write.
   * @param {string} userId */
  invalidateForUser(userId) {
    this.revisions.invalidate(userId);
    this.memo.delete(userId);
  }

  /**
   * GET /v1/goals: active goals with live progress, plus recently completed
   * ones. Memoised per user for MEMO_TTL_MS.
   *
   * @param {string} userId
   */
  async list(userId) {
    const hit = this.memo.get(userId);
    if (hit && this.now() - hit.at < MEMO_TTL_MS) return hit.value;
    const revision = this.revisions.get(userId);
    const active = await this._evaluate(userId);
    const completed = await this.coll.find({ userId, status: "completed" }, { projection: { _id: 0, userId: 0 } })
      .sort({ completedAt: -1, id: -1 }).limit(MAX_COMPLETED_LISTED).toArray();
    const value = {
      goals: active.map(({ goal, progress }) => serializeGoal(goal, progress)),
      completed: completed.map((goal) => serializeGoal(goal, null)),
      limits: { maxActive: MAX_ACTIVE, maxPinned: MAX_PINNED },
    };
    if (this.revisions.current(userId, revision)) {
      this.memo.delete(userId);
      this.memo.set(userId, { at: this.now(), value });
      if (this.memo.size > MEMO_LIMIT) this.memo.delete(this.memo.keys().next().value || "");
    }
    return value;
  }

  /** @param {string} userId @param {unknown} body */
  async create(userId, body) {
    const input = normalizeGoalInput(body);
    const now = new Date(this.now());
    for (let attempt = 0; attempt < SLOT_ATTEMPTS; attempt += 1) {
      const active = await this.coll.find({ userId, status: "active" }, { projection: { _id: 0, slot: 1, pinned: 1 } }).toArray();
      const used = new Set(active.map((row) => row.slot));
      let slot = 0;
      while (slot < MAX_ACTIVE && used.has(slot)) slot += 1;
      if (slot >= MAX_ACTIVE) {
        throw goalError(409, "goal_limit", `You can have up to ${MAX_ACTIVE} active goals. Delete one to add another.`);
      }
      const doc = stampVersion({
        userId,
        id: `g_${crypto.randomBytes(9).toString("base64url")}`,
        ...input,
        pinned: active.filter((row) => row.pinned === true).length < MAX_PINNED,
        status: "active",
        slot,
        outcome: null,
        result: null,
        completedAt: null,
        metNotifiedKey: null,
        metNotifiedAt: null,
        createdAt: now,
        updatedAt: now,
      }, COLLECTIONS.PLAYER_GOALS);
      try {
        await this.coll.insertOne(doc);
      } catch (error) {
        // Lost a race for this slot: re-read the free slots and retry.
        if (/** @type {any} */ (error)?.code === 11000) continue;
        throw error;
      }
      this.invalidateForUser(userId);
      await this._pruneCompleted(userId);
      return this.list(userId);
    }
    throw goalError(409, "goal_limit", "Your goals changed at the same time. Try again.");
  }

  /**
   * Edit an active goal: pin, title, target/minimum, filters or window.
   * Changing what is measured resets the notify claim so the edited goal can
   * be reached (and announced) again.
   *
   * @param {string} userId @param {string} id @param {unknown} body
   */
  async update(userId, id, body) {
    if (!plainObject(body)) throw goalError(400, "invalid_goal", "Send the fields to change.");
    const input = /** @type {Record<string, unknown>} */ (body);
    const goal = await this.coll.findOne({ userId, id: String(id) });
    if (!goal) throw goalError(404, "goal_not_found", "That goal no longer exists.");
    if (goal.status !== "active") throw goalError(409, "goal_completed", "A completed goal can only be deleted.");
    /** @type {Record<string, any>} */
    const set = { updatedAt: new Date(this.now()) };
    let measured = false;
    if (input.pinned !== undefined) {
      const pinned = input.pinned === true;
      if (pinned && goal.pinned !== true) {
        const count = await this.coll.countDocuments({ userId, status: "active", pinned: true });
        if (count >= MAX_PINNED) throw goalError(409, "pin_limit", `Pin up to ${MAX_PINNED} goals to Today.`);
      }
      set.pinned = pinned;
    }
    if (input.title !== undefined) {
      const title = input.title === null || input.title === "" ? null : plainText(input.title, TITLE_MAX);
      if (input.title !== null && input.title !== "" && !title) {
        throw goalError(400, "invalid_goal", `title must be plain text up to ${TITLE_MAX} characters.`);
      }
      set.title = title;
    }
    if (input.filters !== undefined || input.params !== undefined || input.window !== undefined) {
      const merged = normalizeGoalInput({
        type: goal.type,
        filters: input.filters !== undefined ? input.filters : goal.filters,
        params: input.params !== undefined ? { ...goal.params, ...(plainObject(input.params) ? input.params : {}) } : goal.params,
        window: input.window !== undefined ? input.window : { ...goal.window },
        title: null,
      });
      measured = !isDeepStrictEqual(merged.filters, goal.filters)
        || !isDeepStrictEqual(merged.params, goal.params)
        || !isDeepStrictEqual(merged.window, goal.window);
      if (measured) {
        Object.assign(set, { filters: merged.filters, params: merged.params, window: merged.window,
          metNotifiedKey: null, metNotifiedAt: null });
      }
    }
    const active = { userId, id: goal.id, status: "active" };
    const updated = measured
      ? await this.coll.updateOne({ ...active, criteriaRevision: goal.criteriaRevision ?? null },
        { $set: set, $inc: { criteriaRevision: 1 } })
      : await this.coll.updateOne(active, { $set: set });
    if (!updated.matchedCount) {
      throw goalError(409, "goal_changed", "This goal changed. Reload before editing it again.");
    }
    this.invalidateForUser(userId);
    if (measured) this.logger?.debug?.({ goal: goal.id }, "player_goal_remeasured");
    return this.list(userId);
  }

  /** @param {string} userId @param {string} id */
  async remove(userId, id) {
    const res = await this.coll.deleteOne({ userId, id: String(id) });
    if (!res.deletedCount) throw goalError(404, "goal_not_found", "That goal no longer exists.");
    this.invalidateForUser(userId);
    return this.list(userId);
  }

  /**
   * The cheap post-ingest check, coalesced per user: a check already running
   * for this user reruns once when it finishes instead of stacking.
   *
   * @param {string} userId
   * @returns {Promise<void>}
   */
  afterIngest(userId) {
    this.invalidateForUser(userId);
    const running = this.checks.get(userId);
    if (running) {
      running.again = true;
      return running.promise;
    }
    if (this.checks.size >= MAX_CONCURRENT_CHECKS) {
      // Bounded fan-out; the next ingest or goals read settles it.
      this.counters.checks_skipped += 1;
      return Promise.resolve();
    }
    /** @type {{promise: Promise<void>, again: boolean}} */
    const entry = { promise: Promise.resolve(), again: false };
    entry.promise = (async () => {
      try {
        do {
          entry.again = false;
          await this._evaluate(userId);
        } while (entry.again);
      } finally {
        this.checks.delete(userId);
      }
    })();
    this.checks.set(userId, entry);
    return entry.promise;
  }

  /**
   * Measure every active goal with one aggregation, then settle: claim and
   * announce met buckets, complete met once/season goals and goals whose
   * window ended. Returns the active goals still active after settling.
   *
   * @param {string} userId
   * @returns {Promise<Array<{goal: Record<string, any>, progress: Record<string, any>}>>}
   */
  async _evaluate(userId) {
    const goals = await this.coll.find({ userId, status: "active" }, { projection: { _id: 0 } })
      .sort({ createdAt: 1, id: 1 }).limit(MAX_ACTIVE).toArray();
    if (goals.length === 0) return [];
    this.counters.evaluations += 1;
    const now = this.now();
    const live = goals.filter((goal) => goal.window.startsAt.getTime() <= now);
    /** @type {Record<string, any[]>} */
    let facets = {};
    if (live.length > 0) {
      const from = new Date(Math.min(...live.map((goal) => goal.window.startsAt.getTime())));
      const to = new Date(Math.max(...live.map((goal) => goal.window.endsAt.getTime())));
      const [row] = await this.db.games.aggregate([
        { $match: { userId, ...STATS_GAME_MATCH, isResumedFromReplay: { $ne: true }, date: { $gte: from, $lt: to } } },
        { $project: FACET_PROJECTION },
        { $facet: Object.fromEntries(live.map((goal, index) => [`g${index}`, goalFacet(goal)])) },
      ], { maxTimeMS: QUERY_MAX_TIME_MS }).toArray();
      facets = Object.fromEntries(live.map((goal, index) => [goal.id, row?.[`g${index}`] || []]));
    }
    /** @type {Array<{goal: Record<string, any>, progress: Record<string, any>}>} */
    const kept = [];
    for (const goal of goals) {
      const progress = goalProgress(goal, facets[goal.id] || [], now);
      const settled = await this._settle(userId, goal, progress, now);
      if (!settled) kept.push({ goal, progress });
    }
    return kept;
  }

  /**
   * @param {string} userId @param {Record<string, any>} goal
   * @param {Record<string, any>} progress @param {number} now
   * @returns {Promise<boolean>} true when the goal left the active list
   */
  async _settle(userId, goal, progress, now) {
    // Match legacy goals without a revision as well as goals edited since rollout.
    const active = { userId, id: goal.id, status: "active", criteriaRevision: goal.criteriaRevision ?? null };
    const single = goal.window.recurrence === "once" || goal.window.recurrence === "season";
    if (progress.state === "met" && progress.current && goal.metNotifiedKey !== progress.current.key) {
      const at = new Date(now);
      /** @type {Record<string, any>} */
      const update = { $set: { metNotifiedKey: progress.current.key, metNotifiedAt: at, updatedAt: at } };
      if (single) {
        Object.assign(update.$set, { status: "completed", outcome: "met", completedAt: at, result: resultSnapshot(progress) });
        update.$unset = { slot: "" };
      }
      const claimed = await this.coll.updateOne(
        { ...active, metNotifiedKey: { $ne: progress.current.key } },
        update,
      );
      if (claimed.modifiedCount === 1) {
        this.invalidateForUser(userId);
        this.counters.notified += 1;
        await deliverNotification(this.notifications, userId, {
          kind: "goal_met",
          title: `Goal reached: ${goalLabel(goal)}`.slice(0, 140),
          body: goalMetBody(goal, progress),
          href: "/app/goals",
          eventKey: goal.criteriaRevision
            ? `goal:${goal.id}:${goal.criteriaRevision}:${progress.current.key}`
            : `goal:${goal.id}:${progress.current.key}`,
        }, this.logger);
        return single;
      }
      // Another evaluation claimed this bucket or the goal changed while measuring it.
      return single;
    }
    if (progress.state === "ended") {
      const outcome = endedOutcome(goal, progress);
      const done = await this.coll.updateOne(active, {
        $set: { status: "completed", outcome, completedAt: goal.window.endsAt, result: resultSnapshot(progress),
          updatedAt: new Date(now) },
        $unset: { slot: "" },
      });
      if (done.modifiedCount === 1) this.invalidateForUser(userId);
      return true;
    }
    return false;
  }

  /** Keep the completed history bounded. @param {string} userId */
  async _pruneCompleted(userId) {
    const stale = await this.coll.find({ userId, status: "completed" }, { projection: { _id: 1 } })
      .sort({ completedAt: -1, id: -1 }).skip(MAX_COMPLETED_LISTED).limit(100).toArray();
    if (stale.length) await this.coll.deleteMany({ userId, _id: { $in: stale.map((row) => row._id) } });
  }
}

/** Notification body: the measured value in words. @param {Record<string, any>} goal @param {Record<string, any>} progress */
function goalMetBody(goal, progress) {
  const target = formatNumber(Number(goal.params.target));
  switch (goal.type) {
    case "games_played":
    case "build_reps":
      return `${formatNumber(progress.value)} of ${target} games${goal.type === "build_reps" && progress.checkins ? `, incl. ${progress.checkins} check-in${progress.checkins === 1 ? "" : "s"}` : ""}.`;
    case "win_rate":
      return `${progress.value}% over ${progress.games} decided games (target ${target}%).`;
    case "mmr_reach":
      return `Peak ${formatNumber(progress.peak)} MMR (target ${target}).`;
    default:
      return `Average ${progress.value} over ${progress.games} games (target ${target}).`;
  }
}

module.exports = {
  PlayerGoalsService,
  GOAL_TYPES,
  MAX_ACTIVE,
  MAX_PINNED,
  MEMO_TTL_MS,
  goalLabel,
  goalProgress,
  normalizeGoalInput,
  bucketRequirement,
};
