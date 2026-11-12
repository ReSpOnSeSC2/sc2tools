"use strict";
const { claimUserDataLease } = require("../middleware/userDataWriteFence");
const { STATS_GAME_MATCH } = require("../util/gameVisibility");
const { sanitizeGameMomentAlerts } = require("./multichatAppearance");
const { NOTIFICATIONS_PREF_TYPE, sanitizeNotificationPrefs } = require("./notificationPrefs");
const { deriveGameMoments, ladderContext, eligibleGame, league } = require("./gameMomentRules");
/** @typedef {import('./gameMomentRules').Moment} Moment */
/** @typedef {ReturnType<typeof sanitizeGameMomentAlerts>} OverlayConfig */
/** @typedef {import('mongodb').Document} Document */
/** @typedef {{version:1,claimedAt:Date,kinds:string[],rank?:Document,pendingBell?:Moment[]}} Receipt */
/** @typedef {{game:Document,moments:Moment[],receipt:Receipt}} Computation */
/** @type {Readonly<Record<string, string>>} */
const BELL_KINDS = Object.freeze({
  crossedMmrMark: "moment.crossed_mmr_mark",
  newSeasonPeak: "moment.new_season_peak",
  winStreak: "moment.win_streak",
  lossStreakBroken: "moment.loss_streak_broken",
  revengeWin: "moment.revenge_win",
  giantKiller: "moment.giant_killer",
  marathonWin: "moment.marathon_win",
});
const MAX_HISTORY = 10000, MAX_INFLIGHT = 32, FRESH_MS = 15 * 60_000;
const UNAVAILABLE = ["overlay_rotation_pending", "overlay_token_resolve_busy", "invalid_overlay_token"];
const PROJECTION = { _id: 0, userId: 1, gameId: 1, date: 1, result: 1, myToonHandle: 1, myRace: 1, myLadderRace: 1,
  myMmr: 1, myMmrSource: 1, durationSec: 1, playerCount: 1, isLadderGame: 1, _gameMoments: 1, _customBuildRevision: 1,
  "opponent.pulseId": 1, "opponent.pulseCharacterId": 1, "opponent.toonHandle": 1, "opponent.mmr": 1, "opponent.mmrSource": 1 };
/** @param {Document} game @param {number} now */
function fresh(game, now) {
  const at = new Date(game.date).getTime();
  return typeof game.gameId === "string" && game.gameId.length > 0 && game.gameId.length <= 200
    && Number.isFinite(at) && at <= now + 30_000 && now - at <= FRESH_MS;
}
/** @param {Document} game @param {Document|null} payload @param {{battlenetId:number,start:string}|null} season */
function rankReceipt(game, payload, season) {
  const context = ladderContext(game), rank = payload?.rank;
  return context && season && new Date(game.date).getTime() >= Date.parse(season.start) && rank?.source === "pulse" && league(rank.league)
    ? { source: "pulse", league: rank.league, context: context.key, season: season.battlenetId } : null;
}

