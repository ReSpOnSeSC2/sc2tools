"use strict";

const crypto = require("crypto");
const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");
const { gamesMatchStage } = require("../util/parseQuery");
const { rankedHistoryCohort } = require("./rankedHistoryCohort");
const { recordedRating } = require("./gameMomentRules");
const { LIVE_GAME_MATCH, STATS_GAME_MATCH } = require("../util/gameVisibility");
const { SHARE_TOKEN_RE } = require("./gameShares");
const { bandFromId } = require("../util/leagueBands");
const { buildJobLock } = require("../util/jobLock");
const { claimUserDataLease } = require("../middleware/userDataWriteFence");
const { encryptSecret, decryptSecret, parseTokenEncryptionKey } = require("./platformCredentialVault");
const templates = require("./discordTemplates");
const facts = require("./reportFacts");

/**
 * "Post to Discord" through the user's own channel webhooks
 * (docs/notifications.md). Default off, opt-in per hook and per event.
 *
 * Safety: only ``https://(canary.|ptb.)discord(app).com/api/webhooks/<id>/<token>``
 * is accepted (no other host, port, query or redirect is ever requested),
 * the URL is AES-GCM encrypted with PLATFORM_TOKEN_ENCRYPTION_KEY through
 * the platform credential vault helpers and bound to its owner and hook
 * id, and only its last four characters are ever shown, exported or
 * logged (logs carry the hook id only). Without that key the feature is
 * unavailable.
 *
 * Delivery: producers only enqueue into ``discord_outbox`` with a unique
 * ``dedupeKey`` per hook and event, so retries never double-post. The
 * 30-second outbox job drains at most 20 due rows under a jobLock, honours
 * Discord's 429 ``retry_after``, backs off exponentially on 5xx/network
 * errors and gives up after five attempts. Three consecutive 401/404
 * answers disable the hook and tell its owner. Rows expire after 7 days.
 * Nothing is sent while the account is being erased.
 */

const URL_RE = /^https:\/\/(canary\.|ptb\.)?discord(app)?\.com\/api\/webhooks\/\d{5,25}\/[\w-]{20,200}$/;
const MAX_HOOKS = 3;
const DRAIN_BATCH = 20;
const MAX_ATTEMPTS = 5;
const SEND_TIMEOUT_MS = 10_000;
const OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TEST_COOLDOWN_MS = 30_000;
const DISABLE_AFTER = 3;
const EVENTS = ["result", "session", "weekly", "milestone"];
const PEAK_MIN_HISTORY = 20;
const REPLAY_RATING_POLICY = 1;
const RANKED_RESULT_PROJECTION = {
  _id: 0, gameId: 1, date: 1, result: 1, myRace: 1, myLadderRace: 1, myToonHandle: 1,
  matchFormat: 1, playerCount: 1, myLeagueId: 1, myMmr: 1, myMmrSource: 1,
  myBuild: 1, map: 1, durationSec: 1, "opponent.displayName": 1, "opponent.race": 1,
  "opponent.mmr": 1, "opponent.mmrSource": 1,
};
/** @param {number} status @param {string} code @param {string} msg */
function discordError(status, code, msg) { return Object.assign(new Error(msg), { status, code }); }

/** @param {unknown} raw @returns {string|null} */
function validWebhookUrl(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value.length <= 300 && URL_RE.test(value) ? value : null;
}

/** @param {unknown} raw */
function cleanLabel(raw) {
  const text = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 40) : "";
  return text || "Discord channel";
}

/** @param {unknown} raw @param {Record<string, boolean>} fallback */
function cleanEvents(raw, fallback) {
  const value = /** @type {Record<string, unknown>} */ (raw && typeof raw === "object" ? raw : {});
  return Object.fromEntries(EVENTS.map((key) => [key, typeof value[key] === "boolean" ? Boolean(value[key]) : fallback[key] !== false]));
}

/** @param {number} attempts */
function backoffMs(attempts) { return Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1)); }

/** Public projection of a hook: never the URL or its ciphertext. @param {any} hook */
function publicHook(hook) {
  return {
    id: hook._id, label: hook.label, last4: hook.last4, events: cleanEvents(hook.events, {}), options: templates.hookOptions(hook.options),
    enabled: hook.enabled === true, status: hook.status, disabledReason: hook.disabledReason || null, failureCount: hook.failureCount || 0,
    previewed: Boolean(hook.previewedAt), lastPostAt: hook.lastPostAt ? new Date(hook.lastPostAt).toISOString() : null,
    lastResult: hook.lastResult || null, createdAt: new Date(hook.createdAt).toISOString(),
  };
}

