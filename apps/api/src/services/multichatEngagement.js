"use strict";

/**
 * MultichatEngagementService — per-viewer engagement across all four
 * chat platforms: loyalty XP + levels, the Crystal Ball prediction
 * game (!win / !loss), and clip-moment detection. Rank NAMES are a
 * client concern (Settings picks a race ladder; widgets map levels
 * via lib/multichat/rankLadders) — the ``rank`` strings emitted here
 * are a Protoss-named fallback for consumers without config access.
 *
 * Architecture: chat connections live in the BROWSER (widgets/dock),
 * so every open surface reports the messages it sees in idempotent
 * batches; a unique (token, platform, msgId) index makes duplicate
 * reports from multiple Browser Sources a no-op. Game results flow
 * through the API (routes/games emitOverlayLive), so prediction
 * windows open on the live-game envelope and settle server-side when
 * the replay-verified result lands — viewers can't be cheated by a
 * flaky source.
 *
 * Broadcasts ride the token's socket room as ``overlay:engagement``
 * ({type: "prediction-open" | "prediction-tally" |
 * "prediction-settled" | "level-up" | "clip-moment" | "wall"}).
 */

const BATCH_MAX = 100;
const TEXT_MAX = 200;
const PLATFORMS = ["twitch", "kick", "youtube", "tiktok"];
const XP_PER_MESSAGE = 2;
/** Platform-event XP by kind — hype pays more. */
const EVENT_XP = {
  sub: 50,
  resub: 40,
  giftsub: 60,
  raid: 100,
  member: 50,
  superchat: 60,
  gift: 20,
  follow: 10,
};
const ORACLE_POINTS = 10;
const TALLY_THROTTLE_MS = 2_000;
// Voting stays open for ~the first minute of the game: the window
// opens at match_loading, so 90s covers the loading screen plus
// roughly a minute of play. After the lock, !win/!loss picks are
// ignored (no cheating by voting once the game is readable) and the
// widgets drop their CALL IT prompt.
const PREDICTION_LOCK_MS = 90_000;
// An open window whose result never arrived (abandoned game, agent
// offline at game end) must not haunt the overlay forever — after
// this long it stops being reported as the open prediction.
const PREDICTION_STALE_MS = 3 * 60 * 60 * 1000;
/** Clip detection: 10 s buckets, spike vs trailing 2 min median. */
const CLIP_BUCKET_MS = 10_000;
const CLIP_WINDOW_BUCKETS = 12;
const CLIP_MIN_COUNT = 8;
const CLIP_SPIKE_FACTOR = 3;
const CLIP_COOLDOWN_MS = 90_000;
const CLIP_SAMPLE_MAX = 5;

/** Fallback rank names (Protoss ladder). Level n needs xpForLevel(n);
 * clients re-theme by the streamer's chosen race. */
const RANK_NAMES = [
  "Probe",
  "Zealot",
  "Adept",
  "Stalker",
  "Immortal",
  "High Templar",
  "Archon",
  "Colossus",
  "Carrier",
  "Mothership",
];

/** @param {number} level */
function xpForLevel(level) {
  return Math.round(100 * Math.pow(level, 1.7));
}

/** @param {number} xp */
function levelForXp(xp) {
  let level = 0;
  while (level < RANK_NAMES.length - 1 && xp >= xpForLevel(level + 1)) {
    level += 1;
  }
  return level;
}

/** @param {number} level */
function rankName(level) {
  return RANK_NAMES[Math.min(level, RANK_NAMES.length - 1)];
}

/** @param {string} text */
function parsePick(text) {
  const t = String(text).trim().toLowerCase();
  if (t === "!win" || t === "!w") return "win";
  if (t === "!loss" || t === "!lose" || t === "!l") return "loss";
  return null;
}

