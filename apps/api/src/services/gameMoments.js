"use strict";
const { claimUserDataLease } = require("../middleware/userDataWriteFence");
const { STATS_GAME_MATCH } = require("../util/gameVisibility");
const { sanitizeChatAlerts } = require("./multichatAppearance");
const { deriveGameMoments, ladderContext, eligibleGame, league } = require("./gameMomentRules");
const MAX_HISTORY = 10000, MAX_INFLIGHT = 32, FRESH_MS = 15 * 60_000;
const UNAVAILABLE = ["overlay_rotation_pending", "overlay_token_resolve_busy", "invalid_overlay_token"];
const PROJECTION = { _id: 0, userId: 1, gameId: 1, date: 1, result: 1, myToonHandle: 1, myRace: 1, myLadderRace: 1,
  myMmr: 1, myMmrSource: 1, durationSec: 1, playerCount: 1, isLadderGame: 1, _gameMoments: 1, _customBuildRevision: 1,
  "opponent.pulseId": 1, "opponent.pulseCharacterId": 1, "opponent.toonHandle": 1, "opponent.mmr": 1, "opponent.mmrSource": 1 };
/** @param {Record<string,any>} game @param {number} now */
function fresh(game, now) {
  const at = new Date(game.date).getTime();
  return typeof game.gameId === "string" && game.gameId.length > 0 && game.gameId.length <= 200
    && Number.isFinite(at) && at <= now + 30_000 && now - at <= FRESH_MS;
}
/** @param {Record<string,any>} game @param {Record<string,any>} payload @param {{battlenetId:number,start:string}|null} season */
function rankReceipt(game, payload, season) {
  const context = ladderContext(game), rank = payload.rank;
  return context && season && new Date(game.date).getTime() >= Date.parse(season.start) && rank?.source === "pulse" && league(rank.league)
    ? { source: "pulse", league: rank.league, context: context.key, season: season.battlenetId } : null;
}

