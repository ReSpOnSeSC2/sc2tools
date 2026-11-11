"use strict";

const { randomUUID } = require("crypto");
const { gamesMatchStage } = require("../util/parseQuery");
const { claimUserDataLease } = require("../middleware/userDataWriteFence");
const { stampVersion } = require("../db/schemaVersioning");
const { COLLECTIONS } = require("../config/constants");
const { sanitizeReportPrefs } = require("./reportPreferences");
const { StreamReportPublication } = require("./streamReportPublication");
const facts = require("./reportFacts");

/**
 * Post-stream reports (docs/notifications.md).
 *
 * A stream runs from the Dock's "Start new session" to its "End stream"
 * button, or until four hours pass without a game (closed by the hourly
 * reports job). ``users.streamSession.startAt`` marks the open stream.
 * Closing persists the original end time before clearing the open mark.
 * The hourly job retries abandoned builds and pending notifications.
 * Only the newest 100 finished reports per user are kept, each up to 5 kB. *
 * Viewer data stays aggregate: Crystal Ball accuracy, supporter event
 * counts and distinct viewers, never viewer names. Opponent names are not
 * stored at all.
 */

const IDLE_MS = 4 * 60 * 60 * 1000;
const KEEP = 100;
const MAX_BYTES = 5 * 1024;
const GAME_LIMIT = 300;
const MAX_POINTS = 40;
const BUILD_LEASE_MS = 15 * 60 * 1000;
const VISIBLE_REPORT = { reportState: { $ne: "building" } };

/** @param {Date} now */
function availableBuild(now) {
  return { reportState: "building", $or: [{ workerUntil: { $exists: false } }, { workerUntil: { $lte: now } }] };
}

/** @param {Date} start */
const streamIdOf = (start) => start.getTime().toString(36);

/** @param {number[]} values @param {number} max */
function downsample(values, max) {
  if (values.length <= max) return values;
  const step = (values.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => values[Math.round(i * step)]);
}

class StreamReportsService {
  /**
   * @param {Pick<import('../db/connect').DbContext, 'games'|'users'|'streamSessions'|'overlayTokens'|'multichatPredictions'|'multichatEngagementEvents'|'multichatClipMoments'>} db
   * @param {{notifications: import('./notifications').NotificationsService, logger?: import('pino').Logger|null, now?: () => number}} opts
   */
  constructor(db, opts) {
    this.db = db;
    this.notifications = opts.notifications;
    this.logger = opts.logger || null;
    this.publication = new StreamReportPublication(db);
    this.now = opts.now || Date.now;
  }

  /** Dock "Start new session": end any open stream, open a new one. @param {string} userId @param {number} startMs */
  async start(userId, startMs) {
    const nextStart = new Date(startMs);
    await this.withOwnerWrite(userId, async () => {
      const user = await this.db.users.findOne({ userId }, { projection: { _id: 0, streamSession: 1 } });
      const current = user?.streamSession?.startAt;
      if (current && current >= nextStart) return;
      const closing = current ? await this.stageClose(userId, current, "restart", nextStart) : null;
      await this.db.users.updateOne({ userId, "streamSession.startAt": { $exists: false } }, { $set: { streamSession: { startAt: nextStart } } });
      if (closing) await this.buildStagedReport(closing);
    });
  }

  /** Dock "End stream". @param {string} userId */
  async end(userId) {
    const user = await this.db.users.findOne({ userId }, { projection: { _id: 0, streamSession: 1 } });
    return user?.streamSession?.startAt ? this.finish(userId, user.streamSession.startAt, "manual") : null;
  }

  /** Hourly: close streams with four hours of quiet. */
  async closeIdle() {
    const now = this.now();
    const open = await this.db.users.find({ "streamSession.startAt": { $lte: new Date(now - IDLE_MS) } },
      { projection: { _id: 0, userId: 1, streamSession: 1 } }).limit(200).toArray();
    let closed = await this.resumeClosing(now);
    for (const user of open) {
      try {
        const startAt = new Date(user.streamSession.startAt);
        const last = await this.db.games.find(gamesMatchStage(user.userId, { since: startAt }), { projection: { _id: 0, date: 1 } })
          .sort({ date: -1 }).limit(1).toArray();
        const quietSince = Math.max(startAt.getTime(), last[0] ? new Date(last[0].date).getTime() : 0);
        if (now - quietSince < IDLE_MS) continue;
        if (await this.finish(user.userId, startAt, "idle", new Date(quietSince))) closed += 1;
      } catch (error) {
        this.logCloseError(error);
      }
    }
    return { closed };
  }