class MultichatEngagementService {
  /**
   * @param {{
   *   multichatEngagementEvents: import('mongodb').Collection,
   *   multichatViewers: import('mongodb').Collection,
   *   multichatPredictions: import('mongodb').Collection,
   *   multichatClipMoments: import('mongodb').Collection,
   * }} db
   * @param {{
   *   io?: import('socket.io').Server,
   *   overlayTokens?: { listForUser?: (userId: string) => Promise<Array<{token: string, revokedAt?: Date | null}>> , listActiveTokens?: (userId: string) => Promise<string[]>, resolve?: (token: string) => Promise<{userId: string} | null> },
   *   users?: { getPreferences: (userId: string, type: string) => Promise<Record<string, any>> },
   *   now?: () => number,
   * }} [deps]
   */
  constructor(db, deps = {}) {
    /**
     * Out-of-band event listener (Twitch chat bot announcements) —
     * assigned post-construction in app.js.
     * @type {((token: string, msg: Record<string, any>) => void) | null}
     */
    this.onEvent = null;
    this.events = db.multichatEngagementEvents;
    this.viewers = db.multichatViewers;
    this.predictions = db.multichatPredictions;
    this.clips = db.multichatClipMoments;
    this.io = deps.io || null;
    this.overlayTokens = deps.overlayTokens || null;
    this.users = deps.users || null;
    this.now = deps.now || (() => Date.now());
    /** @type {Map<string, number[]>} token → per-bucket message counts */
    this._buckets = new Map();
    /** @type {Map<string, number>} token → last clip moment ms */
    this._lastClipAt = new Map();
    /** @type {Map<string, number>} token → last tally broadcast ms */
    this._lastTallyAt = new Map();
  }

  /** @param {string} token @param {Record<string, unknown>} msg */
  _emit(token, msg) {
    if (this.io) this.io.to(`overlay:${token}`).emit("overlay:engagement", msg);
    // Out-of-band listener (the Twitch chat bot's announcements).
    // Assigned post-construction in app.js; failures must never
    // break the overlay broadcast path.
    if (typeof this.onEvent === "function") {
      try {
        this.onEvent(token, msg);
      } catch {
        /* listener errors are its own problem */
      }
    }
  }

  /**
   * Idempotent batch ingest from any browser surface.
   *
   * @param {string} token
   * @param {unknown} rawEvents
   */
  async ingest(token, rawEvents) {
    const now = this.now();
    const batch = (Array.isArray(rawEvents) ? rawEvents : [])
      .slice(0, BATCH_MAX)
      .map((e) => {
        const r = /** @type {Record<string, any>} */ (e && typeof e === "object" ? e : {});
        const platform = PLATFORMS.includes(r.platform) ? r.platform : null;
        const msgId = typeof r.id === "string" ? r.id.slice(0, 120) : "";
        const user = typeof r.user === "string" ? r.user.trim().slice(0, 60) : "";
        if (!platform || !msgId || !user) return null;
        return {
          token,
          platform,
          msgId,
          user,
          userKey: `${platform}:${user.toLowerCase()}`,
          text: typeof r.text === "string" ? r.text.slice(0, TEXT_MAX) : "",
          kind:
            typeof r.kind === "string" && EVENT_XP[/** @type {keyof typeof EVENT_XP} */ (r.kind)]
              ? r.kind
              : null,
          atMs: Number.isFinite(Number(r.atMs)) ? Number(r.atMs) : now,
          atDate: new Date(),
        };
      })
      .filter((e) => e !== null);
    if (batch.length === 0) return { accepted: 0 };

    let accepted = /** @type {any[]} */ ([]);
    try {
      await this.events.insertMany(batch, { ordered: false });
      // No error → every doc was new.
      accepted = batch;
    } catch (err) {
      // Duplicate keys — keep only the docs that actually inserted.
      const writeErrors = /** @type {any} */ (err)?.writeErrors ?? [];
      const failedIdx = new Set(writeErrors.map((/** @type {any} */ w) => w.index ?? w.err?.index));
      accepted = batch.filter((_, i) => !failedIdx.has(i));
      if (!Array.isArray(writeErrors) || writeErrors.length === 0) accepted = [];
    }
    if (accepted.length === 0) return { accepted: 0 };

    await this._creditXp(token, accepted);
    await this._recordPicks(token, accepted);
    await this._detectClipSpike(token, accepted);
    return { accepted: accepted.length };
  }

