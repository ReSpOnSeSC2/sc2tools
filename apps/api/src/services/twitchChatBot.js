"use strict";

/**
 * TwitchChatBotService — the bot that TALKS BACK in chat.
 *
 * The overlay's viewer commands (!rank, !mmr, !opponent, !build) were
 * previously answered on-stream only; a viewer not staring at the
 * video at that second got nothing. This service holds one Twitch IRC
 * connection per configured streamer (bot account credentials live in
 * the ``chatbot`` preferences namespace — NEVER served to overlay
 * tokens) and:
 *
 *   * answers commands IN CHAT (composing the same lines the
 *     Nightbot-style ChatbotService endpoints serve, plus themed
 *     !rank/!level/!xp from the engagement service),
 *   * feeds every chat message into the engagement ingest (XP,
 *     !win/!loss votes, spike detection) — deduped against browser
 *     reporters by the shared (token, platform, msgId) index, so the
 *     bot keeps engagement alive even with no dock or widget open,
 *   * announces Crystal Ball opens/settles and level-ups when the
 *     streamer enabled those toggles.
 *
 * Transport: raw IRC over ``wss://irc-ws.chat.twitch.tv`` (global
 * WebSocket; injectable factory for tests). Reconnects with capped
 * backoff; a failed login parks the connection in ``auth_failed`` and
 * does NOT retry — a bad token can't hot-loop against Twitch.
 */

const TWITCH_IRC_URL = "wss://irc-ws.chat.twitch.tv:443";

/** Minimum spacing between outbound chat lines (Twitch allows ~20/30s
 *  for a plain bot; 1.3s keeps a burst well inside the limit). */
const SEND_GAP_MS = 1_300;
/** Outbound queue cap — beyond this, lines are dropped oldest-first. */
const SEND_QUEUE_MAX = 8;
/** Per-command cooldown so chat can't make the bot spam. */
const COMMAND_COOLDOWN_MS = 8_000;
/** Per-viewer cooldown across all commands. */
const VIEWER_COOLDOWN_MS = 3_000;
/** Reconnect backoff ladder (ms). */
const BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 30_000, 60_000];
/** Duplicate-announcement window (multi-token users emit per token). */
const ANNOUNCE_DEDUPE_MS = 5_000;
/** Chat line hard cap (Twitch cuts at 500). */
const MAX_CHAT_CHARS = 450;

/** Server-side mirror of the web's race-themed rank ladders. */
const RANK_LADDERS = {
  protoss: [
    "Probe", "Zealot", "Adept", "Stalker", "Immortal",
    "High Templar", "Archon", "Colossus", "Carrier", "Mothership",
  ],
  terran: [
    "SCV", "Marine", "Marauder", "Reaper", "Hellion",
    "Siege Tank", "Liberator", "Ghost", "Thor", "Battlecruiser",
  ],
  zerg: [
    "Larva", "Drone", "Zergling", "Roach", "Hydralisk",
    "Mutalisk", "Lurker", "Ultralisk", "Brood Lord", "Swarm Host",
  ],
};

/**
 * @typedef {{
 *   enabled: boolean,
 *   username: string,
 *   token: string,
 *   channel: string,
 *   replyCommands: boolean,
 *   announceOracle: boolean,
 *   announceLevelUps: boolean,
 * }} BotConfig
 */

