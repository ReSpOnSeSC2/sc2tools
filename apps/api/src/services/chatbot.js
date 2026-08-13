"use strict";

/**
 * ChatbotService — one-line plain-text answers for Nightbot /
 * StreamElements / Fossabot custom-API commands.
 *
 * A streamer wires e.g.
 *
 *   !opponent → $(urlfetch https://api.sc2tools.com/v1/chatbot/<token>/opponent)
 *
 * and the endpoint returns a single terse line for chat. The overlay
 * token in the path is the credential — same trust model as the OBS
 * Browser Source (the token IS the auth; chat bots can't send
 * headers). Token → userId resolution reuses
 * ``OverlayTokensService.resolve`` — the exact lookup the overlay
 * socket handshake uses — so revocation applies here instantly too.
 *
 * Data sources, richest first:
 *
 *   1. ``LiveGameBroker.latest(userId)`` — the agent's in-memory live
 *      envelope (opponent identity + SC2Pulse profile +
 *      ``streamerHistory`` enrichment). Fresh for ≤30 min.
 *   2. ``LiveGameBroker.latestOverlayLive(userId)`` — the post-game
 *      ``overlay:live`` payload derived at ingest. Fresh for ≤30 min.
 *   3. The most recent game row (via GamesService) + its opponents
 *      row — survives process restarts, always available once one
 *      game has been uploaded.
 *
 * Every public method returns ``null`` ONLY for an invalid / revoked
 * token (the route turns that into a plain-text 404). Missing data
 * never throws — it degrades to the documented fallback line.
 */

/** Hard cap so a line always fits chat-bot response limits. */
const MAX_LINE_CHARS = 380;

/** Envelope phases that mean "a match is on screen right now". */
const LIVE_PHASES = new Set([
  "match_loading",
  "match_started",
  "match_in_progress",
]);

/**
 * Collapse whitespace/newlines so the response is guaranteed to be a
 * single line no matter what a player name or map string carries.
 *
 * @param {unknown} value
 * @returns {string}
 */
