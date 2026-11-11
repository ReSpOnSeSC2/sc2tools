"use strict";

const { ObjectId } = require("mongodb");
const { MATCHUPS, readStoredGhostBuildConfig } = require("./ghostConfig");
const { checkpointStats, normalizeCheckpoints } = require("./practiceCheckpoints");
const { canonicalTimeZone, localWindow, parsePlainDate } = require("../util/recurrenceBuckets");
const {
  NO_BUILD_LOG,
  decodeDrifts,
  ghostMatchupKey,
  practiceRecord,
  targetHash,
} = require("./practiceGrade");

/**
 * PracticeLogService — the private practice log.
 *
 * The target system is the synced Ghost assignment (``preferences.ghost``,
 * services/ghostConfig.js); this service adds no second one. At ingest a
 * game in a matchup whose slot was armed before the game was played gets a
 * slim ``practice`` record (services/practiceGrade.js) on its own games row,
 * written once: a later upload never regrades it. A game in that matchup
 * without a build log is recorded as ungraded so coverage stays honest.
 *
 * Every read is the owner's own: routes/practice.js passes the signed-in
 * user, and no coach, public, share or review projection includes
 * ``practice`` (the coaching no-automated-grading rule).
 */

/** Graded games one summary reads, newest first. */
const SUMMARY_SAMPLE = 200;
/** Newest graded games returned for the sparkline and the weekly plan. */
const HISTORY_LIMIT = 100;
/** "Where you fall off" lists this many steps. */
const DIVERGENCE_LIMIT = 3;
const GAMES_PAGE_DEFAULT = 20;
const GAMES_PAGE_MAX = 50;
/** "Grade my last games" hydrates at most this many build logs. */
const REQUEST_GRADE_LIMIT = 20;
/** Without an arm stamp (a slot armed before stamps existed) only a game
 * played this recently is graded, so a history re-sync never grades old
 * games against today's target. */
const UNSTAMPED_LIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
const HASH_RE = /^[0-9a-f]{16}$/;
const LIVE_ROW = { excluded: { $ne: true }, _deleted: { $ne: true }, _deletionPending: { $ne: true }, isResumedFromReplay: { $ne: true } };
const ROW_PROJECTION = { _id: 1, gameId: 1, date: 1, map: 1, result: 1, practice: 1 };

class PracticeLogService {
  /**
   * @param {{users: import('mongodb').Collection, games: import('mongodb').Collection}} db
   * @param {{gameDetails?: {findMany: (userId: string, gameIds: string[], opts?: any) => Promise<Map<string, Record<string, any>>>}, now?: () => Date}} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.gameDetails = opts.gameDetails || null;
    this.now = opts.now || (() => new Date());
  }

  /**
   * The owner's armed slots with their content hash and arm time, read once
   * per ingest batch. Null when nothing is armed.
   * @param {string} userId
   */
  async ingestContext(userId) {
    const row = await this.db.users.findOne(
      { userId },
      { projection: { _id: 0, "preferences.ghost": 1, "preferences.ghostArmedAt": 1 } },
    );
    const slots = armedSlots(row);
    return Object.keys(slots).length > 0 ? { slots } : null;
  }

  /**
   * Grade one just-stored game against its matchup's slot. Returns the record
   * written, or null when the game is out of scope or already graded.
   *
   * @param {string} userId
   * @param {Record<string, any>} game the validated ingest payload
   * @param {{slots: Record<string, ArmedSlot>} | null} context from ingestContext
   */
  async recordIngested(userId, game, context) {
    if (!context || !game || typeof game.gameId !== "string") return null;
    const matchup = ghostMatchupKey(game.myRace, game.opponent && game.opponent.race);
    const slot = matchup ? context.slots[matchup] : undefined;
    if (!matchup || !slot || slot.target.sourceGameId === game.gameId) return null;
    const date = toDate(game.date);
    const now = this.now();
    if (!date || !armedBefore(slot, date, now)) return null;
    const record = practiceRecord({ target: slot.target, hash: slot.hash, matchup, buildLog: game.buildLog, via: "ingest", gradedAt: now, checkpoints: slot.checkpoints });
    return (await this._store(userId, game.gameId, record)) ? record : null;
  }