/** Once per new fresh replay; no provider, detail hydration or per-widget reads. */
class GameMomentsService {
  /** @param {{games:import('mongodb').Collection,users:import('mongodb').Collection}} db
   * @param {{users:import('./users').UsersService,tokens:import('./overlayTokens').OverlayTokensService,
   * channels:import('./opponentChannels').OpponentChannelsCache,seasons:import('./seasons').SeasonsService,
   * engagement:import('./multichatEngagement').MultichatEngagementService,bot:import('./twitchChatBot').TwitchChatBotService,
   * io?:import('socket.io').Server,now?:()=>number,logger?:import('pino').Logger}} deps */
  constructor(db, deps) { this.db = db; this.deps = deps; this.now = deps.now || Date.now; /** @type {Map<string,Promise<any[]>>} */ this.inflight = new Map(); }
  /** The created flag comes only from the ingest insert result, not its body.
   * @param {string} userId @param {Record<string,any>} game @param {Record<string,any>} payload @param {string[]} tokens @param {{created:boolean}} options */
  async process(userId, game, payload, tokens, options) {
    if (!options.created || !fresh(game, this.now()) || tokens.length === 0) return [];
    const key = JSON.stringify([userId, game.gameId]), existing = this.inflight.get(key); if (existing) return existing;
    if (this.inflight.size >= MAX_INFLIGHT) throw Object.assign(new Error("game_moments_busy"), { code: "game_moments_busy" });
    const work = this._process(userId, game, payload, [...new Set(tokens)]).finally(() => { if (this.inflight.get(key) === work) this.inflight.delete(key); });
    this.inflight.set(key, work); return work;
  }
  /** @param {string} userId @param {Record<string,any>} input @param {Record<string,any>} payload @param {string[]} tokens */
  async _process(userId, input, payload, tokens) {
    const prefs = await this.deps.users.getPreferences(userId, "multichat");
    const config = /** @type {any} */ (sanitizeChatAlerts(prefs?.alerts)).gameMoments;
    if (!config || !Object.values(config.moments).some((/** @type {any} */ row) => row.enabled)) return [];
    const lease = await claimUserDataLease(this.db.users, userId);
    try {
      // The same already-used owner/game date index bounds this slim scan.
      const rows = await this.db.games.find({ userId, ...STATS_GAME_MATCH, isResumedFromReplay: { $ne: true },
        playerCount: 2, isLadderGame: { $ne: false }, date: { $lte: new Date(input.date) } }, { projection: PROJECTION, maxTimeMS: 1500 })
        .sort({ date: -1, _id: -1 }).limit(MAX_HISTORY + 1).toArray();
      const game = rows.find(row => row.gameId === input.gameId);
      if (!game || game._gameMoments || !eligibleGame(game) || !fresh(game, this.now())) return [];
      const context = ladderContext(game), cached = context ? this.deps.seasons.cachedCurrent(context.region) : null;
      const season = cached && typeof cached.start === "string" ? { battlenetId: cached.battlenetId, start: cached.start } : null;
      const channels = config.moments.streamerOpponentWin.enabled ? await this.deps.channels.forGame(userId, game) : {};
      const moments = deriveGameMoments({ game, history: rows.slice(0, MAX_HISTORY), historyTruncated: rows.length > MAX_HISTORY,
        season, pulseRank: payload.rank, approvedChannel: Boolean(channels.twitch || channels.youtube), mmrStep: config.mmrStep })
        .filter(moment => config.moments[moment.kind].enabled);
      const rank = rankReceipt(game, payload, season), receipt = { version: 1, claimedAt: new Date(this.now()), kinds: moments.map(moment => moment.kind), ...(rank ? { rank } : {}) };
      await lease.assert();
      return await this._claimAndDeliver(userId, game, payload, tokens, moments, receipt, config.botPost);
    } finally { await lease.release(); }
  }
  /** @param {string} userId @param {Record<string,any>} game @param {Record<string,any>} payload @param {string[]} tokens @param {Array<import('./gameMomentRules').Moment>} moments @param {Record<string,any>} receipt @param {boolean} botPost */
  async _claimAndDeliver(userId, game, payload, tokens, moments, receipt, botPost) {
    for (const admitted of tokens) {
      try { return await this.deps.tokens.withWrite(admitted, async () => {
        const revision = typeof game._customBuildRevision === "string" ? game._customBuildRevision : { $exists: false };
        const claimed = await this.db.games.updateOne({ userId, gameId: game.gameId, ...STATS_GAME_MATCH, _customBuildRevision: revision, _gameMoments: { $exists: false } }, { $set: { _gameMoments: receipt } });
        if (!claimed.modifiedCount) return [];
        for (const token of tokens) {
          const send = async () => this._deliver(userId, token, game, payload, moments, botPost);
          try { if (token === admitted) await send(); else await this.deps.tokens.withWrite(token, send); }
          catch (error) { if (!UNAVAILABLE.includes(/** @type {any} */ (error)?.code)) throw error; }
        }
        return moments;
      }); } catch (error) { if (!UNAVAILABLE.includes(/** @type {any} */ (error)?.code)) throw error; }
    }
    return [];
  }
  /** Runs inside exact token admission; use the admitted clip writer to avoid
   * reopening admission after rotation has started draining the held write.
   * @param {string} userId @param {string} token @param {Record<string,any>} game @param {Record<string,any>} payload @param {Array<import('./gameMomentRules').Moment>} moments @param {boolean} botPost */
  async _deliver(userId, token, game, payload, moments, botPost) {
    for (const moment of moments) {
      await this.deps.engagement._recordMomentAdmitted(token, { kind: "game-event", reason: `${moment.headline} — ${moment.detail}`, gameKey: payload.gameKey || game.gameId });
      this.deps.io?.to(`overlay:${token}`).emit("overlay:moment", { ...moment, gameId: game.gameId, atMs: this.now() });
    }
    if (botPost && moments.length) this.deps.bot.queueGameMoments(userId, token, moments.map(moment => moment.headline).join(" · ").slice(0, 400));
  }
}
module.exports = { GameMomentsService, MAX_HISTORY, FRESH_MS, rankReceipt };