  /** @param {string} token @param {any[]} accepted */
  async _creditXp(token, accepted) {
    /** @type {Map<string, {user: string, platform: string, xp: number, messages: number, events: number}>} */
    const perViewer = new Map();
    for (const e of accepted) {
      const cur = perViewer.get(e.userKey) ?? {
        user: e.user,
        platform: e.platform,
        xp: 0,
        messages: 0,
        events: 0,
      };
      if (e.kind) {
        cur.xp += EVENT_XP[/** @type {keyof typeof EVENT_XP} */ (e.kind)];
        cur.events += 1;
      } else {
        cur.xp += XP_PER_MESSAGE;
        cur.messages += 1;
      }
      perViewer.set(e.userKey, cur);
    }
    for (const [userKey, add] of perViewer) {
      const before = await this.viewers.findOneAndUpdate(
        { token, userKey },
        {
          $inc: { xp: add.xp, messages: add.messages, events: add.events },
          $set: {
            displayName: add.user,
            platform: add.platform,
            lastSeenAt: new Date(),
          },
          $setOnInsert: { "oracle.score": 0, "oracle.correct": 0, "oracle.total": 0 },
        },
        { upsert: true, returnDocument: "before" },
      );
      const prevXp = Number(before?.xp) || 0;
      const nextXp = prevXp + add.xp;
      const prevLevel = levelForXp(prevXp);
      const nextLevel = levelForXp(nextXp);
      if (nextLevel > prevLevel) {
        this._emit(token, {
          type: "level-up",
          user: add.user,
          platform: add.platform,
          level: nextLevel,
          rank: rankName(nextLevel),
          xp: nextXp,
        });
      }
    }
  }

  /** @param {string} token @param {any[]} accepted */
  async _recordPicks(token, accepted) {
    const picks = accepted
      .map((e) => ({ e, pick: e.kind ? null : parsePick(e.text) }))
      .filter((p) => p.pick);
    if (picks.length === 0) return;
    const open = await this.predictions.findOne(
      { token, settled: false },
      { sort: { openedAt: -1 } },
    );
    if (!open) return;
    // Voting lock: picks landing after the window closed are ignored.
    // Docs from before ``locksAtMs`` existed lock off their open time
    // so a legacy window can't accept votes forever either.
    if (this.now() > effectiveLocksAtMs(open, this.now())) return;
    /** @type {Record<string, any>} */
    const set = {};
    for (const { e, pick } of picks) {
      set[`picks.${e.userKey.replace(/\./g, "_")}`] = {
        pick,
        user: e.user,
        platform: e.platform,
      };
    }
    await this.predictions.updateOne({ _id: open._id }, { $set: set });
    const now = this.now();
    if (now - (this._lastTallyAt.get(token) ?? 0) >= TALLY_THROTTLE_MS) {
      this._lastTallyAt.set(token, now);
      const doc = await this.predictions.findOne({ _id: open._id });
      this._emit(token, {
        type: "prediction-tally",
        gameKey: doc?.gameKey,
        tally: tallyPicks(doc?.picks),
      });
    }
  }

  /** @param {string} token @param {any[]} accepted */
  async _detectClipSpike(token, accepted) {
    const now = this.now();
    const bucketIdx = Math.floor(now / CLIP_BUCKET_MS);
    let buckets = this._buckets.get(token);
    if (!buckets) {
      buckets = [];
      this._buckets.set(token, buckets);
    }
    // buckets stored as [idx, count, idx, count...] compact pairs.
    const messages = accepted.filter((e) => !e.kind);
    if (messages.length === 0) return;
    if (buckets.length >= 2 && buckets[buckets.length - 2] === bucketIdx) {
      buckets[buckets.length - 1] += messages.length;
    } else {
      buckets.push(bucketIdx, messages.length);
      while (buckets.length > CLIP_WINDOW_BUCKETS * 2) buckets.splice(0, 2);
    }
    const current = buckets[buckets.length - 1];
    const trailing = [];
    for (let i = 0; i < buckets.length - 2; i += 2) trailing.push(buckets[i + 1]);
    if (current < CLIP_MIN_COUNT || trailing.length < 3) return;
    const sorted = [...trailing].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 1;
    if (current < median * CLIP_SPIKE_FACTOR) return;
    if (now - (this._lastClipAt.get(token) ?? 0) < CLIP_COOLDOWN_MS) return;
    this._lastClipAt.set(token, now);
    await this.recordMoment(token, {
      kind: "chat-spike",
      reason: `Chat spiked — ${current} messages in 10s (usual ~${median})`,
      sampleLines: messages
        .slice(-CLIP_SAMPLE_MAX)
        .map((e) => `${e.user}: ${e.text}`.slice(0, TEXT_MAX)),
    });
  }