  /**
   * Write a record once. Only a game recorded as ungraded for the same target
   * may be upgraded by a later upload that carries its build log.
   * @private @param {string} userId @param {string} gameId @param {Record<string, any>} record
   */
  async _store(userId, gameId, record) {
    const result = await this.db.games.updateOne(
      {
        userId,
        gameId,
        $or: [
          { practice: { $exists: false } },
          { "practice.status": NO_BUILD_LOG, "practice.targetHash": record.targetHash },
        ],
      },
      { $set: { practice: record } },
    );
    return result.modifiedCount > 0;
  }

  /**
   * Progress for one matchup's target: the armed one, or ``targetHash``.
   * One owner read plus one bounded indexed read of the newest
   * SUMMARY_SAMPLE practice rows in the matchup.
   *
   * @param {string} userId
   * @param {{matchup?: unknown, targetHash?: unknown}} query
   */
  async summary(userId, query) {
    const matchup = parseMatchup(query.matchup);
    const requested = parseHash(query.targetHash);
    const [row, rows] = await Promise.all([
      this.db.users.findOne({ userId }, { projection: { _id: 0, "preferences.ghost": 1, "preferences.ghostArmedAt": 1 } }),
      this.db.games
        .find({ userId, practice: { $exists: true }, "practice.matchup": matchup, ...LIVE_ROW }, { projection: ROW_PROJECTION })
        .sort({ date: -1 })
        .limit(SUMMARY_SAMPLE + 1)
        .toArray(),
    ]);
    const capped = rows.length > SUMMARY_SAMPLE;
    const sample = capped ? rows.slice(0, SUMMARY_SAMPLE) : rows;
    const armed = armedSlots(row)[matchup] || null;
    const hash = requested || (armed ? armed.hash : null);
    const mine = sample.filter((game) => game.practice.targetHash === hash);
    const graded = mine.filter((game) => typeof game.practice.grade === "string");
    const current = armed?.hash === hash ? armed : null;
    return {
      matchup,
      target: describeTarget(hash, armed, mine),
      targets: targetsOf(sample, armed),
      sample: { graded: graded.length, ungraded: mine.length - graded.length, limit: SUMMARY_SAMPLE, capped },
      grades: gradeCounts(graded),
      history: graded.slice(0, HISTORY_LIMIT).map(historyRow),
      divergence: divergenceSteps(graded),
      steps: current ? stepStats(current.target, graded) : null,
      checkpoints: summarizeCheckpoints(current, graded),
    };
  }