class TwitchChatBotService {
  /**
   * @param {{
   *   db: {users: import('mongodb').Collection},
   *   users: {getPreferences: (userId: string, type: string) => Promise<Record<string, any>>},
   *   overlayTokens: {resolve: (token: string) => Promise<{userId: string}|null>, list: (userId: string) => Promise<Array<Record<string, any>>>},
   *   engagement?: import('./multichatEngagement').MultichatEngagementService,
   *   chatbot?: import('./chatbot').ChatbotService,
   *   logger?: import('pino').Logger | null,
   *   wsFactory?: (url: string) => any,
   *   now?: () => number,
   * }} deps
   */
  constructor(deps) {
    this.db = deps.db;
    this.users = deps.users;
    this.overlayTokens = deps.overlayTokens;
    this.engagement = deps.engagement || null;
    this.chatbot = deps.chatbot || null;
    this.logger = deps.logger || null;
    this.wsFactory =
      deps.wsFactory ||
      ((url) => new WebSocket(url));
    this.now = deps.now || Date.now;
    /** @type {Map<string, any>} userId → live connection record */
    this._conns = new Map();
    /** @type {Map<string, {userId: string, atMs: number}>} token→user cache */
    this._tokenCache = new Map();
    this._ircIdSeq = 0;
  }

  /**
   * Boot-time restore: reconnect every streamer whose saved config is
   * enabled. Best-effort — a down Twitch endpoint must not block app
   * boot (connections retry on their own backoff).
   */
  async restoreAll() {
    try {
      const docs = await this.db.users
        .find(
          { "preferences.chatbot.enabled": true },
          { projection: { _id: 0, userId: 1, "preferences.chatbot": 1 } },
        )
        .limit(500)
        .toArray();
      for (const doc of docs) {
        const cfg = doc.preferences && doc.preferences.chatbot;
        if (doc.userId && cfg) {
          await this.configure(String(doc.userId), cfg);
        }
      }
    } catch (err) {
      this._log("warn", { err: String(err) }, "chatbot restore failed");
    }
  }

  /**
   * Apply a (new) config for one streamer: start, restart, or stop.
   * @param {string} userId
   * @param {Record<string, any>} rawCfg
   */
  async configure(userId, rawCfg) {
    const cfg = normalizeConfig(rawCfg);
    this.stop(userId);
    if (!cfg.enabled || !cfg.username || !cfg.token || !cfg.channel) {
      return;
    }
    /** @type {Record<string, any>} */
    const conn = {
      userId,
      cfg,
      state: "connecting",
      lastError: null,
      lastConnectedAt: null,
      ws: null,
      backoffIdx: 0,
      stopped: false,
      sendQueue: [],
      sendTimer: null,
      lastSentAt: 0,
      cmdCooldown: new Map(),
      viewerCooldown: new Map(),
      lastAnnounce: new Map(),
      overlayToken: null,
      rankRace: "protoss",
      reconnectTimer: null,
    };
    this._conns.set(userId, conn);
    // Resolve the streamer's first active overlay token (keys the
    // engagement + chatbot data) and their rank-race theme. Both are
    // decorative — failures leave the bot chatting with fallbacks.
    try {
      const items = await this.overlayTokens.list(userId);
      const active = (items || []).find((t) => t && t.token && !t.revokedAt);
      conn.overlayToken = active ? String(active.token) : null;
    } catch {
      conn.overlayToken = null;
    }
    try {
      const prefs = await this.users.getPreferences(userId, "multichat");
      const race = prefs && prefs.engagement && prefs.engagement.rankRace;
      if (race === "terran" || race === "zerg" || race === "protoss") {
        conn.rankRace = race;
      }
    } catch {
      /* default stands */
    }
    this._connect(conn);
  }

  /** @param {string} userId */
  stop(userId) {
    const conn = this._conns.get(userId);
    if (!conn) return;
    conn.stopped = true;
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
    if (conn.sendTimer) clearTimeout(conn.sendTimer);
    try {
      if (conn.ws) conn.ws.close();
    } catch {
      /* already closed */
    }
    this._conns.delete(userId);
  }

  stopAll() {
    for (const userId of [...this._conns.keys()]) this.stop(userId);
  }

  /**
   * Runtime status for the settings UI.
   * @param {string} userId
   * @returns {{state: string, channel: string|null, lastError: string|null, lastConnectedAt: number|null}}
   */
  status(userId) {
    const conn = this._conns.get(userId);
    if (!conn) {
      return { state: "off", channel: null, lastError: null, lastConnectedAt: null };
    }
    return {
      state: conn.state,
      channel: conn.cfg.channel,
      lastError: conn.lastError,
      lastConnectedAt: conn.lastConnectedAt,
    };
  }