  /**
   * Persist + broadcast a clip moment (chat spike or game event).
   *
   * @param {string} token
   * @param {{kind: string, reason: string, sampleLines?: string[], gameKey?: string}} m
   */
  async recordMoment(token, m) {
    const doc = {
      token,
      atMs: this.now(),
      atDate: new Date(),
      kind: m.kind === "game-event" ? "game-event" : "chat-spike",
      reason: String(m.reason).slice(0, 160),
      sampleLines: (m.sampleLines ?? []).slice(0, CLIP_SAMPLE_MAX),
      ...(m.gameKey ? { gameKey: String(m.gameKey).slice(0, 120) } : {}),
    };
    await this.clips.insertOne(doc);
    this._emit(token, { type: "clip-moment", moment: { ...doc, _id: undefined } });
  }

  /**
   * Open a prediction window for every active token of this user —
   * called from the live-game envelope hook (match loading/start).
   *
   * @param {string[]} tokens
   * @param {{gameKey: string, opponent?: string}} game
   */
  async openPrediction(tokens, game) {
    if (!game?.gameKey) return;
    for (const token of tokens) {
      const locksAtMs = this.now() + PREDICTION_LOCK_MS;
      const res = await this.predictions.updateOne(
        { token, gameKey: game.gameKey },
        {
          $setOnInsert: {
            token,
            gameKey: game.gameKey,
            opponent: String(game.opponent ?? "").slice(0, 60),
            openedAt: new Date(),
            locksAtMs,
            settled: false,
            picks: {},
          },
        },
        { upsert: true },
      );
      if (res.upsertedCount === 1) {
        this._emit(token, {
          type: "prediction-open",
          gameKey: game.gameKey,
          opponent: String(game.opponent ?? "").slice(0, 60),
          locksAtMs,
        });
      }
    }
  }

  /**
   * Settle every open window for these tokens against the verified
   * result — called from the post-game overlay emit.
   *
   * @param {string[]} tokens
   * @param {{gameKey?: string, result: "win" | "loss"}} game
   */
  async settlePrediction(tokens, game) {
    if (game.result !== "win" && game.result !== "loss") return;
    for (const token of tokens) {
      // Settle the matching window when the gameKey lines up, else the
      // newest open one (envelope/result key drift must not strand it).
      const open =
        (game.gameKey
          ? await this.predictions.findOne({ token, gameKey: game.gameKey, settled: false })
          : null) ??
        (await this.predictions.findOne(
          { token, settled: false },
          { sort: { openedAt: -1 } },
        ));
      if (!open) continue;
      const picks = open.picks ?? {};
      const tally = tallyPicks(picks);
      /** @type {Array<{user: string, platform: string}>} */
      const winners = [];
      for (const key of Object.keys(picks)) {
        const p = picks[key];
        const correct = p.pick === game.result;
        await this.viewers.updateOne(
          { token, userKey: `${p.platform}:${String(p.user).toLowerCase()}` },
          {
            $inc: {
              "oracle.total": 1,
              "oracle.correct": correct ? 1 : 0,
              "oracle.score": correct ? ORACLE_POINTS : 0,
            },
            $set: { displayName: p.user, platform: p.platform, lastSeenAt: new Date() },
            $setOnInsert: { xp: 0, messages: 0, events: 0 },
          },
          { upsert: true },
        );
        if (correct) winners.push({ user: p.user, platform: p.platform });
      }
      await this.predictions.updateOne(
        { _id: open._id },
        { $set: { settled: true, result: game.result, tally, settledAt: new Date() } },
      );
      const topOracles = await this.topOracles(token, 3);
      this._emit(token, {
        type: "prediction-settled",
        gameKey: open.gameKey,
        result: game.result,
        tally,
        correctCount: winners.length,
        pointsEach: ORACLE_POINTS,
        topOracles,
      });
    }
  }

