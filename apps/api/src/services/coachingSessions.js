"use strict";

/**
 * Coaching sessions beside the calendar: the facts-only "Since last
 * session" prep digest on one booking, and the caller's complete
 * past-session history.
 *
 * The digest is a watch-list, never an assessment. It carries game counts
 * and W-L by matchup, the detected builds and the newest replays since the
 * previous session; no grades, scores, MMR, notes or practice-log data. A
 * matchup's win rate only appears once it has ``DIGEST_MIN_SAMPLE``
 * decided games. Authorization and the practice-sharing consent gate live
 * in ``CoachingService``; everything here is pure apart from the
 * aggregation pipeline the service runs.
 */

const { STATS_GAME_MATCH } = require("../util/gameVisibility");
const { DETECTOR_MY_BUILD_FIELD } = require("./buildIntentReaders");
const {
  assignmentGameStartExpression,
  oneVsOneGameClause,
  coachingResultExpr,
  coachingRaceExpr,
} = require("./coachingGameExpr");

const DAY_MS = 86_400_000;
const DIGEST_LOOKBACK_DAYS = 90;
const DIGEST_RECENT_GAMES = 8;
const DIGEST_BUILD_ROWS = 6;
const DIGEST_MIN_SAMPLE = 5;
const HISTORY_LIMIT_DEFAULT = 50;
const HISTORY_LIMIT_MAX = 100;
const RACES = new Set(["P", "T", "Z"]);

/** @param {unknown} value @returns {Date|null} */
function toDate(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(/** @type {any} */ (value));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** @param {unknown} value @returns {string|null} */
function isoOrNull(value) {
  const date = toDate(value);
  return date ? date.toISOString() : null;
}

/** @param {unknown} value @param {number} max @returns {string|null} */
function boundedText(value, max) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= max ? text : null;
}

/**
 * The student's latest earlier session that took place (not cancelled):
 * same calendar, same roster student, ended before both now and this
 * booking's start.
 *
 * @param {any[]|undefined} bookings
 * @param {any} booking
 * @param {Date} now
 */
function previousSession(bookings, booking, now) {
  const start = toDate(booking && booking.startAt);
  const limit = Math.min(now.getTime(), start ? start.getTime() : now.getTime());
  /** @type {any} */
  let best = null;
  let bestEnd = -Infinity;
  for (const item of Array.isArray(bookings) ? bookings : []) {
    if (!item || item.id === booking.id || item.status !== "booked") continue;
    if (item.studentId !== booking.studentId || item.studentUserId !== booking.studentUserId) continue;
    const end = toDate(item.endAt);
    if (!end || end.getTime() > limit || end.getTime() <= bestEnd) continue;
    best = item;
    bestEnd = end.getTime();
  }
  return best;
}

/**
 * Where "since last session" starts: the latest of the previous session's
 * end, the moment practice sharing was accepted (earlier games stay
 * private) and the lookback limit.
 *
 * @param {{bookings:any[]|undefined, booking:any, sharingStartedAt:unknown, now:Date}} input
 */
function digestWindow({ bookings, booking, sharingStartedAt, now }) {
  const last = previousSession(bookings, booking, now);
  const sharing = toDate(sharingStartedAt);
  const lastEnd = last ? toDate(last.endAt) : null;
  const candidates = [
    { basis: "lookback_limit", at: now.getTime() - DIGEST_LOOKBACK_DAYS * DAY_MS },
    { basis: "sharing_started", at: sharing ? sharing.getTime() : -Infinity },
    { basis: "last_session", at: lastEnd ? lastEnd.getTime() : -Infinity },
  ];
  const chosen = candidates.reduce((best, item) => (item.at >= best.at ? item : best));
  return {
    since: new Date(Math.min(chosen.at, now.getTime())),
    until: new Date(now.getTime()),
    basis: chosen.basis,
    lastSession: last ? { startAt: isoOrNull(last.startAt), endAt: isoOrNull(last.endAt) } : null,
  };
}

/**
 * Eligible 1v1 games the student started inside the window. Hidden
 * (excluded), deleted and resumed replays never count.
 *
 * @param {string} userId @param {Date} since @param {Date} until
 */
