"use strict";

const { randomUUID } = require("crypto");
const { gamesMatchStage } = require("../util/parseQuery");
const { STATS_GAME_MATCH } = require("../util/gameVisibility");
const { claimUserDataLease } = require("../middleware/userDataWriteFence");
const { sanitizeReportPrefs } = require("./reportPreferences");
const { canonicalTimeZone, localParts, mondayOf, weekBounds, shiftWeek, weekKeyAt } = require("./reportTime");
const facts = require("./reportFacts");

/**
 * Weekly report: what happened in one local ISO week, next to the week
 * before (docs/notifications.md). Built on demand from the slim ``games``
 * rows; nothing is stored except the per-user delivery claim.
 *
 * Delivery: jobs/deliveryJobs.js calls ``sweep`` hourly on the existing
 * in-process timer. A user is due from Monday 09:00 to the end of
 * Wednesday in their report time zone (Settings > Preferences > Reports;
 * UTC until saved). A short-lived claim coordinates workers. The
 * completed week is recorded after eligible delivery, including muted bell rows.
 * Bell and Discord delivery keys make a retry safe after a partial write.
 */

const MIN_GAMES = 5;
const ROW_LIMIT = 3000;
const SEND_HOUR = 9;
const DELIVERY_CLAIM_MS = 15 * 60_000;
const HOUR_MS = 60 * 60 * 1000;
const CANDIDATE_TTL_MS = 6 * HOUR_MS;
const CANDIDATE_LIMIT = 20000;
const ZONE_PADDING_MS = 14 * HOUR_MS;
const PREFS_PROJECTION = { _id: 0, "preferences.reports": 1 };
const ROW_PROJECTION = {
  _id: 0, gameId: 1, date: 1, result: 1, myRace: 1, "opponent.race": 1, "opponent.strategy": 1, map: 1, myBuild: 1,
  durationSec: 1, myMmr: 1, myToonHandle: 1, macroScore: 1, "top3Leaks.name": 1,
};

/** Resolve the report week using current consent and the saved time zone.
 * @param {unknown} input @param {number} now */
function dueReport(input, now) {
  const prefs = sanitizeReportPrefs(input);
  if (!prefs.weekly) return null;
  const tz = prefs.timezone || "UTC";
  const { weekday, hour } = localParts(now, tz);
  if (weekday > 2 || (weekday === 0 && hour < SEND_HOUR)) return null;
  const week = shiftWeek(weekKeyAt(now, tz), -1);
  return week ? { week, tz } : null;
}

/** Time zones due before UTC Monday use the current UTC week.
 * @param {number} now */
function candidateWeek(now) {
  const { weekday, hour } = localParts(now, "UTC");
  if (weekday === 6 && hour >= 19) return weekKeyAt(now, "UTC");
  // UTC+14 is first due at Sunday 19:00 UTC; UTC−12 is last to finish
  // Wednesday at Thursday 12:00 UTC.
  if (weekday < 3 || (weekday === 3 && hour < 12)) return shiftWeek(weekKeyAt(now, "UTC"), -1);
  return null;
}

class WeeklyReportService {
  /**
   * @param {Pick<import('../db/connect').DbContext, 'games'|'users'>} db
   * @param {{notifications: import('./notifications').NotificationsService,
   *   sessionPolicy?: {resolve: (owner: string) => Promise<{gapMinutes: number}>}|null,
   *   logger?: import('pino').Logger|null, now?: () => number,
   *   onWeekly?: ((userId: string, report: any) => Promise<unknown>)|null}} opts
   */
  constructor(db, opts) {
    this.db = db;
    this.notifications = opts.notifications;
    this.sessionPolicy = opts.sessionPolicy || null;
    this.logger = opts.logger || null;
    this.now = opts.now || Date.now;
    this.onWeekly = opts.onWeekly || null;
    /** @type {Map<string, {ids: string[], at: number, through: number}>} */
    this.candidateCache = new Map();
    /** Under-floor builds are quiet until another eligible upload or a full scan.
     * @type {Map<string, {week:string,tz:string}>} */
    this.quietWeeks = new Map();
  }