class DiscordWebhooksService {
  /**
   * @param {Pick<import('../db/connect').DbContext, 'discordHooks'|'discordOutbox'|'gameShares'|'games'|'users'> & {db?: import('mongodb').Db}} db
   * @param {{encryptionKey?: string|null, fetchImpl?: typeof fetch, notifications?: import('./notifications').NotificationsService|null,
   *   sessionPolicy?: {resolve: (owner: string) => Promise<{gapMinutes: number}>}|null,
   *   weekly?: {report: (userId: string, query: {week?: unknown, tz?: unknown}) => Promise<any>}|null,
   *   logger?: import('pino').Logger|null, now?: () => number}} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.key = opts.encryptionKey ? parseTokenEncryptionKey(opts.encryptionKey) : null;
    this.fetchImpl = opts.fetchImpl || fetch;
    this.notifications = opts.notifications || null;
    this.sessionPolicy = opts.sessionPolicy || null;
    this.weekly = opts.weekly || null;
    this.logger = opts.logger || null;
    this.now = opts.now || Date.now;
    this.lock = db.db ? buildJobLock({ collection: db.db.collection("jobLocks"), key: "discordOutbox", leaseMs: 2 * 60_000, now: this.now }) : null;
    /** @type {Map<string, number>} */
    this.lastTest = new Map();
  }

  get available() { return this.key !== null; }

  /** @param {string} userId @param {string} hookId */
  aad(userId, hookId) { return `discord-webhook:v1:${userId}:${hookId}`; }

  /** @param {string} userId */
  async list(userId) {
    const hooks = this.available ? await this.db.discordHooks.find({ userId }).sort({ createdAt: 1 }).limit(MAX_HOOKS).toArray() : [];
    return { available: this.available, maxHooks: MAX_HOOKS, hooks: hooks.map(publicHook) };
  }

  /** @param {string} userId @param {{url?: unknown, label?: unknown}} body */
  async create(userId, body) {
    if (!this.key) throw discordError(503, "discord_unavailable", "Posting to Discord is not available on this server yet.");
    const url = validWebhookUrl(body.url);
    if (!url) throw discordError(400, "invalid_webhook_url", "Paste a Discord webhook URL: https://discord.com/api/webhooks/… (Server Settings → Integrations → Webhooks → Copy Webhook URL).");
    if (await this.db.discordHooks.countDocuments({ userId }, { limit: MAX_HOOKS }) >= MAX_HOOKS) {
      throw discordError(409, "discord_hook_limit", `You can connect up to ${MAX_HOOKS} Discord channels. Remove one first.`);
    }
    const hookId = `dh_${crypto.randomBytes(12).toString("base64url")}`;
    const now = new Date(this.now());
    const hook = stampVersion({
      _id: hookId, userId, label: cleanLabel(body.label), enc: encryptSecret(url, this.key, this.aad(userId, hookId)), last4: url.slice(-4),
      events: cleanEvents(null, {}), options: { ...templates.DEFAULT_OPTIONS }, enabled: false, status: "active", disabledReason: null,
      failureCount: 0, previewedAt: null, enabledAt: null, lastPostAt: null, lastResult: null, createdAt: now, updatedAt: now,
    }, COLLECTIONS.DISCORD_HOOKS);
    await this.db.discordHooks.insertOne(hook);
    return publicHook(hook);
  }

  /** @param {string} userId @param {string} hookId @param {Record<string, unknown>} patch */
  async update(userId, hookId, patch) {
    const hook = await this.ownHook(userId, hookId);
    /** @type {Record<string, unknown>} */
    const set = { updatedAt: new Date(this.now()) };
    if (patch.label !== undefined) set.label = cleanLabel(patch.label);
    if (patch.events !== undefined) set.events = cleanEvents(patch.events, cleanEvents(hook.events, {}));
    if (patch.options !== undefined) set.options = templates.hookOptions({ ...templates.hookOptions(hook.options), ...(/** @type {object} */ (patch.options) || {}) });
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== "boolean") throw discordError(400, "invalid_enabled", "enabled must be true or false.");
      if (patch.enabled && !hook.previewedAt) throw discordError(409, "preview_required", "Preview the posts before turning this channel on.");
      set.enabled = patch.enabled;
      if (patch.enabled) Object.assign(set, { status: "active", disabledReason: null, failureCount: 0, enabledAt: new Date(this.now()) });
    }
    const saved = await this.db.discordHooks.findOneAndUpdate({ _id: hook._id, userId }, { $set: set }, { returnDocument: "after" });
    if (patch.enabled === false) await this.db.discordOutbox.deleteMany({ hookId: hook._id, status: "queued" });
    return publicHook(saved || hook);
  }

  /** @param {string} userId @param {string} hookId */
  async remove(userId, hookId) {
    const res = await this.db.discordHooks.deleteOne({ _id: String(hookId), userId });
    await this.db.discordOutbox.deleteMany({ hookId: String(hookId), userId });
    return { removed: res.deletedCount || 0 };
  }

  /** @param {string} userId @param {string} hookId */
  async ownHook(userId, hookId) {
    const hook = this.available ? await this.db.discordHooks.findOne({ _id: String(hookId).slice(0, 64), userId }) : null;
    if (!hook) throw discordError(404, "discord_hook_not_found", "That Discord channel is not connected.");
    return hook;
  }

  /** Send the connection test right away (not through the outbox). @param {string} userId @param {string} hookId */
  async test(userId, hookId) {
    const hook = await this.ownHook(userId, hookId);
    if (this.now() - (this.lastTest.get(hook._id) || 0) < TEST_COOLDOWN_MS) throw discordError(429, "discord_test_cooldown", "Wait half a minute between tests.");
    this.lastTest.set(hook._id, this.now());
    if (this.lastTest.size > 5000) this.lastTest.clear();
    const status = await this.post(hook, templates.testMessage());
    const result = status >= 200 && status < 300 ? "sent" : status === 401 || status === 404 ? "webhook_gone" : status === 429 ? "rate_limited" : "failed";
    await this.db.discordHooks.updateOne({ _id: hook._id }, { $set: { lastResult: result, ...(result === "sent" ? { lastPostAt: new Date(this.now()) } : {}) } });
    return { result };
  }

  /**
   * What a post of ``kind`` would look like with this hook's options, from
   * the owner's own latest data (or an example when there is none yet).
   * Viewing a preview is what allows the hook to be enabled.
   * @param {string} userId @param {string} hookId @param {unknown} kind
   */
  async preview(userId, hookId, kind) {
    if (kind !== undefined && !EVENTS.includes(/** @type {string} */ (kind))) throw discordError(400, "invalid_preview_kind", `Preview one of: ${EVENTS.join(", ")}.`);
    const hook = await this.ownHook(userId, hookId);
    const options = templates.hookOptions(hook.options);
    const previews = [];
    for (const name of EVENTS) {
      if (kind !== undefined && kind !== name) continue;
      previews.push({ kind: name, ...(await this.previewOne(userId, name, options)) });
    }
    await this.db.discordHooks.updateOne({ _id: hook._id }, { $set: { previewedAt: new Date(this.now()) } });
    return { previews };
  }

  /** @param {string} userId @param {string} kind @param {ReturnType<typeof templates.hookOptions>} options */
  async previewOne(userId, kind, options) {
    const latest = await this.db.games.find(gamesMatchStage(userId, {}), { projection: { _id: 0 } }).sort({ date: -1 }).limit(1).toArray();
    const game = latest[0] || { result: "Victory", myRace: "Protoss", map: "Example map", myBuild: "Example build", myMmr: 4000,
      myMmrSource: "replay", durationSec: 742, opponent: { race: "Zerg", mmr: 3980, mmrSource: "replay", displayName: "Opponent" } };
    const example = !latest[0];
    if (kind === "result") return { example, payload: templates.resultMessage(game, { options }) };
    if (kind === "milestone") return { example: true, payload: templates.milestoneMessage({ mmr: 4001, previousPeak: 4000, race: "Protoss" }, { options }) };
    if (kind === "weekly" && this.weekly) {
      const report = await this.weekly.report(userId, {}).catch(() => null);
      if (report && report.totals.games) return { example: false, payload: templates.weeklyMessage(report, { options }) };
    }
    if (kind === "weekly") return { example: true, payload: templates.weeklyMessage(exampleWeek(), { options }) };
    const session = await this.lastSession(userId, Infinity);
    return { example: !session, payload: templates.sessionMessage(session || exampleSession(this.now()), { options }) };
  }

  /**
   * Queue one post for every enabled hook subscribed to ``kind``.
   * @param {string} userId @param {string} kind @param {string} eventKey
   * @param {(options: ReturnType<typeof templates.hookOptions>) => Record<string, unknown>} build
   * @param {{hookId?: string, shareToken?: string, replaySlug?: string|null, sessionStartAt?: Date}} [delivery]
   */
  async enqueue(userId, kind, eventKey, build, delivery = {}) {
    if (!this.available) return 0;
    const hooks = await this.db.discordHooks.find({ userId, enabled: true, status: "active", [`events.${kind}`]: true,
      ...(delivery.hookId ? { _id: delivery.hookId, "options.replayLink": true } : {}),
      ...(delivery.sessionStartAt ? { enabledAt: { $lte: delivery.sessionStartAt } } : {}),
    }).limit(MAX_HOOKS).toArray();
    let queued = 0;
    for (const hook of hooks) {
      const now = this.now();
      const options = templates.hookOptions(hook.options);
      const row = stampVersion({
        _id: `do_${crypto.randomBytes(12).toString("base64url")}`, userId, hookId: hook._id, kind,
        dedupeKey: crypto.createHash("sha256").update(`${hook._id}:${eventKey}`).digest("base64url"),
        payload: build(options), options, hookEnabledAt: hook.enabledAt || null, attempts: 0, status: "queued",
        ...(delivery.shareToken ? { shareToken: delivery.shareToken } : {}),
        ...(kind === "milestone" || (kind === "result" && !delivery.shareToken) ? { ratingPolicy: REPLAY_RATING_POLICY } : {}),
        ...(delivery.replaySlug && options.replayLink ? { replaySlug: delivery.replaySlug } : {}),
        nextAttemptAt: new Date(now), createdAt: new Date(now), expiresAt: new Date(now + OUTBOX_TTL_MS),
      }, COLLECTIONS.DISCORD_OUTBOX);
      try { await this.db.discordOutbox.insertOne(row); queued += 1; }
      catch (err) { if (/** @type {any} */ (err)?.code !== 11000) throw err; }
    }
    return queued;
  }

  /** Ingest hook for a just-finished ranked game.
   * @param {string} userId @param {{gameId?: unknown, isLadderGame?: unknown}} candidate */
  async onFreshGame(userId, candidate) {
    const gameId = candidate?.gameId;
    if (!this.available || candidate?.isLadderGame !== true || typeof gameId !== "string") return;
    const hooks = await this.db.discordHooks.find({ userId, enabled: true, status: "active", $or: [{ "events.result": true }, { "events.milestone": true }] },
      { projection: { _id: 1 } }).limit(1).toArray();
    if (!hooks.length) return;
    await this.withLease(userId, async () => {
      // The compact overlay candidate only identifies the game. Use the
      // committed label and rating provenance in this private delivery lane.
      const game = await this.db.games.findOne({ userId, gameId, ...STATS_GAME_MATCH, isLadderGame: true, isResumedFromReplay: { $ne: true } },
        { projection: RANKED_RESULT_PROJECTION });
      if (game) await this.queueGame(userId, game);
    });
  }

  /** @param {string} userId @param {any} game */
  async queueGame(userId, game) {
    const user = await this.db.users.findOne({ userId }, { projection: { _id: 0, replaySharing: 1 } });
    const slug = user?.replaySharing?.enabled === true && typeof user.replaySharing.slug === "string" ? user.replaySharing.slug : null;
    const ownMmr = recordedRating(game);
    const cohort = rankedHistoryCohort(userId, game);
    const ratedHistory = ownMmr !== null && cohort ? { ...cohort.match, myMmrSource: "replay", myMmr: { $type: "number", $gt: 0, $lte: 9999 } } : null;
    const projection = { _id: 0, myMmr: 1, myMmrSource: 1 };
    // The replay rating is observed at match start. A change from the
    // previous start belongs to an earlier game, not the result being posted.
    await this.enqueue(userId, "result", `result:${game.gameId}`, (options) => templates.resultMessage(game, { options, replaySlug: slug }), { replaySlug: slug });
    if (await this.queuePromotion(userId, game, cohort) || !ratedHistory || !cohort || ownMmr === null) return;
    // Avoid the historical sort for ordinary results below an existing peak.
    const higher = await this.db.games.findOne({ ...ratedHistory, myMmr: { ...ratedHistory.myMmr, $gte: ownMmr } }, { projection: { _id: 1 } });
    if (higher) return;
    const history = await this.db.games.find(ratedHistory, { projection }).sort({ myMmr: -1 }).limit(PEAK_MIN_HISTORY).toArray();
    const previousPeak = history[0] ? recordedRating(history[0]) : null;
    if (history.length < PEAK_MIN_HISTORY || previousPeak === null || previousPeak >= ownMmr || history.some(row => recordedRating(row) === null)) return;
    const milestone = { mmr: ownMmr, previousPeak, race: cohort.race };
    await this.enqueue(userId, "milestone", `peak:${cohort.handle}:${cohort.race}:${ownMmr}`, (options) => templates.milestoneMessage(milestone, { options }));
  }

  /** Use consecutive observed ladder ranks for the same account and queue.
   * @param {string} userId @param {any} game @param {ReturnType<typeof rankedHistoryCohort>} cohort */
  async queuePromotion(userId, game, cohort) {
    const current = Number.isInteger(game.myLeagueId) ? bandFromId(game.myLeagueId) : null;
    if (!current || !cohort) return false;
    const prior = await this.db.games.findOne({ ...cohort.match, date: { $lt: cohort.at } },
      { projection: { _id: 0, myLeagueId: 1 }, sort: { date: -1, _id: -1 } });
    const priorId = prior?.myLeagueId;
    const previous = Number.isInteger(priorId) ? bandFromId(priorId) : null;
    if (!previous || current.id <= previous.id) return false;
    const milestone = { previous: previous.label, current: current.label, race: cohort.race, mmr: recordedRating(game) ?? undefined };
    await this.enqueue(userId, "milestone", `promotion:${game.gameId}`, (options) => templates.promotionMessage(milestone, { options }));
    return true;
  }

  /** From the weekly report delivery. @param {string} userId @param {any} report */
  async onWeekly(userId, report) {
    await this.enqueue(userId, "weekly", `weekly:${report.week}`, (options) => templates.weeklyMessage(report, { options }));
  }

  /**
   * The browser submits the excerpt it previewed from the shared game. Only
   * the owner of the live share and enabled channel can queue it. Derive the
   * link and result from the share rather than accepting URLs or game facts.
   * @param {string} userId @param {string} hookId
   * @param {{token?: unknown, headline?: unknown, paragraph?: unknown}} body
   */
  async queueBattleReport(userId, hookId, body) {
    const { token, headline, paragraph } = body;
    if (typeof token !== "string" || !SHARE_TOKEN_RE.test(token) ||
      typeof headline !== "string" || !headline.trim() || headline.length > 120 ||
      typeof paragraph !== "string" || !paragraph.trim() || paragraph.length > 750) {
      throw discordError(400, "invalid_battle_report", "Open the shared report preview and try again.");
    }
    const hook = await this.ownHook(userId, hookId);
    if (!hook.enabled || hook.status !== "active" || hook.events?.result !== true || hook.options?.replayLink !== true) {
      throw discordError(409, "discord_report_not_enabled", "Turn on results and replay links for that channel in Settings.");
    }
    const game = await this.sharedReportGame(userId, token);
    if (!game) throw discordError(404, "share_not_found", "This share link doesn't exist or was turned off.");
    const queued = await this.enqueue(userId, "result", `battle-report:${token}`,
      () => templates.battleReportMessage({ token, headline, paragraph, result: game.result }), { hookId: hook._id, shareToken: token });
    return { queued };
  }

  /** @param {string} userId @param {string} token */
  async sharedReportGame(userId, token) {
    const share = await this.db.gameShares.findOne({ _id: token, userId, revokedAt: null }, { projection: { gameId: 1 } });
    if (!share) return null;
    return this.db.games.findOne({ userId, gameId: share.gameId, ...LIVE_GAME_MATCH }, { projection: { _id: 0, result: 1, gameId: 1 } });
  }

  /**
   * The newest finished session (a gap of at least the session gap since its
   * last game), or null. ``maxAgeMs`` bounds how old its end may be.
   * @param {string} userId @param {number} maxAgeMs
   */
  async lastSession(userId, maxAgeMs) {
    const now = this.now();
    const gap = await this.gapMinutes(userId);
    const since = Number.isFinite(maxAgeMs) ? { since: new Date(now - maxAgeMs - 24 * 3600_000) } : {};
    const rows = await this.db.games.find(gamesMatchStage(userId, since), { projection: {
      _id: 0, gameId: 1, date: 1, result: 1, myRace: 1, "opponent.race": 1, myMmr: 1, myToonHandle: 1, durationSec: 1,
    } }).sort({ date: -1 }).limit(100).toArray();
    if (!rows.length) return null;
    const lastAt = new Date(rows[0].date).getTime();
    if (now - lastAt < gap * 60_000 || now - lastAt > maxAgeMs) return null;
    const session = [rows[0]];
    for (let i = 1; i < rows.length; i += 1) {
      if (new Date(session[session.length - 1].date).getTime() - new Date(rows[i].date).getTime() > gap * 60_000) break;
      session.push(rows[i]);
    }
    session.reverse();
    return { firstGameId: String(session[0].gameId), startAt: new Date(session[0].date), endAt: new Date(lastAt), ...facts.record(session),
      hours: facts.hoursPlayed(session), matchups: facts.groupRecords(session, facts.matchupOf, 6), mmr: facts.mmrByAccount(session)[0] || null };
  }

  /** @param {string} userId */
  async gapMinutes(userId) {
    try { return this.sessionPolicy ? (await this.sessionPolicy.resolve(userId)).gapMinutes : 90; } catch { return 90; }
  }

  /** Every 5 minutes: session summaries for hooks that want them. */
  async sweepSessions() {
    if (!this.available) return { queued: 0 };
    const hooks = await this.db.discordHooks.find({ enabled: true, status: "active", "events.session": true },
      { projection: { _id: 0, userId: 1, enabledAt: 1 } }).limit(500).toArray();
    /** @type {Map<string, number>} */
    const since = new Map();
    for (const hook of hooks) since.set(hook.userId, Math.min(since.get(hook.userId) ?? Infinity, new Date(hook.enabledAt || 0).getTime()));
    let queued = 0;
    for (const [userId, enabledAt] of [...since.entries()].slice(0, 200)) {
      const session = await this.lastSession(userId, 12 * 3600_000);
      if (!session || session.games < 2 || session.startAt.getTime() < enabledAt) continue;
      queued += Number(await this.withLease(userId, () => this.enqueue(userId, "session", `session:${session.firstGameId}`,
        (options) => templates.sessionMessage(session, { options }), { sessionStartAt: session.startAt }))) || 0;
    }
    return { queued };
  }

  /** Drain due outbox rows, single-flight across instances. */
  async drain() {
    if (!this.available) return { sent: 0 };
    const owner = this.lock ? await this.lock.acquire() : "local";
    if (!owner) return { lockHeld: true };
    let sent = 0; let retried = 0; let dropped = 0;
    try {
      const rows = await this.db.discordOutbox.find({ status: "queued", nextAttemptAt: { $lte: new Date(this.now()) } })
        .sort({ nextAttemptAt: 1 }).limit(DRAIN_BATCH).toArray();
      /** @type {Set<string>} */
      const paused = new Set();
      for (const row of rows) {
        if (paused.has(row.hookId)) continue;
        const outcome = await this.deliverRow(row);
        if (outcome === "sent") sent += 1;
        else if (outcome === "retry") { retried += 1; paused.add(row.hookId); }
        else dropped += 1;
      }
    } finally {
      if (this.lock && owner !== "local") await this.lock.release(owner);
    }
    return { sent, retried, dropped };
  }

  /** @param {any} row @returns {Promise<"sent"|"retry"|"dropped">} */
  async deliverRow(row) {
    // Claim the row first: even if the drain lock's lease ran out, a second
    // drainer cannot take the same row and post it twice.
    const claimed = await this.db.discordOutbox.updateOne({ _id: row._id, status: "queued", nextAttemptAt: row.nextAttemptAt },
      { $set: { nextAttemptAt: new Date(this.now() + 5 * 60_000) } });
    if (claimed.modifiedCount !== 1) return "dropped";
    const outcome = await this.withLease(row.userId, async (lease) => {
      // Resolve the shared game's existence before the final consent reads so
      // a slow game lookup cannot leave old channel settings in memory.
      const game = row.shareToken ? await this.sharedReportGame(row.userId, row.shareToken) : null;
      if (row.shareToken && !game) return null;
      try { await lease.assert(); } catch { return null; }
      const [hook, user, share] = await Promise.all([
        this.db.discordHooks.findOne({ _id: row.hookId, userId: row.userId }),
        this.db.users.findOne({ userId: row.userId, _gdprMutation: { $exists: false } }, { projection: { _id: 0, replaySharing: 1 } }),
        game ? this.db.gameShares.findOne({ _id: row.shareToken, userId: row.userId, gameId: game.gameId, revokedAt: null }, { projection: { _id: 1 } }) : null,
      ]);
      if (!user || (row.shareToken && !share) || !this.canDeliver(row, hook)) return null;
      const response = await this.postWithDetails(hook, this.currentPayload(row, user));
      return this.settle(row, hook, response);
    });
    if (outcome) return outcome;
    await this.retireRow(row, "dropped");
    return "dropped";
  }

  /** A queued payload uses the privacy choices approved when it was made. @param {any} row @param {any} hook */
  canDeliver(row, hook) {
    if (hook?.enabled !== true || hook.status !== "active" || hook.events?.[row.kind] !== true) return false;
    if (!(new Date(row.expiresAt).getTime() > this.now()) || !row.options) return false;
    // Unlike a plain result, the validity of a historical peak headline
    // itself cannot be recovered from its preformatted embed.
    if (row.kind === "milestone" && row.ratingPolicy !== REPLAY_RATING_POLICY) return false;
    const options = templates.hookOptions(hook.options);
    if (row.shareToken && !options.replayLink) return false;
    return +new Date(row.hookEnabledAt) === +new Date(hook.enabledAt) &&
      options.opponentNames === row.options.opponentNames && options.mmr === row.options.mmr && options.replayLink === row.options.replayLink;
  }

  /** Remove an archive link when archive consent was withdrawn. @param {any} row @param {any} user */
  currentPayload(row, user) {
    const payload = row.kind === "result" && !row.shareToken
      ? templates.sanitizeQueuedResultRatings(row.payload, row.ratingPolicy === REPLAY_RATING_POLICY) : row.payload;
    if (!row.replaySlug || (user.replaySharing?.enabled === true && user.replaySharing.slug === row.replaySlug)) return payload;
    return { ...payload, embeds: payload.embeds.map((/** @type {any} */ embed) => ({ ...embed, url: undefined })) };
  }

  /** Keep the dedupe receipt until its existing TTL, without the message. @param {any} row @param {string} status @param {Record<string, unknown>} [details] */
  async retireRow(row, status, details = {}) {
    await this.db.discordOutbox.updateOne({ _id: row._id },
      { $set: { status, ...details }, $unset: { payload: "", options: "", shareToken: "", replaySlug: "", ratingPolicy: "" } });
  }

  /**
   * @param {any} row @param {any} hook @param {{status: number, retryAfterMs: number|null}} response
   * @returns {Promise<"sent"|"retry"|"dropped">}
   */
  async settle(row, hook, response) {
    const now = this.now();
    const { status } = response;
    if (status >= 200 && status < 300) {
      await this.retireRow(row, "sent");
      await this.db.discordHooks.updateOne({ _id: hook._id }, { $set: { failureCount: 0, lastPostAt: new Date(now), lastResult: "sent" } });
      return "sent";
    }
    if (status === 401 || status === 404) {
      await this.retireRow(row, "dropped");
      await this.countAuthFailure(hook);
      return "dropped";
    }
    const attempts = (row.attempts || 0) + 1;
    const retryable = status === 429 || status === 0 || status >= 500;
    if (!retryable || attempts >= MAX_ATTEMPTS + (status === 429 ? 3 : 0)) {
      await this.retireRow(row, "failed", { attempts, lastStatus: status });
      await this.db.discordHooks.updateOne({ _id: hook._id }, { $set: { lastResult: "failed" } });
      return "dropped";
    }
    const wait = Math.max(backoffMs(attempts), response.retryAfterMs || 0);
    await this.db.discordOutbox.updateOne({ _id: row._id }, { $set: { attempts, lastStatus: status, nextAttemptAt: new Date(now + wait) } });
    return "retry";
  }

  /** Three consecutive 401/404 answers turn the hook off and tell the owner. @param {any} hook */
  async countAuthFailure(hook) {
    const updated = await this.db.discordHooks.findOneAndUpdate({ _id: hook._id }, { $inc: { failureCount: 1 }, $set: { lastResult: "webhook_gone" } }, { returnDocument: "after" });
    if (!updated || (updated.failureCount || 0) < DISABLE_AFTER || updated.status === "disabled") return;
    const res = await this.db.discordHooks.updateOne({ _id: hook._id, status: "active" },
      { $set: { status: "disabled", enabled: false, disabledReason: "webhook_gone", updatedAt: new Date(this.now()) } });
    if (res.modifiedCount !== 1) return;
    await this.db.discordOutbox.deleteMany({ hookId: hook._id, status: "queued" });
    this.logger?.info({ hookId: hook._id }, "discord_hook_disabled");
    await this.notifications?.notify(hook.userId, {
      kind: "integration.discord_disabled", title: `Discord posts stopped for ${hook.label}`,
      body: "Discord rejected this webhook three times in a row, so it was turned off. If the webhook was deleted, paste a new one in Settings.",
      href: "/settings?tab=integrations", eventKey: `discord-disabled:${hook._id}:${new Date(this.now()).toISOString().slice(0, 10)}`,
    }).catch(() => null);
  }

  /** @param {any} hook @param {unknown} payload */
  async post(hook, payload) { return (await this.postWithDetails(hook, payload)).status; }

  /** @param {any} hook @param {unknown} payload @returns {Promise<{status: number, retryAfterMs: number|null}>} */
  async postWithDetails(hook, payload) {
    let url;
    try { url = validWebhookUrl(decryptSecret(hook.enc, /** @type {Buffer} */ (this.key), this.aad(hook.userId, hook._id))); } catch { url = null; }
    if (!url) {
      this.logger?.warn({ hookId: hook._id }, "discord_hook_unreadable");
      return { status: 404, retryAfterMs: null };
    }
    try {
      const res = await this.fetchImpl(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      let retryAfterMs = null;
      if (res.status === 429) {
        const body = /** @type {any} */ (await res.json().catch(() => null));
        const seconds = Number(body?.retry_after ?? res.headers.get("retry-after"));
        retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 60 * 60_000) : null;
      }
      return { status: res.status, retryAfterMs };
    } catch (err) {
      this.logger?.warn({ hookId: hook._id, code: /** @type {any} */ (err)?.name || "network_error" }, "discord_post_failed");
      return { status: 0, retryAfterMs: null };
    }
  }

  /** GDPR helper for callers outside the purge list. @param {string} userId */
  async deleteAllForUser(userId) {
    await this.db.discordOutbox.deleteMany({ userId });
    const res = await this.db.discordHooks.deleteMany({ userId });
    return res.deletedCount || 0;
  }

  /** Fence a background delivery operation against erasure. @template T @param {string} userId @param {(lease: Awaited<ReturnType<typeof claimUserDataLease>>) => Promise<T>} work */
  async withLease(userId, work) {
    let lease;
    try { lease = await claimUserDataLease(this.db.users, userId); } catch { return null; }
    try { return await work(lease); } finally { await lease.release(); }
  }
}

function exampleWeek() {
  return { week: "2026-W01", totals: { games: 23, wins: 13, losses: 10, hours: 6.2, sessions: 4 }, mmr: [{ start: 4012, end: 4098, delta: 86, games: 23 }],
    maps: { best: { name: "Example map", wins: 5, losses: 1 } }, builds: { best: { name: "Example build", wins: 6, losses: 2 } }, matchups: [{ matchup: "PvZ", wins: 7, losses: 4 }] };
}

/** @param {number} now */
function exampleSession(now) {
  return { games: 6, wins: 4, losses: 2, hours: 1.6, matchups: [{ name: "PvZ", wins: 3, losses: 1 }, { name: "PvT", wins: 1, losses: 1 }],
    mmr: { start: 4012, end: 4050, delta: 38, games: 6 }, endAt: new Date(now) };
}

module.exports = { DiscordWebhooksService, validWebhookUrl, backoffMs, MAX_HOOKS, DISABLE_AFTER, MAX_ATTEMPTS };