  /**
   * One page of graded games for a matchup (and target), newest first.
   * @param {string} userId
   * @param {{matchup?: unknown, targetHash?: unknown, cursor?: unknown, limit?: unknown}} query
   */
  async games(userId, query) {
    const matchup = parseMatchup(query.matchup);
    const hash = parseHash(query.targetHash);
    const limit = clampLimit(query.limit);
    const cursor = parseCursor(query.cursor);
    /** @type {Record<string, any>} */
    const match = { userId, practice: { $exists: true }, "practice.matchup": matchup, ...LIVE_ROW };
    if (hash) match["practice.targetHash"] = hash;
    if (cursor) match.$or = [{ date: { $lt: cursor.date } }, { date: cursor.date, _id: { $lt: cursor.id } }];
    const rows = await this.db.games.find(match, { projection: ROW_PROJECTION }).sort({ date: -1, _id: -1 }).limit(limit + 1).toArray();
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(gameRow),
      nextCursor: rows.length > limit && last ? `${last.date.getTime()}.${String(last._id)}` : null,
    };
  }

  /** The stored record of one owned game, or null.
   * @param {string} userId @param {string} gameId */
  async game(userId, gameId) {
    const row = await this.db.games.findOne(
      { userId, gameId, practice: { $exists: true }, ...LIVE_ROW },
      { projection: { _id: 0, practice: 1 } },
    );
    return row ? row.practice : null;
  }

  /** Update private checkpoint criteria only if the slot and draft are current.
   * @param {string} userId @param {{matchup?:unknown,targetHash?:unknown,checkpoints?:unknown,expected?:unknown}} body */
  async saveCheckpoints(userId, body) {
    const matchup = parseMatchup(body.matchup);
    const hash = parseHash(body.targetHash);
    if (!hash) throw failure("invalid_practice_target", 400);
    const path = `preferences.ghost.slots.${matchup}`;
    const row = await this.db.users.findOne({ userId }, { projection: { _id: 0, [path]: 1 } });
    const raw = row?.preferences?.ghost?.slots?.[matchup];
    const target = readStoredGhostBuildConfig({ v: 2, slots: { [matchup]: raw } })?.slots[matchup];
    if (!target || targetHash(target) !== hash) throw failure("practice_target_changed", 409);
    const next = normalizeCheckpoints(body.checkpoints, target.steps.length);
    const expected = normalizeCheckpoints(body.expected, target.steps.length);
    if (!next || !expected) throw failure("invalid_practice_checkpoints", 400);
    const current = normalizeCheckpoints(raw.checkpoints, target.steps.length) ?? [];
    if (JSON.stringify(expected) !== JSON.stringify(current)) throw failure("practice_target_changed", 409);
    const result = await this.db.users.updateOne({ userId, [path]: { $eq: raw } }, { $set: { [path]: { ...target, checkpoints: next } } });
    if (!result.matchedCount) throw failure("practice_target_changed", 409);
    return { checkpoints: next };
  }

  /** A private, bounded result for one Arcade local day. @param {string} userId
   * @param {{day?:unknown,tz?:unknown}} query */
  async dailyQuest(userId, query) {
    const { startsAt, endsAt } = questWindow(query.day, query.tz);
    const [context, result] = await Promise.all([
      this.ingestContext(userId),
      this.db.games.findOne({ userId, ...LIVE_ROW, date: { $gte: startsAt, $lt: endsAt },
        "practice.via": "ingest", "practice.grade": { $in: ["S", "A", "B"] },
      }, { projection: { _id: 1 }, maxTimeMS: 2000 }),
    ]);
    return { eligible: !!context || !!result, done: !!result };
  }

  /**
   * "Grade my last games": the newest ungraded games of the matchup, at most
   * REQUEST_GRADE_LIMIT, graded against the armed target on request. Each is
   * labelled ``via: "request"``; already graded games are never touched.
   *
   * @param {string} userId @param {{matchup?: unknown}} query
   */
  async gradeRecent(userId, query) {
    const matchup = parseMatchup(query.matchup);
    if (!this.gameDetails) throw failure("practice_unavailable", 503);
    const context = await this.ingestContext(userId);
    const slot = context ? context.slots[matchup] : undefined;
    if (!slot) throw failure("practice_target_required", 409);
    // A validated matchup key is "<own race>v<their race>", e.g. "PvZ".
    const races = { mine: /** @type {"P"|"T"|"Z"} */ (matchup[0]), theirs: /** @type {"P"|"T"|"Z"} */ (matchup[2]) };
    const candidates = await this.db.games
      .find(
        { userId, practice: { $exists: false }, myRace: raceMatch(races.mine), "opponent.race": raceMatch(races.theirs), ...LIVE_ROW },
        { projection: { _id: 0, gameId: 1, buildLog: 1 }, maxTimeMS: 5000 },
      )
      .sort({ date: -1 })
      .limit(REQUEST_GRADE_LIMIT + 1)
      .toArray();
    const selected = candidates.filter((row) => row.gameId !== slot.target.sourceGameId).slice(0, REQUEST_GRADE_LIMIT);
    const ids = selected.filter((row) => !Array.isArray(row.buildLog)).map((row) => row.gameId);
    const details = ids.length > 0 ? await this.gameDetails.findMany(userId, ids, { fields: ["buildLog"], concurrency: 2 }) : new Map();
    let graded = 0;
    const gradedAt = this.now();
    for (const { gameId, buildLog } of selected) {
      const ownLog = Array.isArray(buildLog) ? buildLog : details.get(gameId)?.buildLog;
      const record = practiceRecord({ target: slot.target, hash: slot.hash, matchup, buildLog: ownLog, via: "request", gradedAt, checkpoints: slot.checkpoints });
      const stored = await this._store(userId, gameId, record);
      if (stored && record.grade) graded += 1;
    }
    return { matchup, considered: selected.length, graded };
  }
}

/**
 * @typedef {{
 *   target: {v: 1, name: string, steps: Array<{name: string, t: number, supply: number|null}>, sourceGameId?: string},
 *   hash: string,
 *   armedAt: Date | null,
 *   checkpoints: import('./practiceCheckpoints').Checkpoint[],
 * }} ArmedSlot
 */