  /** The owner's report for ``query.week`` (default: last complete week). @param {string} userId @param {{week?: unknown, tz?: unknown}} query */
  async report(userId, query) {
    const user = await this.db.users.findOne({ userId }, { projection: { _id: 0, "preferences.reports": 1 } });
    const tz = canonicalTimeZone(query.tz) || sanitizeReportPrefs(user?.preferences?.reports).timezone || "UTC";
    const current = weekKeyAt(this.now(), tz);
    const week = query.week === undefined || query.week === "latest" ? shiftWeek(current, -1) : query.week;
    if (typeof week !== "string" || !mondayOf(week) || week > current) {
      throw Object.assign(new Error("Choose a week like 2026-W45 that has started."), { status: 400, code: "invalid_week" });
    }
    const report = await this.build(userId, week, tz);
    return { ...report, navigation: { previous: shiftWeek(week, -1), next: week < current ? shiftWeek(week, 1) : null, current } };
  }

  /** @param {string} userId @param {string} week @param {string} tz */
  async build(userId, week, tz) {
    const bounds = weekBounds(week, tz);
    const previousWeek = shiftWeek(week, -1);
    const previous = previousWeek ? weekBounds(previousWeek, tz) : null;
    if (!bounds || !previous || !previousWeek) throw Object.assign(new Error("invalid_week"), { status: 400, code: "invalid_week" });
    const rows = await this.db.games.find(gamesMatchStage(userId, { since: previous.start, until: new Date(bounds.end.getTime() - 1) }),
      { projection: ROW_PROJECTION }).sort({ date: 1 }).limit(ROW_LIMIT).toArray();
    const inRange = (/** @type {any} */ row, /** @type {{start: Date, end: Date}} */ range) => {
      const t = new Date(row.date).getTime();
      return t >= range.start.getTime() && t < range.end.getTime();
    };
    const thisWeek = rows.filter((row) => inRange(row, bounds));
    const lastWeek = rows.filter((row) => inRange(row, previous));
    const gapMinutes = await this.gapMinutes(userId);
    return {
      week, previousWeek, timeZone: tz, start: bounds.start.toISOString(), end: bounds.end.toISOString(),
      totals: { ...facts.record(thisWeek), hours: facts.hoursPlayed(thisWeek), sessions: facts.sessionCount(thisWeek, gapMinutes),
        previous: { ...facts.record(lastWeek), hours: facts.hoursPlayed(lastWeek), sessions: facts.sessionCount(lastWeek, gapMinutes) } },
      matchups: matchupComparison(thisWeek, lastWeek),
      mmr: facts.mmrByAccount(thisWeek),
      maps: facts.bestAndWorst(thisWeek, (row) => facts.cleanName(row.map)),
      builds: facts.bestAndWorst(thisWeek, (row) => facts.cleanName(row.myBuild)),
      opponentStrategies: facts.groupRecords(thisWeek, (row) => facts.cleanName(row.opponent?.strategy), 3),
      macro: { ...facts.macroFacts(thisWeek), previous: facts.macroFacts(lastWeek), minGames: facts.MIN_MACRO },
      truncated: rows.length >= ROW_LIMIT,
    };
  }

  /** @param {string} userId */
  async gapMinutes(userId) {
    try { return this.sessionPolicy ? (await this.sessionPolicy.resolve(userId)).gapMinutes : 90; } catch { return 90; }
  }

  /** Hourly job entry point. @param {{limit?: number}} [opts] */
  async sweep(opts = {}) {
    const limit = opts.limit || 200;
    const now = this.now();
    let sent = 0; let built = 0;
    for (const userId of await this.candidates(now)) {
      if (built >= limit) break;
      const outcome = await this.deliverIfDue(userId, now).catch((err) => {
        this.logger?.warn({ code: err?.code || "weekly_report_failed" }, "weekly_report_failed");
        return "failed";
      });
      if (outcome === "sent" || outcome === "quiet" || outcome === "failed") built += 1;
      if (outcome === "sent") sent += 1;
    }
    return { sent, built };
  }