  /**
   * @param {string} userId @param {Date} startAt
   * @param {"manual"|"idle"|"restart"} reason @param {Date} [endAt]
   */
  async finish(userId, startAt, reason, endAt) {
    return this.withOwnerWrite(userId, async () => {
      const closing = await this.stageClose(userId, startAt, reason, endAt || new Date(this.now()));
      return closing ? this.buildStagedReport(closing) : null;
    });
  }

  /** Persist before clearing the active mark. Both operations are safe to retry.
   * @param {string} userId @param {Date} startAt @param {"manual"|"idle"|"restart"} endedBy @param {Date} endAt */
  async stageClose(userId, startAt, endedBy, endAt) {
    const active = { userId, "streamSession.startAt": startAt };
    const user = await this.db.users.findOne(active, { projection: { _id: 0, "preferences.reports": 1 } });
    if (!user) return null;
    const enabled = sanitizeReportPrefs(user.preferences?.reports).stream;
    const closing = { userId, streamId: streamIdOf(new Date(startAt)), startAt, endAt, endedBy, reportState: "building" };
    if (enabled) {
      const key = { userId, streamId: closing.streamId };
      try {
        await this.db.streamSessions.updateOne(key, { $setOnInsert: stampVersion(closing, COLLECTIONS.STREAM_SESSIONS) }, { upsert: true });
      } catch (error) {
        if (/** @type {any} */ (error)?.code !== 11000) throw error;
      }
    }
    const cleared = await this.db.users.updateOne(active, { $unset: { streamSession: "" } });
    return enabled && cleared.modifiedCount === 1 ? closing : null;
  }

  /** @param {{userId: string, streamId: string}} closing */
  async buildStagedReport(closing) {
    const { userId, streamId } = closing;
    const now = this.now();
    const workerId = randomUUID();
    const claimed = await this.db.streamSessions.findOneAndUpdate(
      { userId, streamId, ...availableBuild(new Date(now)) },
      { $set: { workerId, workerUntil: new Date(now + BUILD_LEASE_MS) } },
      { returnDocument: "after" },
    );
    if (!claimed) return null;
    const job = { _id: claimed._id, workerId };
    try {
      const user = await this.db.users.findOne({ userId }, { projection: { _id: 0, "preferences.reports": 1 } });
      const enabled = user && sanitizeReportPrefs(user.preferences?.reports).stream;
      const report = enabled ? await this.build(userId, claimed.startAt, claimed.endAt, claimed.endedBy) : null;
      if (!report) {
        await this.db.streamSessions.deleteOne(job);
        return null;
      }
      const saved = await this.db.streamSessions.replaceOne(job, stampVersion({ ...report, reportState: "notifying" }, COLLECTIONS.STREAM_SESSIONS));
      return saved.matchedCount ? this.notifyClosedReport(report) : null;
    } catch (error) {
      await this.db.streamSessions.updateOne(job, { $unset: { workerId: "", workerUntil: "" } }).catch(() => {});
      throw error;
    }
  }

  /** @param {any} report */
  async notifyClosedReport(report) {
    const { userId, streamId } = report;
    await this.notifications.notify(userId, { kind: "report.stream", ...streamNotice(report), href: `/app/streams/${streamId}`, eventKey: `report.stream:${streamId}` });
    const stale = await this.db.streamSessions.find({ userId, ...VISIBLE_REPORT }, { projection: { _id: 1 } }).sort({ startAt: -1 }).skip(KEEP).toArray();
    if (stale.length) await this.db.streamSessions.deleteMany({ userId, _id: { $in: stale.map((row) => row._id) } });
    await this.db.streamSessions.updateOne({ userId, streamId, reportState: "notifying" }, { $unset: { reportState: "" } });
    return summary(report);
  }

  /** @param {number} now */
  async resumeClosing(now) {
    const rows = await this.db.streamSessions.find({ $or: [{ reportState: "notifying" }, availableBuild(new Date(now))] }).sort({ endAt: 1 }).limit(200).toArray();
    let recovered = 0;
    for (const row of rows) {
      try {
        const report = await this.withOwnerWrite(row.userId, async () => {
          await this.db.users.updateOne({ userId: row.userId, "streamSession.startAt": row.startAt }, { $unset: { streamSession: "" } });
          return row.reportState === "notifying" ? this.notifyClosedReport(row) : this.buildStagedReport(row);
        });
        if (report) recovered += 1;
      } catch (error) {
        this.logCloseError(error);
      }
    }
    return recovered;
  }