function digestGameMatch(userId, since, until) {
  const start = assignmentGameStartExpression();
  return {
    userId,
    ...STATS_GAME_MATCH,
    isResumedFromReplay: { $ne: true },
    // Indexable coarse bound around the exact start-time expression; a
    // replay can last at most 24 hours by schema.
    date: { $gte: since, $lt: new Date(until.getTime() + DAY_MS) },
    $and: [
      oneVsOneGameClause(),
      { $expr: { $and: [{ $gte: [start, since] }, { $lt: [start, until] }] } },
    ],
  };
}

/** @param {string} userId @param {Date} since @param {Date} until */
function digestPipeline(userId, since, until) {
  const build = {
    $cond: [
      { $eq: [{ $type: "$_digestBuild" }, "string"] },
      { $trim: { input: "$_digestBuild" } },
      "",
    ],
  };
  return [
    { $match: digestGameMatch(userId, since, until) },
    {
      $addFields: {
        _digestResult: coachingResultExpr(),
        _digestMyRace: coachingRaceExpr("$myRace"),
        _digestOppRace: coachingRaceExpr("$opponent.race"),
        // The classifier's label, never a declared check-in: practice
        // sharing covers the detected build only.
        _digestBuild: DETECTOR_MY_BUILD_FIELD,
      },
    },
    {
      $facet: {
        results: [{ $group: { _id: "$_digestResult", games: { $sum: 1 } } }],
        matchups: [{
          $group: {
            _id: { my: "$_digestMyRace", opp: "$_digestOppRace", result: "$_digestResult" },
            games: { $sum: 1 },
          },
        }],
        builds: [{ $group: { _id: build, games: { $sum: 1 } } }, { $sort: { games: -1, _id: 1 } }],
        recent: [
          { $sort: { date: -1, _id: -1 } },
          { $limit: DIGEST_RECENT_GAMES },
          {
            $project: {
              _id: 0, gameId: 1, date: 1, startedAt: 1, durationSec: 1, map: 1,
              _digestResult: 1, _digestMyRace: 1, _digestOppRace: 1, _digestBuild: 1,
            },
          },
        ],
      },
    },
  ];
}

/** @param {unknown} value @returns {number} */
function count(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

/**
 * A rate only above the sample floor; below it the W-L stands alone.
 * @param {number} wins @param {number} losses
 */
function rateOrNull(wins, losses) {
  const decided = wins + losses;
  return decided >= DIGEST_MIN_SAMPLE ? Math.round((wins / decided) * 1000) / 1000 : null;
}

/** @param {any[]|undefined} rows */
function matchupRows(rows) {
  /** @type {Map<string, {matchup:string,games:number,wins:number,losses:number}>} */
  const byMatchup = new Map();
  let unknownRaceGames = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = row && row._id ? row._id : {};
    const games = count(row && row.games);
    if (!RACES.has(id.my) || !RACES.has(id.opp)) {
      unknownRaceGames += games;
      continue;
    }
    const matchup = `${id.my}v${id.opp}`;
    const entry = byMatchup.get(matchup) || { matchup, games: 0, wins: 0, losses: 0 };
    entry.games += games;
    if (id.result === "win") entry.wins += games;
    if (id.result === "loss") entry.losses += games;
    byMatchup.set(matchup, entry);
  }
  const matchups = [...byMatchup.values()]
    .sort((a, b) => b.games - a.games || a.matchup.localeCompare(b.matchup))
    .map((row) => ({ ...row, winRate: rateOrNull(row.wins, row.losses) }));
  return { matchups, unknownRaceGames };
}

/** @param {any[]|undefined} rows */
function buildRows(rows) {
  /** @type {{name:string,games:number}[]} */
  const named = [];
  let unclassifiedGames = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const name = boundedText(row && row._id, 120);
    if (name) named.push({ name, games: count(row.games) });
    else unclassifiedGames += count(row && row.games);
  }
  return {
    builds: named.slice(0, DIGEST_BUILD_ROWS),
    moreBuilds: Math.max(0, named.length - DIGEST_BUILD_ROWS),
    unclassifiedGames,
  };
}

/** @param {any} row */
function digestGameStart(row) {
  const exact = toDate(row && row.startedAt);
  if (exact) return exact;
  const end = toDate(row && row.date);
  const duration = Number(row && row.durationSec);
  if (end && Number.isFinite(duration) && duration >= 0 && duration <= 86_400) {
    return new Date(end.getTime() - Math.floor(duration) * 1000);
  }
  return end;
}