  /**
   * The streamer's own chat identities as ``platform:name`` userKeys.
   * The broadcaster chats in their own channel and earns XP like any
   * viewer, but must never headline their own supporter wall or
   * oracle board — the configured channel/username per platform is
   * who "myself" is. Best-effort: any resolution failure returns no
   * exclusions rather than breaking a summary.
   *
   * @param {string} token
   * @returns {Promise<string[]>}
   */
  async _selfKeys(token) {
    if (!this.users || typeof this.overlayTokens?.resolve !== "function") {
      return [];
    }
    try {
      const owner = await this.overlayTokens.resolve(token);
      if (!owner?.userId) return [];
      const prefs = await this.users.getPreferences(owner.userId, "multichat");
      const keys = [];
      for (const platform of PLATFORMS) {
        const entry = prefs?.[platform];
        if (!entry || typeof entry !== "object") continue;
        for (const field of ["channel", "username"]) {
          const raw = /** @type {Record<string, any>} */ (entry)[field];
          if (typeof raw !== "string") continue;
          const name = raw.trim().replace(/^@/, "").toLowerCase();
          if (name) keys.push(`${platform}:${name}`);
        }
      }
      return keys;
    } catch {
      return [];
    }
  }

  /**
   * @param {string} token
   * @param {number} limit
   * @param {string[]} [excludeKeys] streamer's own userKeys; resolved
   *   via {@link _selfKeys} when not supplied by the caller.
   */
  async topOracles(token, limit, excludeKeys) {
    const exclude = excludeKeys ?? (await this._selfKeys(token));
    /** @type {Record<string, any>} */
    const query = { token, "oracle.total": { $gt: 0 } };
    if (exclude.length > 0) query.userKey = { $nin: exclude };
    const docs = await this.viewers
      .find(
        query,
        { projection: { _id: 0, displayName: 1, platform: 1, oracle: 1 } },
      )
      .sort({ "oracle.score": -1 })
      .limit(limit)
      .toArray();
    return docs.map((d) => ({
      user: d.displayName,
      platform: d.platform,
      score: d.oracle?.score ?? 0,
      correct: d.oracle?.correct ?? 0,
      total: d.oracle?.total ?? 0,
    }));
  }

  /**
   * One viewer's own stats — powers the ``!rank`` chat command. The
   * curve stays server-side so clients never duplicate it; clients
   * theme the numeric level into a unit name by the streamer's race.
   *
   * @param {string} token
   * @param {string} platform
   * @param {string} user
   */
  async viewerStats(token, platform, user) {
    const userKey = `${String(platform)}:${String(user).trim().toLowerCase()}`;
    const doc = await this.viewers.findOne(
      { token, userKey },
      { projection: { _id: 0, displayName: 1, xp: 1, messages: 1, oracle: 1 } },
    );
    const xp = Number(doc?.xp) || 0;
    const level = levelForXp(xp);
    const atTop = level >= RANK_NAMES.length - 1;
    return {
      user: doc?.displayName ?? String(user),
      found: Boolean(doc),
      xp,
      level,
      nextLevel: atTop ? null : level + 1,
      xpToNext: atTop ? null : Math.max(0, xpForLevel(level + 1) - xp),
      messages: Number(doc?.messages) || 0,
      oracleScore: Number(doc?.oracle?.score) || 0,
    };
  }