  /** @template T @param {string} userId @param {() => Promise<T>} work */
  async withOwnerWrite(userId, work) {
    let lease;
    try { lease = await claimUserDataLease(this.db.users, userId); } catch (error) {
      if (/** @type {any} */ (error)?.status === 409) return null;
      throw error;
    }
    try { return await work(); } finally { await lease.release(); }
  }

  /** @param {unknown} error */
  logCloseError(error) {
    this.logger?.warn({ code: /** @type {any} */ (error)?.code || "stream_close_failed" }, "stream_close_failed");
  }

  /** @param {string} userId @param {Date} startAt @param {Date} endAt @param {string} reason */
  async build(userId, startAt, endAt, reason) {
    const rows = await this.db.games.find(gamesMatchStage(userId, { since: startAt, until: endAt }), { projection: {
      _id: 0, gameId: 1, date: 1, result: 1, myRace: 1, "opponent.race": 1, "opponent.mmr": 1, map: 1, myBuild: 1,
      myMmr: 1, myToonHandle: 1, durationSec: 1, "buildIntent.randomizer": 1,
    } }).sort({ date: 1 }).limit(GAME_LIMIT).toArray();
    if (!rows.length) return null;
    const mmr = facts.mmrByAccount(rows)[0] || null;
    const points = facts.mmrSeries(rows)[0]?.values || [];
    const doc = {
      userId, streamId: streamIdOf(startAt), startAt, endAt, endedBy: reason, createdAt: new Date(this.now()),
      ...facts.record(rows), hours: facts.hoursPlayed(rows),
      matchups: facts.groupRecords(rows, facts.matchupOf, 6),
      maps: facts.groupRecords(rows, (row) => facts.cleanName(row.map, 60), 8),
      builds: facts.groupRecords(rows, (row) => facts.cleanName(row.myBuild, 60), 5),
      mmr: mmr ? { ...mmr, points: downsample(points, MAX_POINTS) } : null,
      bestWin: bestWin(rows),
      randomizer: randomizerRecord(rows),
      ...(await this.engagement(userId, startAt, endAt)),
    };
    return fitSize(doc);
  }

  /** Aggregate viewer activity from the owner's overlay tokens. @param {string} userId @param {Date} startAt @param {Date} endAt */
  async engagement(userId, startAt, endAt) {
    const tokens = (await this.db.overlayTokens.find({ userId }, { projection: { _id: 0, token: 1 } }).limit(20).toArray())
      .map((row) => row.token).filter((token) => typeof token === "string");
    if (!tokens.length) return { crystalBall: null, supporters: null, clips: [] };
    const range = { $gte: startAt.getTime(), $lte: endAt.getTime() };
    const [rounds, events, clips] = await Promise.all([
      this.db.multichatPredictions.find({ token: { $in: tokens }, openedAt: { $gte: startAt, $lte: endAt }, settled: true,
        resolution: { $nin: ["manual", "cancelled"] } }, { projection: { _id: 0, result: 1, picks: 1 } }).limit(300).toArray(),
      this.db.multichatEngagementEvents.find({ token: { $in: tokens }, atMs: range, kind: { $type: "string" } },
        { projection: { _id: 0, userKey: 1 } }).limit(5000).toArray(),
      this.db.multichatClipMoments.find({ token: { $in: tokens }, atMs: range }, { projection: { _id: 0, atMs: 1, kind: 1, reason: 1 } })
        .sort({ atMs: 1 }).limit(8).toArray(),
    ]);
    return {
      crystalBall: crystalBall(rounds),
      supporters: events.length ? { events: events.length, viewers: new Set(events.map((row) => row.userKey)).size } : null,
      clips: clips.map((row) => ({ minute: Math.max(0, Math.round((row.atMs - startAt.getTime()) / 60_000)),
        kind: row.kind === "game-event" ? "game-event" : "chat-spike", reason: facts.cleanName(row.reason, 100) || "" })),
    };
  }

  /** @param {string} userId @param {{before?: unknown, limit?: unknown}} [query] */
  async list(userId, query = {}) {
    const limit = Math.min(50, Math.max(1, Number.parseInt(String(query.limit ?? 20), 10) || 20));
    const before = typeof query.before === "string" ? new Date(query.before) : null;
    const filter = { userId, ...VISIBLE_REPORT, ...(before && !Number.isNaN(before.getTime()) ? { startAt: { $lt: before } } : {}) };
    const rows = await this.db.streamSessions.find(filter, { projection: { _id: 0, userId: 0 } }).sort({ startAt: -1 }).limit(limit + 1).toArray();
    const items = rows.slice(0, limit).map(summary);
    return { items, nextBefore: rows.length > limit ? items[items.length - 1].startAt : null };
  }