/** Once per new fresh replay; no provider, detail hydration or per-widget reads. */
class GameMomentsService {
  /** @param {{games:import('mongodb').Collection,users:import('mongodb').Collection}} db
   * @param {{users:import('./users').UsersService,tokens:import('./overlayTokens').OverlayTokensService,
   * channels:import('./opponentChannels').OpponentChannelsCache,seasons:import('./seasons').SeasonsService,
   * engagement:import('./multichatEngagement').MultichatEngagementService,bot:import('./twitchChatBot').TwitchChatBotService,
   * notifications?:import('./notifications').NotificationsService,
   * io?:import('socket.io').Server,now?:()=>number,logger?:import('pino').Logger}} deps */
  constructor(db, deps) { this.db = db; this.deps = deps; this.now = deps.now || Date.now; /** @type {Map<string,Promise<Moment[]>>} */ this.inflight = new Map(); }
  /** The created flag comes only from the ingest insert result, not its body.
   * @param {string} userId @param {Document} game @param {Document|null} payload @param {string[]} tokens @param {{created:boolean}} options */
  async process(userId, game, payload, tokens, options) {
    if (!fresh(game, this.now()) || (!options.created && !this.deps.notifications)) return [];
    const key = JSON.stringify([userId, game.gameId, options.created]), existing = this.inflight.get(key); if (existing) return existing;
    if (this.inflight.size >= MAX_INFLIGHT) throw Object.assign(new Error("game_moments_busy"), { code: "game_moments_busy" });
    const work = (options.created ? this._process(userId, game, payload, [...new Set(tokens)]) : this._resumeBell(userId, game.gameId))
      .finally(() => { if (this.inflight.get(key) === work) this.inflight.delete(key); });
    this.inflight.set(key, work); return work;
  }
  /** @param {string} userId @param {Document} input @param {Document|null} payload @param {string[]} tokens */
  async _process(userId, input, payload, tokens) {
    const [overlay, personal] = await Promise.allSettled([
      payload && tokens.length ? this.deps.users.getPreferences(userId, "multichat") : null,
      this.deps.notifications ? this.deps.users.getPreferences(userId, NOTIFICATIONS_PREF_TYPE) : null,
    ]);
    if (overlay.status === "rejected") this.deps.logger?.warn({ err: overlay.reason }, "moment_overlay_preferences_failed");
    if (personal.status === "rejected") this.deps.logger?.warn({ err: personal.reason }, "moment_bell_preferences_failed");
    const overlayPrefs = overlay.status === "fulfilled" ? overlay.value : null;
    // The durable notification writer checks current opt-in and mute even if this preliminary read failed.
    const bellEnabled = personal.status === "rejected" || sanitizeNotificationPrefs(personal.value).milestones;
    if (!overlayPrefs && !bellEnabled) return [];
    const alerts = /** @type {{gameMoments?: unknown}|undefined} */ (overlayPrefs?.alerts);
    const config = sanitizeGameMomentAlerts(alerts?.gameMoments);
    if (!bellEnabled && !Object.values(config.moments).some(row => row.enabled)) return [];
    const lease = await claimUserDataLease(this.db.users, userId);
    try {
      const computed = await this._compute(userId, input, payload, config);
      if (!computed) return [];
      await lease.assert();
      return await this._claimAndDeliver(userId, computed, payload, tokens, config, bellEnabled);
    } finally { await lease.release(); }
  }
  /** @param {string} userId @param {Document} input @param {Document|null} payload @param {OverlayConfig} config @returns {Promise<Computation|null>} */
  async _compute(userId, input, payload, config) {
    // The same already-used owner/game date index bounds this slim scan.
    const rows = await this.db.games.find({ userId, ...STATS_GAME_MATCH, isResumedFromReplay: { $ne: true },
      playerCount: 2, isLadderGame: { $ne: false }, date: { $lte: new Date(input.date) } }, { projection: PROJECTION, maxTimeMS: 1500 })
      .sort({ date: -1, _id: -1 }).limit(MAX_HISTORY + 1).toArray();
    const game = rows.find(row => row.gameId === input.gameId);
    if (!game || game._gameMoments || !eligibleGame(game) || !fresh(game, this.now())) return null;
    const context = ladderContext(game), cached = context ? this.deps.seasons.cachedCurrent(context.region) : null;
    const season = cached && typeof cached.start === "string" ? { battlenetId: cached.battlenetId, start: cached.start } : null;
    const channels = config.moments.streamerOpponentWin.enabled ? await this.deps.channels.forGame(userId, game) : {};
    const moments = deriveGameMoments({ game, history: rows.slice(0, MAX_HISTORY), historyTruncated: rows.length > MAX_HISTORY,
      season, pulseRank: payload?.rank, approvedChannel: Boolean(channels.twitch || channels.youtube), mmrStep: config.mmrStep });
    const rank = rankReceipt(game, payload, season);
    /** @type {Receipt} */
    const receipt = { version: 1, claimedAt: new Date(this.now()), kinds: moments.map(moment => moment.kind), ...(rank ? { rank } : {}) };
    return { game, moments, receipt };
  }
  /** @param {string} userId @param {Computation} computed @param {Document|null} payload @param {string[]} tokens @param {OverlayConfig} config @param {boolean} bellEnabled */
  async _claimAndDeliver(userId, { game, moments, receipt }, payload, tokens, config, bellEnabled) {
    const overlayMoments = moments.filter(moment => config.moments[moment.kind].enabled);
    if (!bellEnabled) {
      if (!payload) return [];
      const claimed = await this._withAdmittedToken(tokens, async token => {
        if (!await this._claim(userId, game, receipt)) return false;
        await this._deliverOverlay(userId, game, payload, tokens, overlayMoments, config.botPost, token);
        return true;
      });
      return claimed ? overlayMoments : [];
    }
    const pendingBell = moments.filter(moment => Object.hasOwn(BELL_KINDS, moment.kind));
    if (pendingBell.length) receipt.pendingBell = pendingBell;
    if (!await this._claim(userId, game, receipt)) return [];
    const deliveries = await Promise.allSettled([
      this._deliverBell(userId, game.gameId, receipt),
      payload && overlayMoments.length ? this._deliverOverlay(userId, game, payload, tokens, overlayMoments, config.botPost) : null,
    ]);
    for (const delivery of deliveries) if (delivery.status === "rejected") throw delivery.reason;
    return moments.filter(moment => Object.hasOwn(BELL_KINDS, moment.kind) || config.moments[moment.kind].enabled);
  }
  /** @param {string} userId @param {Document} game @param {Document} receipt */
  async _claim(userId, game, receipt) {
    const revision = typeof game._customBuildRevision === "string" ? game._customBuildRevision : { $exists: false };
    const result = await this.db.games.updateOne(
      { userId, gameId: game.gameId, ...STATS_GAME_MATCH, _customBuildRevision: revision, _gameMoments: { $exists: false } },
      { $set: { _gameMoments: receipt } },
    );
    return result.modifiedCount === 1;
  }
  /** @param {string[]} tokens @param {(token:string)=>Promise<boolean>} work */
  async _withAdmittedToken(tokens, work) {
    for (const token of tokens) {
      try { return await this.deps.tokens.withWrite(token, () => work(token)); }
      catch (error) { if (!UNAVAILABLE.includes(/** @type {{code?:string}} */ (error)?.code ?? "")) throw error; }
    }
    return false;
  }
  /** @param {string} userId @param {Document} game @param {Document} payload @param {string[]} tokens @param {Moment[]} moments @param {boolean} botPost @param {string} [admitted] */
  async _deliverOverlay(userId, game, payload, tokens, moments, botPost, admitted) {
    for (const token of tokens) {
      const send = async () => this._deliver(userId, token, game, payload, moments, botPost);
      try {
        if (token === admitted) await send();
        else await this.deps.tokens.withWrite(token, send);
      } catch (error) {
        if (!UNAVAILABLE.includes(/** @type {{code?:string}} */ (error)?.code ?? "")) throw error;
      }
    }
  }
  /** Reuploads may only finish a previously claimed bell delivery. @param {string} userId @param {string} gameId @returns {Promise<Moment[]>} */
  async _resumeBell(userId, gameId) {
    const filter = { userId, gameId, ...STATS_GAME_MATCH,
      isResumedFromReplay: { $ne: true }, playerCount: 2, isLadderGame: { $ne: false }, "_gameMoments.pendingBell": { $exists: true },
    };
    if (!await this.db.games.findOne(filter, { projection: { _id: 1 }, maxTimeMS: 1500 })) return [];
    const lease = await claimUserDataLease(this.db.users, userId);
    try {
      // Visibility may have changed before the write lease was acquired.
      const game = await this.db.games.findOne(filter, { projection: { date: 1, gameId: 1, _gameMoments: 1 }, maxTimeMS: 1500 });
      if (!game || !fresh(game, this.now())) return [];
      await lease.assert();
      await this._deliverBell(userId, gameId, game._gameMoments);
      return [];
    } finally { await lease.release(); }
  }
  /** @param {string} userId @param {string} gameId @param {Receipt} receipt */
  async _deliverBell(userId, gameId, receipt) {
    const notifications = this.deps.notifications;
    if (!notifications || !receipt.pendingBell?.length) return;
    const href = `/app/game/${encodeURIComponent(gameId)}`;
    let pending = false;
    for (const moment of receipt.pendingBell) {
      const input = { kind: BELL_KINDS[moment.kind], title: moment.headline, body: moment.detail,
        href: href.length <= 300 ? href : "/app/replays", eventKey: `${gameId}:${moment.kind}` };
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await notifications.notify(userId, input);
          break;
        } catch (err) {
          if (attempt === 1) {
            pending = true;
            this.deps.logger?.warn({ err }, "moment_bell_delivery_pending");
          }
        }
      }
    }
    if (pending) return;
    // A retry after an uncertain write uses the same unique event key; the overlay receipt stays claimed.
    await this.db.games.updateOne({ userId, gameId, "_gameMoments.claimedAt": receipt.claimedAt },
      { $unset: { "_gameMoments.pendingBell": "" } });
  }
  /** Runs inside exact token admission; use the admitted clip writer to avoid
   * reopening admission after rotation has started draining the held write.
   * @param {string} userId @param {string} token @param {Document} game @param {Document} payload @param {Moment[]} moments @param {boolean} botPost */
  async _deliver(userId, token, game, payload, moments, botPost) {
    for (const moment of moments) {
      await this.deps.engagement._recordMomentAdmitted(token, { kind: "game-event", reason: `${moment.headline} — ${moment.detail}`, gameKey: payload.gameKey || game.gameId });
      this.deps.io?.to(`overlay:${token}`).emit("overlay:moment", { ...moment, gameId: game.gameId, atMs: this.now() });
    }
    if (botPost && moments.length) this.deps.bot.queueGameMoments(userId, token, moments.map(moment => moment.headline).join(" · ").slice(0, 400));
  }
}
module.exports = { GameMomentsService, MAX_HISTORY, FRESH_MS, rankReceipt };