  /**
   * Engagement broadcast hook (wired in app.js): announce Crystal
   * Ball opens/settles and level-ups in chat, per streamer toggles.
   * Called once per overlay token — announcements dedupe per user so
   * multi-token streamers hear each event once.
   *
   * @param {string} token
   * @param {Record<string, any>} msg
   */
  async handleEngagementEvent(token, msg) {
    if (!msg || typeof msg.type !== "string") return;
    const userId = await this._userIdForToken(token);
    if (!userId) return;
    const conn = this._conns.get(userId);
    if (!conn || conn.state !== "connected") return;
    /** @type {string|null} */
    let line = null;
    /** @type {string} */
    let dedupeKey = "";
    if (msg.type === "prediction-open" && conn.cfg.announceOracle) {
      dedupeKey = `open:${msg.gameKey ?? ""}`;
      line = `🔮 Crystal Ball is OPEN${msg.opponent ? ` vs ${msg.opponent}` : ""} — type !win or !loss now (voting locks ~a minute in)!`;
    } else if (msg.type === "prediction-settled" && conn.cfg.announceOracle) {
      dedupeKey = `settled:${msg.gameKey ?? ""}`;
      const t = msg.tally || {};
      const total = Number(t.total) || 0;
      const result = msg.result === "win" ? "WIN" : "LOSS";
      if (total > 0) {
        const majority = Number(t.win) >= Number(t.loss) ? "WIN" : "LOSS";
        const pct = Math.round(
          (Math.max(Number(t.win) || 0, Number(t.loss) || 0) / total) * 100,
        );
        const right = majority === result;
        const correct = Math.max(0, Number(msg.correctCount) || 0);
        line = `🔮 Result: ${result}. Chat said ${pct}% ${majority} — chat was ${right ? "RIGHT" : "WRONG"}! ${correct} oracle${correct === 1 ? "" : "s"} +${Number(msg.pointsEach) || 10} pts`;
      } else {
        line = `🔮 Result: ${result} — nobody called it. Type !win / !loss when the next game loads!`;
      }
    } else if (msg.type === "level-up" && conn.cfg.announceLevelUps) {
      dedupeKey = `level:${msg.user ?? ""}:${msg.level ?? ""}`;
      const rank = themedRank(conn.rankRace, Number(msg.level));
      line = `⭐ ${msg.user} leveled up — ${rank} (Lv ${msg.level})!`;
    }
    if (!line) return;
    const nowMs = this.now();
    const lastAt = conn.lastAnnounce.get(dedupeKey) ?? 0;
    if (nowMs - lastAt < ANNOUNCE_DEDUPE_MS) return;
    conn.lastAnnounce.set(dedupeKey, nowMs);
    this._say(conn, line);
  }

  /* ──────────────── connection lifecycle ──────────────── */

  /** @param {Record<string, any>} conn */
  _connect(conn) {
    if (conn.stopped) return;
    conn.state = "connecting";
    /** @type {any} */
    let ws;
    try {
      ws = this.wsFactory(TWITCH_IRC_URL);
    } catch (err) {
      conn.lastError = `socket create failed: ${String(err)}`;
      this._scheduleReconnect(conn);
      return;
    }
    conn.ws = ws;
    let buffer = "";
    ws.addEventListener("open", () => {
      if (conn.stopped) return;
      const token = conn.cfg.token.replace(/^oauth:/i, "");
      this._raw(conn, "CAP REQ :twitch.tv/tags twitch.tv/commands");
      this._raw(conn, `PASS oauth:${token}`);
      this._raw(conn, `NICK ${conn.cfg.username.toLowerCase()}`);
    });
    ws.addEventListener("message", (/** @type {{data?: unknown}} */ ev) => {
      if (conn.stopped) return;
      buffer += String(ev.data ?? "");
      const lines = buffer.split("\r\n");
      buffer = lines.pop() ?? "";
      for (const lineStr of lines) {
        if (lineStr) this._handleLine(conn, lineStr);
      }
    });
    const onGone = () => {
      if (conn.stopped) return;
      if (conn.state === "auth_failed") return;
      conn.state = "connecting";
      this._scheduleReconnect(conn);
    };
    ws.addEventListener("close", onGone);
    ws.addEventListener("error", () => {
      conn.lastError = "socket error";
      onGone();
    });
  }