  /**
   * Widget boot summary: supporter wall, oracle board, open window,
   * recent clip moments.
   *
   * @param {string} token
   */
  async summary(token) {
    // The streamer never ranks on their own boards (wall + oracles).
    const selfKeys = await this._selfKeys(token);
    /** @type {Record<string, any>} */
    const wallQuery = { token };
    if (selfKeys.length > 0) wallQuery.userKey = { $nin: selfKeys };
    const [topViewers, topOracles, open, moments, settled] = await Promise.all([
      this.viewers
        .find(
          wallQuery,
          { projection: { _id: 0, displayName: 1, platform: 1, xp: 1, messages: 1, events: 1 } },
        )
        .sort({ xp: -1 })
        .limit(5)
        .toArray(),
      this.topOracles(token, 5, selfKeys),
      this.predictions.findOne(
        { token, settled: false },
        { sort: { openedAt: -1 }, projection: { _id: 0, gameKey: 1, opponent: 1, picks: 1, openedAt: 1, locksAtMs: 1 } },
      ),
      this.clips
        .find({ token }, { projection: { _id: 0, token: 0, atDate: 0 } })
        .sort({ atMs: -1 })
        .limit(20)
        .toArray(),
      this.predictions
        .find(
          { token, settled: true },
          { projection: { _id: 0, opponent: 1, result: 1, tally: 1, settledAt: 1 } },
        )
        .sort({ settledAt: -1 })
        .limit(30)
        .toArray(),
    ]);
    // Chat's collective crystal-ball record: how often the majority
    // call matched the verified result (ties and empty windows skip).
    let calls = 0;
    let majorityRight = 0;
    /** @type {{opponent: string, result: string, pct: number, majority: 'win'|'loss', wasRight: boolean} | null} */
    let lastCall = null;
    for (const p of settled) {
      const t = p.tally ?? { win: 0, loss: 0, total: 0 };
      if (!t.total || t.win === t.loss) continue;
      const majority = t.win > t.loss ? "win" : "loss";
      const wasRight = majority === p.result;
      calls += 1;
      if (wasRight) majorityRight += 1;
      if (!lastCall) {
        lastCall = {
          opponent: String(p.opponent ?? ""),
          result: String(p.result ?? ""),
          pct: Math.round((Math.max(t.win, t.loss) / t.total) * 100),
          majority,
          wasRight,
        };
      }
    }
    return {
      wall: topViewers.map((v) => ({
        user: v.displayName,
        platform: v.platform,
        xp: v.xp ?? 0,
        level: levelForXp(v.xp ?? 0),
        rank: rankName(levelForXp(v.xp ?? 0)),
      })),
      oracles: topOracles,
      prediction: open && !isStalePrediction(open, this.now())
        ? {
            gameKey: open.gameKey,
            opponent: open.opponent,
            tally: tallyPicks(open.picks),
            // Always resolved — legacy docs without the field lock off
            // their open time, so widgets can ALWAYS take the prompt
            // down instead of treating "unknown" as "open forever".
            locksAtMs: effectiveLocksAtMs(open, this.now()),
          }
        : null,
      oracleRecap: { calls, majorityRight, last: lastCall },
      clipMoments: moments,
    };
  }
}

/** @param {Record<string, any>} doc @returns {number|null} */
function openedAtMs(doc) {
  const d =
    doc.openedAt instanceof Date
      ? doc.openedAt.getTime()
      : new Date(doc.openedAt).getTime();
  return Number.isFinite(d) ? d : null;
}

/**
 * When voting closes for a window. Docs written before ``locksAtMs``
 * existed lock off their open time; a doc with no usable open time
 * locks immediately — "unknown" must never mean "open forever".
 *
 * @param {Record<string, any>} doc
 * @param {number} nowMs
 * @returns {number}
 */
function effectiveLocksAtMs(doc, nowMs) {
  if (Number.isFinite(doc.locksAtMs)) return Number(doc.locksAtMs);
  const opened = openedAtMs(doc);
  return opened !== null ? opened + PREDICTION_LOCK_MS : nowMs;
}

/**
 * An open window whose game never produced a result (abandoned game,
 * agent offline at the end) — old enough that it should no longer be
 * surfaced as "the open prediction".
 *
 * @param {Record<string, any>} doc
 * @param {number} nowMs
 * @returns {boolean}
 */
function isStalePrediction(doc, nowMs) {
  const opened = openedAtMs(doc);
  return opened !== null && nowMs - opened > PREDICTION_STALE_MS;
}

/** @param {Record<string, {pick: string}> | undefined} picks */
function tallyPicks(picks) {
  let win = 0;
  let loss = 0;
  for (const key of Object.keys(picks ?? {})) {
    if (/** @type {any} */ (picks)[key].pick === "win") win += 1;
    else loss += 1;
  }
  return { win, loss, total: win + loss };
}

module.exports = {
  MultichatEngagementService,
  xpForLevel,
  levelForXp,
  rankName,
  parsePick,
  RANK_NAMES,
  PREDICTION_LOCK_MS,
  PREDICTION_STALE_MS,
};
