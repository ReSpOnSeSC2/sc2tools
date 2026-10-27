"use strict";

const { shoutoutText } = require("./opponentChannels");
const { captureSessionPublication } = require("./sessionPublication");
const ACTIONS = ["predictionCancel", "predictionResolve", "sessionReset", "gamePause", "shoutout"];
/** @param {number} status @param {string} code */
function deskError(status, code) { return Object.assign(new Error(code), { status, code }); }

/** Token-authenticated controls; the enclosing route holds its owner's data lease. */
class GameDeskService {
  /** @param {{users:import('mongodb').Collection,studio:import('./multichatStudio').MultichatStudioService,engagement:import('./multichatEngagement').MultichatEngagementService,games:import('./games').GamesService,broker:import('./liveGameBroker').LiveGameBroker,channels:import('./opponentChannels').OpponentChannelsCache,tokens:import('./overlayTokens').OverlayTokensService,bot:import('./twitchChatBot').TwitchChatBotService,io?:import('socket.io').Server,onSessionReset?:(owner:string)=>void,now?:()=>number}} deps */
  constructor(deps) { this.deps = deps; this.now = deps.now || Date.now; }

  /** @param {string} userId @param {string} token @param {Record<string,any>} body */
  async act(userId, token, body) {
    const tokens = this.deps.tokens;
    return "withWrite" in tokens && typeof tokens.withWrite === "function"
      ? tokens.withWrite(token, () => this._actAdmitted(userId, token, body))
      : this._actAdmitted(userId, token, body);
  }

  /** @param {string} userId @param {string} token @param {Record<string,any>} body */
  async _actAdmitted(userId, token, body) {
    if (!ACTIONS.includes(body.action)) throw deskError(400, "invalid_game_desk_action");
    const allowed = body.action === "predictionResolve" ? ["action", "gameKey", "result"]
      : ["predictionCancel", "shoutout"].includes(body.action) ? ["action", "gameKey"]
      : body.action === "gamePause" ? ["action", "paused"] : ["action"];
    if (Object.keys(body).some(key => !allowed.includes(key))) throw deskError(400, "invalid_game_desk_action");
    const { studio, engagement, broker } = this.deps;
    if (body.action === "gamePause") {
      if (typeof body.paused !== "boolean") throw deskError(400, "invalid_game_pause");
      return studio.update(token, { gameWidgetsPaused: body.paused });
    }
    if (body.action === "sessionReset") return this.resetSession(userId, token);
    const gameKey = body.gameKey;
    if (typeof gameKey !== "string" || !gameKey.trim() || gameKey.length > 120) throw deskError(400, "invalid_prediction_game");
    if (body.action === "predictionCancel") {
      if (!await engagement._cancelAdmitted(token, gameKey)) throw deskError(409, "prediction_changed");
    } else if (body.action === "predictionResolve") {
      const live = /** @type {Record<string,any>|null} */ (broker.latest(userId));
      const verified = /** @type {Record<string,any>|null} */ (broker.latestOverlayLive(userId));
      const endedKey = live?.lastEndedGame?.gameKey ?? (live?.phase === "match_ended" ? live.gameKey : null);
      const endedAt = live?.lastEndedGame?.endedAt ?? this.now();
      if (!live || live.isReplay || !["match_ended", "menu", "idle"].includes(live.phase) || endedKey !== gameKey
        || typeof endedAt !== "number" || !Number.isFinite(endedAt) || this.now() - endedAt > 30 * 60_000
        || (verified?.gameKey === gameKey && ["win", "loss"].includes(verified.result))) throw deskError(409, "prediction_manual_unavailable");
      if (!["win", "loss"].includes(body.result)) throw deskError(400, "invalid_prediction_result");
      if (!await engagement._manualSettleAdmitted(token, gameKey, body.result)) throw deskError(409, "prediction_changed");
    } else {
      const text = await this.shoutoutLine(userId, gameKey);
      if (!text) throw deskError(409, "opponent_channel_unavailable");
      const queued = this.deps.bot.queueShoutout(userId, token, text);
      return { ...await studio.get(token), deskAction: { shoutoutText: text, queued } };
    }
    return studio.get(token);
  }

  /** @param {string} userId @param {string} [expectedKey] */
  async shoutoutLine(userId, expectedKey) {
    const live = /** @type {Record<string,any>|null} */ (this.deps.broker.latest(userId));
    if (!live || (expectedKey && live.gameKey !== expectedKey)) return null;
    const channels = await this.deps.channels.forMatch(userId, live);
    // A directory response must not resurrect an opponent after game end/change.
    const current = /** @type {Record<string,any>|null} */ (this.deps.broker.latest(userId));
    return current && current.gameKey === live.gameKey
      && JSON.stringify([current.opponent?.toonHandle, current.opponent?.profile?.pulse_character_id, current.opponent?.profile?.confidence])
        === JSON.stringify([live.opponent?.toonHandle, live.opponent?.profile?.pulse_character_id, live.opponent?.profile?.confidence])
      && ["match_loading", "match_started", "match_in_progress"].includes(String(current.phase))
      ? shoutoutText(channels) : null;
  }

  /** @param {string} userId @param {string} token */
  async resetSession(userId, token) {
    const { games, users, studio, tokens, io } = this.deps;
    const at = this.now();
    games.invalidateSessionForReset(userId);
    this.deps.onSessionReset?.(userId);
    let written;
    try { written = await users.updateOne({ userId }, { $max: { sessionAnchorAt: new Date(at).toISOString() } }); }
    finally { this.deps.onSessionReset?.(userId); }
    if (!written.matchedCount) throw deskError(404, "user_not_found");
    const committed = await users.findOne({ userId }, { projection: { sessionAnchorAt: 1 } });
    const anchor = typeof committed?.sessionAnchorAt === "string" ? Date.parse(committed.sessionAnchorAt) : NaN;
    if (!Number.isFinite(anchor)) throw new Error("session anchor unavailable");
    games.invalidateSessionForReset(userId);
    const state = await studio.advanceStreamStart(token, anchor);
    // Owner invalidation only: no private session DTO or replay insertion.
    io?.to(`user:${userId}`).emit("games:changed", { count: 0, inserted: 0, bulk: false, reason: "session-reset" });
    try {
      const assertSessionCurrent = captureSessionPublication(games.sessionPublicationGuard?.bind(games), userId);
      const session = await games.todaySession(userId, undefined, { reuseRecent: true });
      if (io) for (const active of await tokens.list(userId)) {
        if (!active.revokedAt && !("rotationPending" in active && active.rotationPending)) {
          assertSessionCurrent(session);
          io.to(`overlay:${active.token}`).emit("overlay:session", session);
        }
      }
    } catch (error) {
      // The anchor and stream mark are committed. A retired resolution or
      // publication only discards this optional fanout; other failures retain
      // their original error result.
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (typeof code !== "string" || !["session_policy_changed", "session_policy_publication_unavailable", "SESSION_RESOLUTION_STALE"].includes(code)) throw error;
    }
    return state;
  }
}

module.exports = { GameDeskService };