/** @param {any} row */
function serializeDigestGame(row) {
  const my = row && row._digestMyRace;
  const opp = row && row._digestOppRace;
  const result = row && row._digestResult;
  return {
    gameId: boundedText(row && row.gameId, 200),
    playedAt: isoOrNull(digestGameStart(row)),
    map: boundedText(row && row.map, 120),
    matchup: RACES.has(my) && RACES.has(opp) ? `${my}v${opp}` : null,
    result: result === "win" ? "Win" : result === "loss" ? "Loss" : null,
    build: boundedText(row && row._digestBuild, 120),
  };
}

/**
 * Shape the pipeline's single $facet document into the public digest.
 *
 * @param {any} root
 * @param {{bookingId:string, role:string, window:ReturnType<typeof digestWindow>}} context
 */
function shapeDigest(root, context) {
  const results = new Map((Array.isArray(root && root.results) ? root.results : [])
    .map((row) => [row && row._id, count(row && row.games)]));
  const wins = results.get("win") || 0;
  const losses = results.get("loss") || 0;
  const games = [...results.values()].reduce((total, value) => total + value, 0);
  const { matchups, unknownRaceGames } = matchupRows(root && root.matchups);
  const replays = (Array.isArray(root && root.recent) ? root.recent : [])
    .map(serializeDigestGame)
    .filter((game) => game.gameId);
  return {
    bookingId: context.bookingId,
    role: context.role,
    state: games > 0 ? "ready" : "no_games",
    window: {
      since: context.window.since.toISOString(),
      until: context.window.until.toISOString(),
      basis: context.window.basis,
    },
    lastSession: context.window.lastSession,
    totals: { games, wins, losses, other: Math.max(0, games - wins - losses) },
    matchups,
    unknownRaceGames,
    ...buildRows(root && root.builds),
    replays,
    moreReplays: Math.max(0, games - replays.length),
    minSample: DIGEST_MIN_SAMPLE,
    lookbackDays: DIGEST_LOOKBACK_DAYS,
  };
}

/** @param {unknown} value */
function historyLimit(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1) return HISTORY_LIMIT_DEFAULT;
  return Math.min(HISTORY_LIMIT_MAX, numeric);
}

/**
 * Per-student totals over the whole past list, not just the returned page.
 * @param {any[]} past
 */
function studentCounts(past) {
  /** @type {Map<string, {studentId:string,name:string,held:number,cancelled:number}>} */
  const byStudent = new Map();
  for (const booking of past) {
    const studentId = boundedText(booking.studentId, 200) || "unknown";
    const entry = byStudent.get(studentId) || {
      studentId,
      name: boundedText(booking.studentName, 120) || "Student",
      held: 0,
      cancelled: 0,
    };
    if (booking.status === "cancelled") entry.cancelled += 1;
    else entry.held += 1;
    byStudent.set(studentId, entry);
  }
  return [...byStudent.values()].sort((a, b) => b.held - a.held || a.name.localeCompare(b.name));
}

/**
 * The caller's past sessions (ended before now), newest first. Coaches see
 * every booking on their own calendar; a student only their own.
 *
 * @param {any[]|undefined} bookings
 * @param {{kind:"coach"}|{kind:"student",studentUserId:string}} viewer
 * @param {{limit?:unknown, now:Date, serialize:(booking:any) => any}} options
 */
function sessionHistory(bookings, viewer, options) {
  const limit = historyLimit(options.limit);
  const nowMs = options.now.getTime();
  const past = (Array.isArray(bookings) ? bookings : [])
    .filter((booking) => booking && (viewer.kind === "coach" || booking.studentUserId === viewer.studentUserId))
    .filter((booking) => {
      const end = toDate(booking.endAt);
      return Boolean(end) && /** @type {Date} */ (end).getTime() <= nowMs;
    })
    .sort((a, b) => (toDate(b.startAt)?.getTime() ?? 0) - (toDate(a.startAt)?.getTime() ?? 0));
  return {
    bookings: past.slice(0, limit).map(options.serialize),
    total: past.length,
    held: past.filter((booking) => booking.status !== "cancelled").length,
    limit,
    hasMore: past.length > limit,
    ...(viewer.kind === "coach" ? { students: studentCounts(past) } : {}),
  };
}

module.exports = {
  DIGEST_LOOKBACK_DAYS,
  DIGEST_MIN_SAMPLE,
  DIGEST_RECENT_GAMES,
  HISTORY_LIMIT_MAX,
  previousSession,
  digestWindow,
  digestGameMatch,
  digestPipeline,
  shapeDigest,
  sessionHistory,
};