/** @param {any} row @returns {Record<string, ArmedSlot>} */
function armedSlots(row) {
  const prefs = row && row.preferences;
  const config = readStoredGhostBuildConfig(prefs && prefs.ghost);
  if (!config) return {};
  const stamps = prefs.ghostArmedAt && typeof prefs.ghostArmedAt === "object" ? prefs.ghostArmedAt : {};
  /** @type {Record<string, ArmedSlot>} */
  const out = {};
  for (const [matchup, target] of Object.entries(config.slots)) {
    const hash = targetHash(target);
    const stamp = stamps[matchup];
    const armedAt = stamp && stamp.hash === hash && stamp.at instanceof Date && !Number.isNaN(stamp.at.getTime()) ? stamp.at : null;
    const checkpoints = normalizeCheckpoints(prefs.ghost.slots[matchup]?.checkpoints, target.steps.length) ?? [];
    out[matchup] = { target, hash, armedAt, checkpoints };
  }
  return out;
}

/** @param {ArmedSlot} slot @param {Date} date @param {Date} now */
function armedBefore(slot, date, now) {
  if (slot.armedAt) return date.getTime() >= slot.armedAt.getTime();
  const age = now.getTime() - date.getTime();
  return age >= 0 && age <= UNSTAMPED_LIVE_WINDOW_MS;
}

/** @param {string|null} hash @param {ArmedSlot|null} armed @param {Array<any>} rows */
function describeTarget(hash, armed, rows) {
  if (!hash) return null;
  if (armed && armed.hash === hash) {
    return {
      hash,
      name: armed.target.name,
      current: true,
      armedAt: armed.armedAt ? armed.armedAt.toISOString() : null,
      steps: armed.target.steps.map((step, i) => ({ i, name: step.name, t: step.t, supply: step.supply })),
    };
  }
  const named = rows.find((game) => typeof game.practice.targetName === "string");
  return { hash, name: named ? named.practice.targetName : null, current: false, armedAt: null, steps: null };
}

/** @param {ArmedSlot|null} current @param {any[]} graded */
function summarizeCheckpoints(current, graded) {
  const rules = current
    ? current.checkpoints.map((point) => ({ ...point, name: current.target.steps[point.i].name }))
    : graded.find((game) => game.practice.checkpoints?.length)?.practice.checkpoints ?? [];
  return checkpointStats(rules, graded);
}

/** @param {unknown} day @param {unknown} tz */
function questWindow(day, tz) {
  const zone = canonicalTimeZone(tz);
  if (!zone) throw failure("invalid_practice_day", 400);
  try {
    const date = parsePlainDate(day, "day");
    const window = localWindow(date, date, zone);
    if (window) return window;
  } catch { /* An invalid calendar date has no quest window. */ }
  throw failure("invalid_practice_day", 400);
}

/** Every target seen in the sample, the armed one first.
 * @param {Array<any>} rows @param {ArmedSlot|null} armed */
function targetsOf(rows, armed) {
  /** @type {Map<string, {hash: string, name: string|null, games: number, lastPlayed: string|null, current: boolean}>} */
  const byHash = new Map();
  if (armed) byHash.set(armed.hash, { hash: armed.hash, name: armed.target.name, games: 0, lastPlayed: null, current: true });
  for (const game of rows) {
    const hash = game.practice.targetHash;
    if (typeof hash !== "string") continue;
    const entry = byHash.get(hash) || { hash, name: game.practice.targetName || null, games: 0, lastPlayed: null, current: false };
    entry.games += 1;
    if (!entry.lastPlayed && game.date instanceof Date) entry.lastPlayed = game.date.toISOString();
    byHash.set(hash, entry);
  }
  return [...byHash.values()].slice(0, 10);
}

/** @param {Array<any>} graded */
function gradeCounts(graded) {
  /** @type {Record<string, number>} */
  const counts = { S: 0, A: 0, B: 0, C: 0, D: 0 };
  for (const game of graded) if (Object.hasOwn(counts, game.practice.grade)) counts[game.practice.grade] += 1;
  return counts;
}

/** @param {any} game */
function historyRow(game) {
  const p = game.practice;
  return { gameId: game.gameId, date: game.date.toISOString(), grade: p.grade, avgDrift: p.avgDrift, matched: p.matched, total: p.total, via: p.via };
}