  /** @param {Record<string, any>} conn */
  _scheduleReconnect(conn) {
    if (conn.stopped || conn.reconnectTimer) return;
    const delay = BACKOFF_MS[Math.min(conn.backoffIdx, BACKOFF_MS.length - 1)];
    conn.backoffIdx += 1;
    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = null;
      this._connect(conn);
    }, delay);
    // Never hold process exit open for a chat bot retry.
    if (conn.reconnectTimer && typeof conn.reconnectTimer.unref === "function") {
      conn.reconnectTimer.unref();
    }
  }

  /**
   * One inbound IRC line.
   * @param {Record<string, any>} conn
   * @param {string} lineStr
   */
  _handleLine(conn, lineStr) {
    const msg = parseIrcLine(lineStr);
    if (!msg) return;
    if (msg.command === "PING") {
      this._raw(conn, `PONG :${msg.trailing ?? "tmi.twitch.tv"}`);
      return;
    }
    if (msg.command === "001") {
      // Welcome — logged in. Join and reset backoff.
      conn.state = "connected";
      conn.lastError = null;
      conn.lastConnectedAt = this.now();
      conn.backoffIdx = 0;
      this._raw(conn, `JOIN #${conn.cfg.channel.toLowerCase()}`);
      return;
    }
    if (msg.command === "NOTICE") {
      const text = (msg.trailing || "").toLowerCase();
      if (text.includes("login authentication failed") || text.includes("improperly formatted auth")) {
        conn.state = "auth_failed";
        conn.lastError = "Twitch rejected the bot token — generate a fresh one.";
        try {
          conn.ws.close();
        } catch {
          /* already closed */
        }
      }
      return;
    }
    if (msg.command === "PRIVMSG") {
      void this._handleChatMessage(conn, msg).catch((err) => {
        this._log("warn", { err: String(err) }, "chatbot message handling failed");
      });
    }
  }

  /**
   * One chat message: ingest for engagement, then answer commands.
   * @param {Record<string, any>} conn
   * @param {ReturnType<typeof parseIrcLine>} msg
   */
  async _handleChatMessage(conn, msg) {
    if (!msg) return;
    const nick = msg.nick || "";
    if (!nick || nick.toLowerCase() === conn.cfg.username.toLowerCase()) return;
    const text = String(msg.trailing ?? "").trim();
    if (!text) return;
    const display = msg.tags["display-name"] || nick;
    // Engagement ingest — XP, !win/!loss picks, spike detection. The
    // IRC tag id matches what the browser Twitch engine reports, so
    // the shared unique index dedupes when both surfaces are open.
    if (this.engagement && conn.overlayToken) {
      this._ircIdSeq += 1;
      const id = msg.tags.id || `irc-${this.now()}-${this._ircIdSeq}`;
      try {
        await this.engagement.ingest(conn.overlayToken, [
          { platform: "twitch", id, user: display, text, atMs: this.now() },
        ]);
      } catch {
        /* engagement is additive — never break the reply path */
      }
    }
    if (!conn.cfg.replyCommands) return;
    if (!text.startsWith("!")) return;
    const command = text.slice(1).split(/\s+/, 1)[0].toLowerCase();
    const reply = await this._answerCommand(conn, command, display);
    if (!reply) return;
    const nowMs = this.now();
    if (nowMs - (conn.cmdCooldown.get(command) ?? 0) < COMMAND_COOLDOWN_MS) return;
    if (nowMs - (conn.viewerCooldown.get(nick) ?? 0) < VIEWER_COOLDOWN_MS) return;
    conn.cmdCooldown.set(command, nowMs);
    conn.viewerCooldown.set(nick, nowMs);
    this._say(conn, reply);
  }

  /**
   * Compose the reply for one command, or null for non-commands.
   * @param {Record<string, any>} conn
   * @param {string} command
   * @param {string} display viewer display name
   * @returns {Promise<string|null>}
   */
  async _answerCommand(conn, command, display) {
    const token = conn.overlayToken;
    try {
      if (command === "rank" || command === "level" || command === "xp") {
        if (!this.engagement || !token) return null;
        const s = await this.engagement.viewerStats(token, "twitch", display);
        if (!s.found) {
          return `@${display} no XP yet — chat a bit and check again! (2 XP per message)`;
        }
        const rank = themedRank(conn.rankRace, s.level);
        const next =
          s.nextLevel !== null
            ? ` — ${s.xpToNext} XP to ${themedRank(conn.rankRace, s.nextLevel)}`
            : " — max rank!";
        const oracle = s.oracleScore > 0 ? ` · 🔮 ${s.oracleScore} oracle pts` : "";
        return `@${display} ${rank} (Lv ${s.level}) · ${s.xp} XP${next}${oracle}`;
      }
      if (command === "mmr" || command === "session") {
        if (!this.chatbot || !token) return null;
        const line = await this.chatbot.mmrLine(token);
        return line ? `@${display} ${line}` : null;
      }
      if (command === "opponent" || command === "opp") {
        if (!this.chatbot || !token) return null;
        const line = await this.chatbot.opponentLine(token);
        return line ? `@${display} ${line}` : null;
      }
      if (command === "build") {
        if (!this.chatbot || !token) return null;
        const line = await this.chatbot.buildLine(token);
        return line ? `@${display} ${line}` : null;
      }
      if (command === "commands" || command === "help") {
        return `@${display} commands: !rank (your XP + rank) · !mmr (session) · !opponent · !build · !win / !loss (call the game) · !1 !2 !3 (build votes)`;
      }
    } catch (err) {
      this._log("warn", { err: String(err), command }, "chatbot command failed");
    }
    return null;
  }

  /* ──────────────── outbound ──────────────── */

  /**
   * Queue a chat line (rate-limited).
   * @param {Record<string, any>} conn
   * @param {string} text
   */
  _say(conn, text) {
    if (conn.state !== "connected") return;
    const line = `PRIVMSG #${conn.cfg.channel.toLowerCase()} :${text.slice(0, MAX_CHAT_CHARS)}`;
    conn.sendQueue.push(line);
    while (conn.sendQueue.length > SEND_QUEUE_MAX) conn.sendQueue.shift();
    this._drainSendQueue(conn);
  }

  /** @param {Record<string, any>} conn */
  _drainSendQueue(conn) {
    if (conn.sendTimer || conn.sendQueue.length === 0) return;
    const nowMs = this.now();
    const wait = Math.max(0, conn.lastSentAt + SEND_GAP_MS - nowMs);
    conn.sendTimer = setTimeout(() => {
      conn.sendTimer = null;
      const line = conn.sendQueue.shift();
      if (line && conn.state === "connected") {
        conn.lastSentAt = this.now();
        this._raw(conn, line);
      }
      this._drainSendQueue(conn);
    }, wait);
    if (conn.sendTimer && typeof conn.sendTimer.unref === "function") {
      conn.sendTimer.unref();
    }
  }

  /**
   * Raw IRC write.
   * @param {Record<string, any>} conn
   * @param {string} line
   */
  _raw(conn, line) {
    try {
      conn.ws.send(`${line}\r\n`);
    } catch {
      /* socket raced closed — reconnect flow owns recovery */
    }
  }

  /** @param {string} token */
  async _userIdForToken(token) {
    const cached = this._tokenCache.get(token);
    if (cached && this.now() - cached.atMs < 60_000) return cached.userId;
    try {
      const resolved = await this.overlayTokens.resolve(token);
      if (!resolved) return null;
      this._tokenCache.set(token, { userId: resolved.userId, atMs: this.now() });
      if (this._tokenCache.size > 1000) {
        const oldest = this._tokenCache.keys().next().value;
        if (oldest !== undefined) this._tokenCache.delete(oldest);
      }
      return resolved.userId;
    } catch {
      return null;
    }
  }

  /**
   * @param {'warn'|'info'} level
   * @param {Record<string, any>} fields
   * @param {string} msg
   */
  _log(level, fields, msg) {
    try {
      if (this.logger && typeof this.logger[level] === "function") {
        this.logger[level](fields, msg);
      }
    } catch {
      /* logging must never throw */
    }
  }
}