  /**
   * Find candidates by played date, driving discovery from the bounded
   * global createdAt index. The ingest timestamp may be days later than
   * the replay, so its range ends at this tick, not at the end of play.
   * @param {number} now
   */
  async candidates(now) {
    const week = candidateWeek(now);
    const bounds = week ? weekBounds(week, "UTC") : null;
    if (!week || !bounds) return [];
    const cached = this.candidateCache.get(week);
    if (cached?.through === now) return cached.ids;
    const incremental = cached && now > cached.through && now - cached.at < CANDIDATE_TTL_MS ? cached : null;
    const start = bounds.start.getTime() - ZONE_PADDING_MS;
    const date = { $gte: new Date(start), $lt: new Date(bounds.end.getTime() + ZONE_PADDING_MS) };
    const rows = await this.scanCandidates(date, incremental?.through ?? start, now, Boolean(incremental));
    if (incremental) {
      for (const row of rows) this.quietWeeks.delete(String(row._id));
    } else {
      this.quietWeeks.clear();
    }
    const ids = [...new Set([...(incremental?.ids ?? []), ...rows.map(row => String(row._id))])].slice(0, CANDIDATE_LIMIT);
    this.candidateCache.clear();
    this.candidateCache.set(week, { ids, at: incremental?.at ?? now, through: now });
    return ids;
  }

  /** A recent upload can make an owner cross the floor even if fewer than
   * five games arrived since the last tick. Use the indexed per-owner
   * date lookup for those changed owners only, stopping after five games.
   * @param {{ $gte: Date, $lt: Date }} date
   * @param {number} after @param {number} through @param {boolean} incremental */
  async scanCandidates(date, after, through, incremental) {
    const eligible = { ...STATS_GAME_MATCH, date, isResumedFromReplay: { $ne: true } };
    const played = incremental ? [
      { $limit: CANDIDATE_LIMIT },
      { $lookup: {
        from: this.db.games.collectionName, localField: "_id", foreignField: "userId", as: "played",
        pipeline: [{ $match: eligible }, { $limit: MIN_GAMES }, { $project: { _id: 1 } }],
      } },
      { $match: { ["played." + (MIN_GAMES - 1)]: { $exists: true } } },
    ] : [{ $match: { n: { $gte: MIN_GAMES } } }, { $limit: CANDIDATE_LIMIT }];
    return this.db.games.aggregate([
      { $match: { ...eligible, createdAt: { $gte: new Date(after), $lt: new Date(through) } } },
      { $group: { _id: "$userId", n: { $sum: 1 } } },
      ...played,
      { $project: { _id: 1 } },
    ], { hint: { createdAt: 1, _id: 1 }, allowDiskUse: true, maxTimeMS: 60_000 }).toArray();
  }

  /** @param {string} userId @param {number} now @returns {Promise<"skipped"|"quiet"|"sent">} */
  async deliverIfDue(userId, now) {
    const user = await this.db.users.findOne({ userId }, { projection: { ...PREFS_PROJECTION, "reports.weeklyWeek": 1, _gdprMutation: 1 } });
    if (!user || user._gdprMutation) return "skipped";
    const due = dueReport(user.preferences?.reports, now);
    if (!due || user.reports?.weeklyWeek === due.week) return "skipped";
    const { week } = due;
    const quiet = this.quietWeeks.get(userId);
    if (quiet?.week === week && quiet.tz === due.tz) return "skipped";
    let lease;
    try { lease = await claimUserDataLease(this.db.users, userId); } catch { return "skipped"; }
    try {
      const token = randomUUID();
      const claim = await this.claimWeek(userId, week, token);
      if (!claim) return "skipped";
      const owner = { userId, "reports.weeklyClaim.token": token };
      try {
        const schedule = dueReport(claim.preferences?.reports, this.now());
        if (schedule?.week !== week) return "skipped";
        const report = await this.build(userId, week, schedule.tz);
        await lease.assert();
        // An erasure lease does not freeze Settings. Check consent and the
        // report's time zone in the same operation that renews our claim.
        const confirmed = await this.confirmClaim(owner, schedule);
        if (!confirmed) return "skipped";
        if (report.totals.games < MIN_GAMES) {
          this.quietWeeks.set(userId, schedule);
          return "quiet";
        }
        const sent = await this.sendWeekly(userId, week, report);
        await this.db.users.updateOne(owner, { $set: { "reports.weeklyWeek": week }, $unset: { "reports.weeklyClaim": "" } });
        return sent ? "sent" : "quiet";
      } finally {
        // A stale worker cannot release a replacement worker's claim.
        await this.db.users.updateOne(owner, { $unset: { "reports.weeklyClaim": "" } }).catch(() => {});
      }
    } finally { await lease.release(); }
  }

