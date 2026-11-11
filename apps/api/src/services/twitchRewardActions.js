"use strict";

const { eligibility } = require("./twitchAutomationPolicy");
const { matchupFromRaces, normalizeRace } = require("./buildIntentCommon");
const { readBuildIntentPrefs } = require("./buildIntentPrefs");
const { sanitizeChatTts } = require("./multichatAppearance");
const { overlayDescriptor, readOverlayPresence } = require("./overlayPresence");
const { rewardError, safeText, targetId } = require("./twitchRewardPolicy");

/** @param {string} code */
const unavailable = code => rewardError(`reward_${code}`, 409);
/** @param {unknown} value */
const lowerLogin = value => String(value || "").trim().toLowerCase().replace(/^@+/, "");

class TwitchRewardActions {
  /** @param {{tokens:import('./overlayTokens').OverlayTokensService,studio:import('./multichatStudio').MultichatStudioService,
   * customBuilds:import('./customBuilds').CustomBuildsService,buildIntents:import('./buildIntents').BuildIntentsService,
   * users:import('./users').UsersService,broker:import('./liveGameBroker').LiveGameBroker,io?:import('socket.io').Server,now?:()=>number}} deps */
  constructor(deps) { this.deps = deps; this.now = deps.now || Date.now; }

  /** @param {string} userId */
  async activeTokens(userId) {
    return (await this.deps.tokens.list(userId)).filter(row => row.token && !row.revokedAt && !(/** @type {any} */ (row)).rotationPending);
  }

  /** @param {string} userId */
  async targets(userId) { return (await this.activeTokens(userId)).map(row => ({ id: targetId(row.token), label: row.label })); }

  /** @param {string} userId @param {string} target */
  async token(userId, target) {
    return (await this.activeTokens(userId)).find(row => targetId(row.token) === target)?.token || null;
  }

  /** @param {string} userId */
  async builds(userId) {
    const builds = await this.deps.customBuilds.list(userId);
    return builds.slice(0, 50).map(build => ({ id: build.slug, name: build.name }));
  }

  /** @param {string} userId @param {string[]} ids */
  async buildVote(userId, ids) {
    if (ids.length < 2 || ids.length > 3) return null;
    const rows = await Promise.all(ids.map(slug => this.deps.customBuilds.get(userId, slug)));
    const options = rows.map(row => row ? safeText(row.name, 120) : "");
    if (options.some(name => !name) || new Set(options).size !== options.length) return null;
    return { question: "Chat picks the build!", options, status: "open", durationSec: 60, meta: { kind: "build", winRates: {} } };
  }

  /** @param {string} userId @param {string} token */
  async canQueueNextGame(userId, token) {
    const [owner, presence, prefs] = await Promise.all([this.deps.tokens.resolve(token), readOverlayPresence(this.deps.io, token, userId).catch(() => null),
      readBuildIntentPrefs(this.deps.buildIntents.live.users, userId)]);
    if (owner?.userId !== userId || !presence?.agent.online || !owner.enabledWidgets.includes("randomizer")) return null;
    const hasPool = Object.values(/** @type {Record<string,any>} */ (prefs.randomizer.matchups || {})).some((/** @type {any} */ value) => value?.enabled === true && value.builds?.length >= 2);
    return hasPool ? { gameKey: this.deps.broker.currentGameKey(userId) || null } : null;
  }

  /** @param {string} userId @param {Record<string,any>} envelope */
  isDeviceMatch(userId, envelope) {
    const latest = /** @type {any} */ (this.deps.broker.latest(userId));
    if (envelope.phase !== "match_started" && (envelope.phase !== "match_in_progress" || !(envelope.displayTime >= 0 && envelope.displayTime <= 20))) return false;
    return Boolean(latest && latest.gameKey === envelope.gameKey && latest.receivedAt >= envelope.receivedAt
      && ["match_started", "match_in_progress"].includes(latest.phase)
      && eligibility({ ...envelope, phase: "match_started" }, { source: "device", receivedAt: envelope.receivedAt }, this.now()).marker);
  }