function clean(value) {
  return String(value)
    .replace(/[\r\n\t\u2028\u2029]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * @param {string} line
 * @returns {string} single line, ≤ MAX_LINE_CHARS.
 */
function clip(line) {
  const s = clean(line);
  if (s.length <= MAX_LINE_CHARS) return s;
  return `${s.slice(0, MAX_LINE_CHARS - 1)}…`;
}

/**
 * @param {unknown} v
 * @returns {number|null}
 */
function finiteNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Map the cloud's "Victory"/"Defeat" (and the overlay payload's
 * "win"/"loss") onto the chat-friendly chip word. Mirrors
 * ``chipResult`` in overlayLiveAggregations.
 *
 * @param {unknown} raw
 * @returns {"Win"|"Loss"|"Tie"|null}
 */
function resultWord(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  if (s === "win" || s === "victory") return "Win";
  if (s === "loss" || s === "defeat") return "Loss";
  if (s === "tie") return "Tie";
  return null;
}

/**
 * Terse relative-time suffix ("just now" / "5m ago" / "3h ago" /
 * "2d ago"). Null for unparseable or future dates.
 *
 * @param {unknown} raw Date or ISO string
 * @returns {string|null}
 */
function agoText(raw) {
  const d = raw instanceof Date ? raw : new Date(String(raw));
  if (Number.isNaN(d.getTime())) return null;
  const ms = Date.now() - d.getTime();
  if (ms < 0) return null;
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * @param {unknown} myRace
 * @param {unknown} oppRace
 * @returns {string|null} e.g. "PvZ"
 */
function matchupLabel(myRace, oppRace) {
  const m = String(myRace || "").charAt(0).toUpperCase();
  const o = String(oppRace || "").charAt(0).toUpperCase();
  if (!m || !o) return null;
  return `${m}v${o}`;
}

/**
 * "H2H 3-2." / "First meeting." / null when unknown.
 *
 * @param {{wins?: unknown, losses?: unknown}|null|undefined} h2h
 * @returns {string|null}
 */
function h2hText(h2h) {
  if (!h2h || typeof h2h !== "object") return null;
  const wins = Number(h2h.wins) || 0;
  const losses = Number(h2h.losses) || 0;
  if (wins + losses === 0) return "First meeting.";
  return `H2H ${wins}-${losses}.`;
}

class ChatbotService {
  /**
   * @param {{
   *   games: import('mongodb').Collection,
   *   opponents: import('mongodb').Collection,
   * }} db
   * @param {{
   *   overlayTokens?: import('./types').OverlayTokensService,
   *   liveGameBroker?: import('./liveGameBroker').LiveGameBroker,
   *   games?: import('./games').GamesService,
   *   logger?: import('pino').Logger,
   * }} [services]
   */
  constructor(db, services = {}) {
    this.db = db;
    this.overlayTokens = services.overlayTokens || null;
    this.liveGameBroker = services.liveGameBroker || null;
    this.games = services.games || null;
    this.logger = services.logger || null;
  }

  /**
   * Live/last opponent line. Null = invalid/revoked token.
   *
   * @param {string} token
   * @returns {Promise<string|null>}
   */
  async opponentLine(token) {
    const userId = await this._userIdForToken(token);
    if (!userId) return null;
    try {
      const env = this.liveGameBroker ? this.liveGameBroker.latest(userId) : null;
      const opp = env
        ? /** @type {Record<string, any>|undefined} */ (env.opponent)
        : undefined;
      if (env && opp && typeof opp.name === "string" && opp.name.trim()) {
        return clip(this._opponentLineFromEnvelope(env));
      }
      const post = this.liveGameBroker
        ? /** @type {Record<string, any>|null} */ (
            this.liveGameBroker.latestOverlayLive(userId)
          )
        : null;
      if (post && typeof post.oppName === "string" && post.oppName.trim()) {
        return clip(this._opponentLineFromPostGame(post));
      }
      const fromRow = await this._opponentLineFromLastGame(userId);
      if (fromRow) return clip(fromRow);
    } catch (err) {
      this._warn(err, "chatbot_opponent_line_failed");
    }
    return clip("No opponent data yet.");
  }

  /**
   * Current MMR + session delta + session W-L. Same data source as
   * the overlay's session widget (``GamesService.todaySession``).
   * Null = invalid/revoked token.
   *
   * @param {string} token
   * @returns {Promise<string|null>}
   */
  async mmrLine(token) {
    const userId = await this._userIdForToken(token);
    if (!userId) return null;
    let session = null;
    if (this.games && typeof this.games.todaySession === "function") {
      try {
        session = await this.games.todaySession(userId);
      } catch (err) {
        this._warn(err, "chatbot_session_lookup_failed");
      }
    }
    if (!session) return clip("No MMR data yet.");
    /** @type {string[]} */
    const bits = [];
    const mmr = finiteNumber(session.mmrCurrent);
    if (mmr !== null) {
      let head = `MMR ${mmr}`;
      const start = finiteNumber(session.mmrStart);
      if (start !== null) {
        const delta = mmr - start;
        head += ` (${delta >= 0 ? "+" : ""}${delta} today)`;
      }
      bits.push(head);
    }
    const games = Number(session.games) || 0;
    if (games > 0) {
      let record = `Session ${Number(session.wins) || 0}W-${Number(session.losses) || 0}L`;
      const streak = session.streak;
      if (streak && Number(streak.count) >= 2) {
        record += ` (${streak.kind === "loss" ? "L" : "W"}${Number(streak.count)} streak)`;
      }
      bits.push(record);
    } else if (bits.length > 0) {
      bits.push("no games yet this session");
    }
    if (bits.length === 0) return clip("No MMR data yet.");
    return clip(bits.join(" | "));
  }

  /**
   * The classifier's tag for the streamer's current/last opener.
   * Null = invalid/revoked token.
   *
   * @param {string} token
   * @returns {Promise<string|null>}
   */
  async buildLine(token) {
    const userId = await this._userIdForToken(token);
    if (!userId) return null;
    try {
      const fromBroker = this._buildFromBrokerPayloads(userId);
      if (fromBroker) return clip(fromBroker);
      const row = await this._lastTaggedBuildRow(userId);
      if (row) return clip(this._buildLineFromRow(row));
    } catch (err) {
      this._warn(err, "chatbot_build_line_failed");
    }
    return clip("No build data yet.");
  }

  /* ================= internals ================= */

  /**
   * Token → userId via the shared OverlayTokensService lookup (same
   * verification the overlay socket handshake and the /overlay routes
   * use — revoked tokens resolve to null).
   *
   * @param {string} token
   * @returns {Promise<string|null>}
   */
  async _userIdForToken(token) {
    if (!this.overlayTokens || typeof token !== "string" || token.length === 0) {
      return null;
    }
    try {
      const hit = await this.overlayTokens.resolve(token);
      return hit && typeof hit.userId === "string" && hit.userId
        ? hit.userId
        : null;
    } catch (err) {
      this._warn(err, "chatbot_token_resolve_failed");
      return null;
    }
  }

  /**
   * Compose the live-opponent line from the agent's envelope
   * (identity + Pulse profile) and its ``streamerHistory``
   * enrichment (H2H, revealed name, prior meetings).
   *
   * @param {Record<string, any>} env
   * @returns {string}
   */
  _opponentLineFromEnvelope(env) {
    const opp = env.opponent;
    const hist =
      env.streamerHistory && typeof env.streamerHistory === "object"
        ? env.streamerHistory
        : null;
    const profile =
      opp.profile && typeof opp.profile === "object" ? opp.profile : null;
    /** @type {string[]} */
    const details = [];
    if (typeof opp.race === "string" && opp.race) details.push(clean(opp.race));
    const mmr =
      finiteNumber(profile ? profile.mmr : null)
      ?? finiteNumber(hist ? hist.oppMmr : null);
    if (mmr !== null) details.push(`${mmr} MMR`);
    if (profile && typeof profile.league === "string" && profile.league) {
      const tier = finiteNumber(profile.league_tier);
      details.push(
        tier !== null ? `${clean(profile.league)} ${tier}` : clean(profile.league),
      );
    }
    const revealed =
      hist && typeof hist.oppRevealedName === "string" && hist.oppRevealedName
        ? ` (aka ${clean(hist.oppRevealedName)})`
        : "";
    const prefix = LIVE_PHASES.has(env.phase) ? "Now vs" : "Last opponent:";
    const bits = [
      `${prefix} ${clean(opp.name)}${revealed}${details.length ? ` (${details.join(", ")})` : ""}.`,
    ];
    const h2h = h2hText(hist ? hist.headToHead : null);
    if (h2h) bits.push(h2h);
    const lastMeeting = this._lastMeetingNote(hist ? hist.recentGames : null);
    if (lastMeeting) bits.push(lastMeeting);
    return bits.join(" ");
  }

  /**
   * "Last meeting: Win on Goldenaura, 3d ago." from the enrichment's
   * ``recentGames`` rows (newest first, results are the streamer's).
   *
   * @param {Array<Record<string, any>>|null|undefined} recentGames
   * @returns {string|null}
   */
  _lastMeetingNote(recentGames) {
    if (!Array.isArray(recentGames) || recentGames.length === 0) return null;
    const g = recentGames[0];
    if (!g || typeof g !== "object") return null;
    const word = resultWord(g.result);
    if (!word) return null;
    let note = `Last meeting: ${word}`;
    if (g.map) note += ` on ${clean(g.map)}`;
    const ago = g.date ? agoText(g.date) : null;
    if (ago) note += `, ${ago}`;
    return `${note}.`;
  }

  /**
   * Compose from the cached post-game ``overlay:live`` payload
   * (``OverlayLiveService.buildFromGame`` shape). The payload's
   * ``result`` is the streamer's, so the line reads as "how the last
   * game went" — no separate last-meeting note needed.
   *
   * @param {Record<string, any>} payload
   * @returns {string}
   */
  _opponentLineFromPostGame(payload) {
    /** @type {string[]} */
    const details = [];
    if (payload.oppRace) details.push(clean(payload.oppRace));
    const mmr = finiteNumber(payload.oppMmr);
    if (mmr !== null) details.push(`${mmr} MMR`);
    const revealed =
      typeof payload.oppRevealedName === "string" && payload.oppRevealedName
        ? ` (aka ${clean(payload.oppRevealedName)})`
        : "";
    const bits = [
      `Last opponent: ${clean(payload.oppName)}${revealed}${details.length ? ` (${details.join(", ")})` : ""}.`,
    ];
    const word = resultWord(payload.result);
    if (word) {
      bits.push(`${word}${payload.map ? ` on ${clean(payload.map)}` : ""}.`);
    }
    const h2h = h2hText(payload.headToHead);
    if (h2h) bits.push(h2h);
    return bits.join(" ");
  }

  /**
   * Cold-path fallback: the most recent game row + its opponents row
   * (H2H counters / revealed name / stored MMR). Null when the user
   * has no games at all.
   *
   * @param {string} userId
   * @returns {Promise<string|null>}
   */
  async _opponentLineFromLastGame(userId) {
    const row = await this._lastGameRow(userId);
    if (!row || !row.opponent || !row.opponent.displayName) return null;
    const opp = row.opponent;
    const oppRow = await this._opponentsRow(userId, opp);
    /** @type {string[]} */
    const details = [];
    if (opp.race) details.push(clean(opp.race));
    const mmr =
      finiteNumber(opp.mmr) ?? finiteNumber(oppRow ? oppRow.mmr : null);
    if (mmr !== null) details.push(`${mmr} MMR`);
    const revealed =
      oppRow && typeof oppRow.revealedName === "string" && oppRow.revealedName
        ? ` (aka ${clean(oppRow.revealedName)})`
        : "";
    const bits = [
      `Last opponent: ${clean(opp.displayName)}${revealed}${details.length ? ` (${details.join(", ")})` : ""}.`,
    ];
    const word = resultWord(row.result);
    if (word) {
      let r = word;
      if (row.map) r += ` on ${clean(row.map)}`;
      const ago = row.date ? agoText(row.date) : null;
      if (ago) r += `, ${ago}`;
      bits.push(`${r}.`);
    }
    // Only claim an H2H when the opponents row exists — an absent row
    // means the counters haven't landed; "First meeting." would be a
    // lie right after playing them.
    if (oppRow) {
      const h2h = h2hText({ wins: oppRow.wins, losses: oppRow.losses });
      if (h2h) bits.push(h2h);
    }
    return bits.join(" ");
  }

  /**
   * Most recent game row for the user, via the games service when
   * wired (preferred) or a direct find as a last resort.
   *
   * @param {string} userId
   * @returns {Promise<Record<string, any>|null>}
   */
  async _lastGameRow(userId) {
    if (this.games && typeof this.games.list === "function") {
      try {
        const page = await this.games.list(userId, { limit: 1 });
        const row = page && Array.isArray(page.items) ? page.items[0] : null;
        return row || null;
      } catch (err) {
        this._warn(err, "chatbot_last_game_failed");
        return null;
      }
    }
    try {
      return await this.db.games.findOne(
        { userId, isResumedFromReplay: { $ne: true } },
        { projection: { _id: 0 }, sort: { date: -1 } },
      );
    } catch (err) {
      this._warn(err, "chatbot_last_game_failed");
      return null;
    }
  }

  /**
   * The opponents row for a game's opponent — pulseCharacterId first
   * (stable across toon-handle rotation), then pulseId. Same order
   * ``OverlayLiveService.buildFromOpponentName`` uses.
   *
   * @param {string} userId
   * @param {Record<string, any>} opp game row's ``opponent`` object
   * @returns {Promise<Record<string, any>|null>}
   */
  async _opponentsRow(userId, opp) {
    const projection = {
      _id: 0,
      wins: 1,
      losses: 1,
      gameCount: 1,
      mmr: 1,
      revealedName: 1,
    };
    try {
      const pcid =
        opp.pulseCharacterId !== undefined
        && opp.pulseCharacterId !== null
        && String(opp.pulseCharacterId).length > 0
          ? String(opp.pulseCharacterId)
          : null;
      if (pcid) {
        const row = await this.db.opponents.findOne(
          { userId, pulseCharacterId: pcid },
          { projection },
        );
        if (row) return row;
      }
      if (typeof opp.pulseId === "string" && opp.pulseId) {
        const row = await this.db.opponents.findOne(
          { userId, pulseId: opp.pulseId },
          { projection },
        );
        if (row) return row;
      }
    } catch (err) {
      this._warn(err, "chatbot_opponents_lookup_failed");
    }
    return null;
  }

  /**
   * Defensive reads of the broker's live envelope / post-game payload
   * for a ``myBuild`` field. Neither carries it today (the classifier
   * tag lands on the game row at ingest) — but if a future payload
   * stamps it, the chat line picks it up with no code change here.
   *
   * @param {string} userId
   * @returns {string|null}
   */
  _buildFromBrokerPayloads(userId) {
    if (!this.liveGameBroker) return null;
    const env = this.liveGameBroker.latest(userId);
    if (env && typeof env.myBuild === "string" && env.myBuild.trim()) {
      return `Current build: ${clean(env.myBuild)}`;
    }
    const post = /** @type {Record<string, any>|null} */ (
      this.liveGameBroker.latestOverlayLive(userId)
    );
    if (post && typeof post.myBuild === "string" && post.myBuild.trim()) {
      return `Last game's build: ${clean(post.myBuild)}`;
    }
    return null;
  }

  /**
   * Most recent game row carrying a non-empty classifier tag.
   *
   * @param {string} userId
   * @returns {Promise<Record<string, any>|null>}
   */
  async _lastTaggedBuildRow(userId) {
    try {
      return await this.db.games.findOne(
        {
          userId,
          isResumedFromReplay: { $ne: true },
          myBuild: { $type: "string", $ne: "" },
        },
        {
          projection: {
            _id: 0,
            myBuild: 1,
            myRace: 1,
            result: 1,
            map: 1,
            date: 1,
            "opponent.race": 1,
          },
          sort: { date: -1 },
        },
      );
    } catch (err) {
      this._warn(err, "chatbot_build_lookup_failed");
      return null;
    }
  }

  /**
   * "Last opener: P - Stargate (PvZ, Loss on Alcyone, 2d ago)"
   *
   * @param {Record<string, any>} row
   * @returns {string}
   */
  _buildLineFromRow(row) {
    /** @type {string[]} */
    const details = [];
    const mu = matchupLabel(row.myRace, row.opponent && row.opponent.race);
    if (mu) details.push(mu);
    const word = resultWord(row.result);
    if (word) details.push(row.map ? `${word} on ${clean(row.map)}` : word);
    const ago = row.date ? agoText(row.date) : null;
    if (ago) details.push(ago);
    return `Last opener: ${clean(row.myBuild)}${details.length ? ` (${details.join(", ")})` : ""}`;
  }

  /**
   * @param {unknown} err
   * @param {string} msg
   */
  _warn(err, msg) {
    if (this.logger && typeof this.logger.warn === "function") {
      try {
        this.logger.warn({ err }, msg);
      } catch {
        // Logging must never break a chat line.
      }
    }
  }
}

module.exports = { ChatbotService, MAX_LINE_CHARS };