  /** @param {string} userId @param {unknown} streamId */
  async get(userId, streamId) {
    if (typeof streamId !== "string" || !/^[0-9a-z]{6,12}$/.test(streamId)) return null;
    const doc = await this.db.streamSessions.findOne({ userId, streamId, ...VISIBLE_REPORT }, { projection: { _id: 0, userId: 0, _schemaVersion: 0, reportState: 0 } });
    if (!doc) return null;
    const { publicId, publicEpoch, ...report } = doc;
    return { ...report, startAt: new Date(doc.startAt).toISOString(), endAt: new Date(doc.endAt).toISOString(),
      createdAt: new Date(doc.createdAt).toISOString(), publication: await this.publication.status(userId, { publicId, publicEpoch }) };
  }
}

/** @param {any[]} rows */
function bestWin(rows) {
  const wins = rows.filter((row) => facts.outcome(row) === "win" && typeof row.opponent?.mmr === "number");
  const top = wins.sort((a, b) => b.opponent.mmr - a.opponent.mmr)[0];
  return top ? { gameId: String(top.gameId).slice(0, 120), map: facts.cleanName(top.map, 60), matchup: facts.matchupOf(top), opponentMmr: Math.round(top.opponent.mmr), durationSec: top.durationSec || null } : null;
}

/** @param {any[]} rows */
function randomizerRecord(rows) {
  const rolled = rows.filter((row) => row.buildIntent && row.buildIntent.randomizer);
  return rolled.length ? facts.record(rolled) : null;
}

/** @param {any[]} rounds */
function crystalBall(rounds) {
  let picks = 0; let correct = 0;
  /** @type {Set<string>} */
  const viewers = new Set();
  for (const round of rounds) {
    if (round.result !== "win" && round.result !== "loss") continue;
    for (const [key, value] of Object.entries(round.picks && typeof round.picks === "object" ? round.picks : {})) {
      const pick = /** @type {any} */ (value)?.pick;
      if (pick !== "win" && pick !== "loss") continue;
      picks += 1; viewers.add(key);
      if (pick === round.result) correct += 1;
    }
  }
  if (!rounds.length) return null;
  return { rounds: rounds.length, picks, correct, viewers: viewers.size, accuracy: picks >= 5 ? Math.round(correct / picks * 100) : null };
}

/** Trim the longest lists until the document fits MAX_BYTES. @param {any} doc */
function fitSize(doc) {
  const order = ["clips", "maps", "builds", "matchups"];
  for (let i = 0; Buffer.byteLength(JSON.stringify(doc)) > MAX_BYTES - 128 && i < 40; i += 1) {
    const key = order.find((name) => Array.isArray(doc[name]) && doc[name].length > 0);
    if (!key) break;
    doc[key] = doc[key].slice(0, -1);
  }
  return doc;
}

/** @param {any} doc */
function summary(doc) {
  return { id: doc.streamId, startAt: new Date(doc.startAt).toISOString(), endAt: new Date(doc.endAt).toISOString(),
    games: doc.games, wins: doc.wins, losses: doc.losses, hours: doc.hours, mmrDelta: doc.mmr ? doc.mmr.delta : null, endedBy: doc.endedBy };
}

/** @param {any} doc */
function streamNotice(doc) {
  const mmr = doc.mmr && doc.mmr.games >= 2 ? `, ${facts.signed(doc.mmr.delta)} MMR` : "";
  const parts = [`${doc.hours} h of games.`];
  if (doc.bestWin) parts.push(`Best win: ${doc.bestWin.matchup} on ${doc.bestWin.map} vs ${doc.bestWin.opponentMmr} MMR.`);
  if (doc.crystalBall?.accuracy !== null && doc.crystalBall?.accuracy !== undefined) parts.push(`Crystal Ball calls were ${doc.crystalBall.accuracy}% right.`);
  return { title: `Stream report: ${doc.games} game${doc.games === 1 ? "" : "s"}, ${doc.wins}–${doc.losses}${mmr}`, body: parts.join(" ") };
}

module.exports = { StreamReportsService, IDLE_MS, KEEP, MAX_BYTES, streamIdOf, fitSize, crystalBall, downsample };