  /** @param {string} userId @param {string} token @param {any} row @param {{buildIds:string[]}} mapping @param {Record<string,any>|null} envelope */
  run(userId, token, row, mapping, envelope) {
    return this.deps.tokens.withWrite(token, async () => {
      const owner = await this.deps.tokens.resolve(token);
      if (owner?.userId !== userId) throw unavailable("overlay_unavailable");
      if (row.action === "randomizer") return this.roll(userId, owner, row, envelope);
      const presence = await readOverlayPresence(this.deps.io, token, userId).catch(() => null);
      const widget = widgetFor(row.action);
      const cover = row.action === "broll" && Boolean(presence?.scenes?.manual?.count);
      if (!cover && (!widget || !owner.enabledWidgets.includes(widget) || !presence?.widgets[widget]?.count)) {
        throw unavailable("overlay_source_unavailable");
      }
      if (row.action === "recap") return this.deps.studio.applyReward(token, { recap: true }, "recap");
      if (row.action === "broll") return this.deps.studio.applyReward(token, {}, "broll");
      if (row.action === "buildVote") {
        const poll = await this.buildVote(userId, mapping.buildIds);
        if (!poll) throw unavailable("builds_unavailable");
        return this.deps.studio.applyReward(token, { poll }, "buildVote");
      }
      if (!["pin", "tts"].includes(row.action)) throw unavailable("action_invalid");
      await this.requireViewerInput(userId, token, row);
      if (row.action === "pin") return this.deps.studio.applyReward(token, { highlight: { platform: "twitch", user: row.name, text: row.input } }, "pin");
      return this.speak(userId, token, row);
    });
  }

  /** @param {string} userId @param {{enabledWidgets:string[]}} owner @param {any} row @param {Record<string,any>|null} envelope */
  async roll(userId, owner, row, envelope) {
    if (!owner.enabledWidgets.includes("randomizer") || !envelope || !this.isDeviceMatch(userId, envelope)) throw unavailable("next_game_unavailable");
    const matchup = matchupFromRaces(normalizeRace(envelope.user?.race), normalizeRace(envelope.opponent?.race));
    if (!matchup) throw unavailable("next_game_unavailable");
    try { await this.deps.buildIntents.live.rewardReroll(userId, envelope.gameKey, matchup, row.redemptionId); }
    catch (error) {
      const code = /** @type {any} */ (error)?.code;
      if (["stale_game", "matchup_changed", "unknown_build", "randomizer_disabled", "build_declared", "not_eligible", "randomizer_changed", "randomizer_already_rerolled"].includes(code)) throw unavailable("next_game_unavailable");
      if (code === "hold_active") throw unavailable("hold_active");
      throw error;
    }
  }

  /** @param {string} userId @param {string} token @param {any} row */
  async requireViewerInput(userId, token, row) {
    if (!row.name || !row.input) throw unavailable("viewer_input_required");
    const [config, state] = await Promise.all([this.deps.users.getPreferences(userId, "multichat"), this.deps.studio.get(token)]);
    const raw = /** @type {any} */ (config);
    if (row.action === "tts") {
      const tts = sanitizeChatTts(raw?.tts);
      if (!tts.enabled || (tts.platforms.length && !tts.platforms.includes("twitch"))) throw unavailable("audio_unavailable");
    }
    const blocked = new Set([...(state.blockedUsers || []), ...String(raw?.appearance?.blockedUsers || "").split(",")].map(lowerLogin).filter(Boolean));
    if (blocked.has(lowerLogin(row.name)) || blocked.has(lowerLogin(row.login))) throw unavailable("viewer_blocked");
  }

  /** @param {string} userId @param {string} token @param {any} row */
  async speak(userId, token, row) {
    const io = this.deps.io;
    if (!io) throw unavailable("audio_unavailable");
    const sockets = await io.in(`overlay:${token}`).fetchSockets();
    const candidates = sockets.filter(socket => socket.data?.kind === "overlay" && socket.data.overlayToken === token
      && socket.data.overlayUserId === userId && socket.data.overlayControlOnly !== true
      && overlayDescriptor(socket.data.overlayPresence).widget === "multichat").slice(0, 4);
    for (const socket of candidates) {
      const ready = await socket.timeout(800).emitWithAck("overlay:rewardSpeechReady").catch(() => false);
      if (ready !== true) continue;
      const outcome = await socket.timeout(1500).emitWithAck("overlay:rewardSpeech", {
        id: row.redemptionId, name: row.name, text: row.input,
      }).catch(() => null);
      if (outcome === true) return;
      if (outcome === null) throw unavailable("action_unconfirmed");
    }
    throw unavailable("audio_unavailable");
  }
}

/** @param {string} action */
function widgetFor(action) {
  return (/** @type {Record<string,string>} */ ({ buildVote: "chat-poll", pin: "chat-highlight", recap: "session-recap", broll: "stream-scene", tts: "multichat" }))[action];
}

module.exports = { TwitchRewardActions };