  /** @param {string} userId @param {string} week @param {string} token */
  async claimWeek(userId, week, token) {
    const now = this.now();
    return this.db.users.findOneAndUpdate({
      userId, "reports.weeklyWeek": { $ne: week }, _gdprMutation: { $exists: false },
      $or: [
        { "reports.weeklyClaim.expiresAt": { $exists: false } },
        { "reports.weeklyClaim.expiresAt": { $lte: new Date(now) } },
      ],
    }, { $set: { "reports.weeklyClaim": { week, token, expiresAt: new Date(now + DELIVERY_CLAIM_MS) } } },
    { projection: PREFS_PROJECTION, returnDocument: "after" });
  }

  /** @param {Record<string,string>} owner @param {{week:string,tz:string}} schedule */
  async confirmClaim(owner, schedule) {
    const now = this.now();
    const current = await this.db.users.findOneAndUpdate({
      ...owner, _gdprMutation: { $exists: false }, "reports.weeklyClaim.expiresAt": { $gt: new Date(now) },
    }, { $set: { "reports.weeklyClaim.expiresAt": new Date(now + DELIVERY_CLAIM_MS) } },
    { projection: PREFS_PROJECTION, returnDocument: "after" });
    const due = current ? dueReport(current.preferences?.reports, now) : null;
    return due?.week === schedule.week && due.tz === schedule.tz;
  }

  /** @param {string} userId @param {string} week @param {Awaited<ReturnType<WeeklyReportService['build']>>} report */
  async sendWeekly(userId, week, report) {
    const kind = "report.weekly", eventKey = `report.weekly:${week}`;
    const row = await this.notifications.notify(userId, { kind, ...weeklyNotice(report), href: `/app/reports/weekly/${week}`, eventKey });
    if (this.onWeekly && (row || await this.notifications.canResumeDelivery(userId, kind, eventKey))) {
      await this.onWeekly(userId, report);
    }
    return !!row;
  }
}

/** @param {any[]} thisWeek @param {any[]} lastWeek */
function matchupComparison(thisWeek, lastWeek) {
  const previous = new Map(facts.groupRecords(lastWeek, facts.matchupOf, 20).map((row) => [row.name, row]));
  return facts.groupRecords(thisWeek, facts.matchupOf, 9).map((row) => {
    const before = previous.get(row.name);
    return { matchup: row.name, games: row.games, wins: row.wins, losses: row.losses,
      previous: before ? { games: before.games, wins: before.wins, losses: before.losses } : { games: 0, wins: 0, losses: 0 } };
  });
}

/** "Week 45: 23 games, 13–10, +86 MMR" plus a factual second line. @param {any} report */
function weeklyNotice(report) {
  const t = report.totals;
  const primary = report.mmr[0];
  const mmr = primary && primary.games >= 2 ? `, ${facts.signed(primary.delta)} MMR` : "";
  const title = `Week ${Number(String(report.week).slice(6))}: ${t.games} game${t.games === 1 ? "" : "s"}, ${t.wins}–${t.losses}${mmr}`;
  const parts = [`${t.sessions} session${t.sessions === 1 ? "" : "s"}, ${t.hours} h played.`];
  if (report.maps.best) parts.push(`Best map: ${report.maps.best.name} (${report.maps.best.wins}–${report.maps.best.losses}).`);
  if (t.previous.games) parts.push(`Previous week: ${t.previous.games} games, ${t.previous.wins}–${t.previous.losses}.`);
  return { title, body: parts.join(" ") };
}

module.exports = { WeeklyReportService, weeklyNotice, MIN_GAMES };