/** The steps where games most often first left the build.
 * @param {Array<any>} graded */
function divergenceSteps(graded) {
  /** @type {Map<number, {i: number, name: string, games: number, cut: number}>} */
  const byStep = new Map();
  for (const game of graded) {
    const d = game.practice.firstDivergence;
    if (!d || !Number.isInteger(d.i)) continue;
    const entry = byStep.get(d.i) || { i: d.i, name: String(d.name || ""), games: 0, cut: 0 };
    entry.games += 1;
    if (d.actualT === null) entry.cut += 1;
    byStep.set(d.i, entry);
  }
  return [...byStep.values()].sort((a, b) => b.games - a.games || a.i - b.i).slice(0, DIVERGENCE_LIMIT);
}

/** Hit rate and mean signed drift of each step of the armed target.
 * @param {ArmedSlot["target"]} target @param {Array<any>} graded */
function stepStats(target, graded) {
  const decoded = graded.map((game) => decodeDrifts(game.practice.drifts)).filter((d) => d.length === target.steps.length);
  return target.steps.map((step, i) => {
    const drifts = decoded.map((d) => d[i]);
    const hit = drifts.filter((d) => typeof d === "number");
    return {
      i,
      name: step.name,
      t: step.t,
      games: drifts.length,
      hit: hit.length,
      avgDrift: hit.length ? Math.round((hit.reduce((a, b) => a + /** @type {number} */ (b), 0) / hit.length) * 10) / 10 : null,
    };
  });
}

/** @param {any} game */
function gameRow(game) {
  const p = game.practice;
  return {
    gameId: game.gameId,
    date: game.date instanceof Date ? game.date.toISOString() : null,
    map: typeof game.map === "string" ? game.map : null,
    result: typeof game.result === "string" ? game.result : null,
    practice: {
      targetHash: p.targetHash, targetName: p.targetName, status: p.status || "graded",
      grade: p.grade ?? null, matched: p.matched ?? null, total: p.total ?? null,
      avgDrift: p.avgDrift ?? null, maxDrift: p.maxDrift ?? null,
      firstDivergence: p.firstDivergence ?? null, worstSteps: Array.isArray(p.worstSteps) ? p.worstSteps : [],
      via: p.via,
    },
  };
}

/** @param {"P"|"T"|"Z"} letter */
function raceMatch(letter) {
  const word = { P: "Protoss", T: "Terran", Z: "Zerg" }[letter];
  return { $in: [letter, word, letter.toLowerCase(), word.toLowerCase()] };
}

/** @param {unknown} raw @returns {string} */
function parseMatchup(raw) {
  if (typeof raw !== "string" || !MATCHUPS.includes(raw)) throw failure("invalid_practice_matchup", 400);
  return raw;
}

/** @param {unknown} raw */
function parseHash(raw) {
  if (raw === undefined || raw === "") return null;
  if (typeof raw !== "string" || !HASH_RE.test(raw)) throw failure("invalid_practice_target", 400);
  return raw;
}

/** @param {unknown} raw */
function clampLimit(raw) {
  const n = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return GAMES_PAGE_DEFAULT;
  return Math.min(GAMES_PAGE_MAX, n);
}

/** ``<epoch ms>.<ObjectId hex>`` from a previous page.
 * @param {unknown} raw @returns {{date: Date, id: ObjectId} | null} */
function parseCursor(raw) {
  if (raw === undefined || raw === "") return null;
  const m = typeof raw === "string" ? /^(\d{1,15})\.([0-9a-f]{24})$/.exec(raw) : null;
  if (!m) throw failure("invalid_practice_cursor", 400);
  return { date: new Date(Number(m[1])), id: new ObjectId(m[2]) };
}

/** @param {unknown} value */
function toDate(value) {
  const date = value instanceof Date ? value : new Date(/** @type {any} */ (value));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** @param {string} code @param {number} status */
function failure(code, status) {
  return Object.assign(new Error(code), { code, status });
}

module.exports = {
  PracticeLogService,
  SUMMARY_SAMPLE,
  REQUEST_GRADE_LIMIT,
  UNSTAMPED_LIVE_WINDOW_MS,
  armedSlots,
};