/* ──────────────── helpers ──────────────── */

/**
 * Normalize a stored/raw bot config into the strict shape the
 * connection code trusts.
 * @param {Record<string, any>} raw
 * @returns {BotConfig}
 */
function normalizeConfig(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const username =
    typeof r.username === "string" && /^[A-Za-z0-9_]{2,26}$/.test(r.username.trim())
      ? r.username.trim()
      : "";
  const channel =
    typeof r.channel === "string" && /^[A-Za-z0-9_]{2,26}$/.test(r.channel.trim())
      ? r.channel.trim()
      : username;
  const token =
    typeof r.token === "string"
      ? r.token.trim().replace(/^oauth:/i, "").slice(0, 120)
      : "";
  return {
    enabled: r.enabled === true,
    username,
    channel,
    token: /^[A-Za-z0-9]{10,}$/.test(token) ? token : "",
    replyCommands: r.replyCommands !== false,
    announceOracle: r.announceOracle !== false,
    announceLevelUps: r.announceLevelUps !== false,
  };
}

/**
 * Minimal IRC line parser (tags + prefix + command + trailing).
 * @param {string} lineStr
 * @returns {{tags: Record<string, string>, nick: string|null, command: string, params: string[], trailing: string|null} | null}
 */
function parseIrcLine(lineStr) {
  let rest = lineStr;
  /** @type {Record<string, string>} */
  const tags = {};
  if (rest.startsWith("@")) {
    const sp = rest.indexOf(" ");
    if (sp === -1) return null;
    for (const pair of rest.slice(1, sp).split(";")) {
      const eq = pair.indexOf("=");
      if (eq === -1) tags[pair] = "";
      else tags[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    rest = rest.slice(sp + 1);
  }
  /** @type {string|null} */
  let nick = null;
  if (rest.startsWith(":")) {
    const sp = rest.indexOf(" ");
    if (sp === -1) return null;
    const prefix = rest.slice(1, sp);
    const bang = prefix.indexOf("!");
    nick = bang === -1 ? prefix : prefix.slice(0, bang);
    rest = rest.slice(sp + 1);
  }
  /** @type {string|null} */
  let trailing = null;
  const colon = rest.indexOf(" :");
  if (colon !== -1) {
    trailing = rest.slice(colon + 2);
    rest = rest.slice(0, colon);
  }
  const parts = rest.split(" ").filter(Boolean);
  if (parts.length === 0) return null;
  return { tags, nick, command: parts[0], params: parts.slice(1), trailing };
}

/**
 * Level → race-themed rank name (clamped).
 * @param {string} race
 * @param {number} level
 * @returns {string}
 */
function themedRank(race, level) {
  const ladder =
    RANK_LADDERS[/** @type {'protoss'|'terran'|'zerg'} */ (race)] ||
    RANK_LADDERS.protoss;
  const idx = Math.min(ladder.length - 1, Math.max(0, Math.round(level) || 0));
  return ladder[idx];
}

module.exports = {
  TwitchChatBotService,
  normalizeConfig,
  parseIrcLine,
  SEND_GAP_MS,
  COMMAND_COOLDOWN_MS,
};
