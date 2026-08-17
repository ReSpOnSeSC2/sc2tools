"use strict";

/**
 * MultichatStudioService — live "stream studio" state for the
 * multichat overlay family: the pinned chat highlight, the active
 * chat poll, the stream goals, the studio blocklist, and the
 * session-recap trigger, and the BRB / Starting Soon b-roll playlist.
 *
 * State is per overlay TOKEN (the dock and every Browser Source of a
 * token share one studio), persisted in Mongo so an OBS restart or
 * API deploy never loses a running poll, and broadcast over the
 * token's existing socket room as ``overlay:multichat`` so the dock's
 * actions land on stream instantly.
 *
 * Everything stored here is strict-sanitized on write — the dock is
 * token-authed (the token IS the bearer, same threat model as the
 * overlay socket), so hostile input must not be able to persist
 * anything the widgets wouldn't render safely.
 */

const POLL_MAX_OPTIONS = 6;
const POLL_MAX_TEXT = 120;
const GOALS_MAX = 4;
const GOAL_MAX_LABEL = 40;
const HIGHLIGHT_MAX_TEXT = 500;
const BLOCKLIST_MAX = 50;
const BROLL_MAX_CLIPS = 100;
const BROLL_CLIP_ID_MAX = 64;
const BROLL_TITLE_MAX = 120;
const BROLL_TIMESTAMP_MAX_SECONDS = 24 * 60 * 60;
const BROLL_SKIP_NONCE_MAX = 2_147_483_647;
const BROLL_PLAYBACK_REVISION_MAX = 2_147_483_647;
const BROLL_WRITE_REVISION_MAX = 2_147_483_647;
const BROLL_PLAYBACK_EPOCH_MAX = 8_640_000_000_000_000;
const BROLL_WRITE_MAX_ATTEMPTS = 5;
const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const BROLL_CLIP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const DEFAULT_BROLL = Object.freeze({
  clips: Object.freeze([]),
  shuffle: true,
  muted: false,
  volume: 20,
  skipNonce: 0,
  playback: Object.freeze({
    epochMs: 0,
    revision: 0,
    seed: 0,
    cursor: 0,
  }),
});

class MultichatStudioService {
  /**
   * @param {{ multichatStudio: import('mongodb').Collection }} db
   * @param {{ io?: import('socket.io').Server }} [deps]
   */
  constructor(db, deps = {}) {
    this.col = db.multichatStudio;
    this.io = deps.io || null;
    /** Serialize same-token b-roll writes inside this API process. */
    this.brollUpdateQueues = new Map();
  }

  /**
   * Prefer the lazily-canonicalized row while retaining compatibility with
   * legacy documents that only carried `token`.
   *
   * @param {string} token
   * @param {import('mongodb').FindOptions} [options]
   */
  async _findDocument(token, options = {}) {
    const canonical = await this.col.findOne({ studioKey: token }, options);
    // The exact filter is authoritative even when the caller's projection
    // intentionally removes `studioKey` from the returned document.
    if (canonical) return canonical;
    return this.col.findOne({ token }, options);
  }

  /**
   * Current studio state for a token. Absent doc → empty defaults so
   * widgets can boot unconditionally.
   *
   * @param {string} token
   */
  async get(token) {
    const doc = await this._findDocument(
      token,
      { projection: { _id: 0, token: 0, studioKey: 0 } },
    );
    return {
      highlight: doc?.highlight ?? null,
      poll: doc?.poll ?? null,
      goals: Array.isArray(doc?.goals) ? doc.goals : [],
      blockedUsers: Array.isArray(doc?.blockedUsers) ? doc.blockedUsers : [],
      recapSeq: Number(doc?.recapSeq) || 0,
      scene: doc?.scene ?? null,
      timer: doc?.timer ?? null,
      // Sanitize on read as well as write. This gives documents created
      // before b-roll existed stable defaults and prevents a hand-edited or
      // legacy Mongo row from reaching an OBS Browser Source unsanitized.
      broll: sanitizeBroll(doc?.broll),
      streamStartMs: Number.isFinite(doc?.streamStartMs)
        ? Number(doc?.streamStartMs)
        : null,
      vodUrl: typeof doc?.vodUrl === "string" ? doc.vodUrl : null,
      updatedAt: doc?.updatedAt ?? null,
    };
  }

  /**
   * Apply a partial update ({highlight} | {poll} | {goals} | {broll} |
   * {blockedUsers} | {recap:true}) — sanitized, persisted, broadcast.
   *
   * @param {string} token
   * @param {Record<string, unknown>} patch
   */
  async update(token, patch) {
    if (!("broll" in patch)) return this._updateUnlocked(token, patch);

    // Dock controls send small b-roll patches. Serializing them prevents a
    // slow volume save and a Skip click from both reading the same anchor and
    // letting the last response restore stale playback metadata.
    const previous = this.brollUpdateQueues.get(token) || Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() => this._updateUnlocked(token, patch));
    this.brollUpdateQueues.set(token, run);
    try {
      return await run;
    } finally {
      if (this.brollUpdateQueues.get(token) === run) {
        this.brollUpdateQueues.delete(token);
      }
    }
  }

  /**
   * @param {string} token
   * @param {Record<string, unknown>} patch
   * @param {number} [attempt]
   * @returns {Promise<Record<string, any>>}
   */
  async _updateUnlocked(token, patch, attempt = 0) {
    // B-roll playback metadata is a server-owned timeline. Read the prior
    // anchor before applying a Dock update so volume/mute changes preserve the
    // current reel, while library/shuffle/skip changes create one new anchor
    // that every horizontal and vertical Browser Source receives together.
    const previousDocument = await this._findDocument(token);
    const previousBroll = sanitizeBroll(previousDocument?.broll);
    const previousWriteRevision = sanitizeBrollWriteRevision(
      previousDocument?.brollWriteRevision,
    );
    /** @type {Record<string, any>} */
    const set = { updatedAt: new Date(), studioKey: token };
    /** @type {Record<string, any>} */
    const inc = {};
    if ("highlight" in patch) {
      set.highlight = sanitizeHighlight(patch.highlight);
    }
    if ("poll" in patch) {
      set.poll = sanitizePoll(patch.poll);
    }
    if ("goals" in patch) {
      set.goals = sanitizeGoals(patch.goals);
    }
    if ("blockedUsers" in patch) {
      set.blockedUsers = sanitizeBlockedUsers(patch.blockedUsers);
    }
    if ("scene" in patch) {
      set.scene = sanitizeScene(patch.scene);
    }
    if ("timer" in patch) {
      set.timer = sanitizeTimer(patch.timer);
    }
    if ("broll" in patch) {
      set.broll = prepareBrollUpdate(
        patch.broll,
        previousBroll,
        Date.now(),
      );
      set.brollWriteRevision = nextBrollWriteRevision(previousWriteRevision);
    }
    if ("streamStartMs" in patch) {
      set.streamStartMs = sanitizeStreamStartMs(patch.streamStartMs);
    }
    if ("vodUrl" in patch) {
      set.vodUrl = sanitizeVodUrl(patch.vodUrl);
    }
    if (patch.recap === true) {
      inc.recapSeq = 1;
    }
    /** @type {Record<string, any>} */
    const updateDoc = { $set: set, $setOnInsert: { token } };
    if (Object.keys(inc).length > 0) updateDoc.$inc = inc;
    if ("broll" in patch) {
      const written = await this._writeBrollCompareAndSwap(
        token,
        updateDoc,
        previousWriteRevision,
        studioDocumentFilter(token, previousDocument),
      );
      if (!written) {
        if (attempt + 1 >= BROLL_WRITE_MAX_ATTEMPTS) {
          const error = new Error("Concurrent b-roll update did not settle");
          // @ts-ignore structured code for route/error logging.
          error.code = "broll_conflict";
          throw error;
        }
        return this._updateUnlocked(token, patch, attempt + 1);
      }
    } else {
      const filter = studioDocumentFilter(token, previousDocument);
      try {
        await this.col.updateOne(filter, updateDoc, {
          upsert: previousDocument === null,
        });
      } catch (error) {
        // Two workers may try to promote different duplicate legacy rows.
        // The sparse canonical key picks one; replay this field-level patch on
        // the winner without deleting either legacy document at startup.
        if (!isDuplicateKeyError(error)) throw error;
        await this.col.updateOne(
          { studioKey: token },
          updateDoc,
          { upsert: false },
        );
      }
    }
    const state = await this.get(token);
    if (this.io) {
      this.io.to(`overlay:${token}`).emit("overlay:multichat", state);
    }
    return state;
  }

  /**
   * Persist against the internal write revision read above. Unlike the public
   * playback revision, this advances for volume and mute changes too. The
   * in-process queue handles ordinary UI overlap; this Mongo compare-and-swap
   * prevents a second API worker from overwriting any newer control. A false
   * result asks the caller to re-read, re-merge the partial patch, and retry.
   *
   * @param {string} token
   * @param {Record<string, any>} updateDoc
   * @param {number} previousWriteRevision
   * @param {Record<string, any>} identityFilter
   */
  async _writeBrollCompareAndSwap(
    token,
    updateDoc,
    previousWriteRevision,
    identityFilter,
  ) {
    const filter = previousWriteRevision === 0
      ? {
          ...identityFilter,
          $or: [
            { brollWriteRevision: 0 },
            { brollWriteRevision: { $exists: false } },
          ],
        }
      : { ...identityFilter, brollWriteRevision: previousWriteRevision };
    let result;
    try {
      result = await this.col.updateOne(filter, updateDoc, { upsert: false });
    } catch (error) {
      if (isDuplicateKeyError(error)) return false;
      throw error;
    }

    // Lightweight unit fakes written before CAS return no Mongo result. Their
    // write already happened, so preserve that test-double contract.
    if (!result || typeof result.matchedCount !== "number") return true;
    if (result.matchedCount > 0 || Number(result.modifiedCount) > 0) return true;

    const existing = await this._findDocument(
      token,
      { projection: { _id: 1 } },
    );
    if (existing) return false;

    try {
      const inserted = await this.col.updateOne(
        {
          studioKey: token,
          // With the sparse canonical-key index this is an atomic insert-only
          // guard that does not require deleting duplicate legacy rows:
          // if another worker created any b-roll state after our read,
          // this filter cannot match it and the attempted upsert raises 11000.
          brollWriteRevision: { $exists: false },
        },
        updateDoc,
        { upsert: true },
      );
      return !inserted ||
        typeof inserted.upsertedCount !== "number" ||
        inserted.upsertedCount > 0 ||
        inserted.matchedCount > 0;
    } catch (error) {
      // Another worker won the first-insert race. Re-read its revision.
      if (isDuplicateKeyError(error)) return false;
      throw error;
    }
  }
}

/** @param {string} token @param {Record<string, any> | null} document */
function studioDocumentFilter(token, document) {
  if (!document) return { studioKey: token };
  if (document._id !== undefined) return { _id: document._id };
  if (document.studioKey === token) return { studioKey: token };
  return { token };
}

/** @param {unknown} error */
function isDuplicateKeyError(error) {
  return Number((/** @type {{ code?: unknown }} */ (error))?.code) === 11000;
}

/** @param {unknown} raw */
function sanitizeHighlight(raw) {
  if (!raw || typeof raw !== "object") return null;
  const h = /** @type {Record<string, any>} */ (raw);
  const text = String(h.text ?? "").trim().slice(0, HIGHLIGHT_MAX_TEXT);
  const user = String(h.user ?? "").trim().slice(0, 60);
  if (!text || !user) return null;
  const platform = ["twitch", "kick", "youtube", "tiktok"].includes(h.platform)
    ? h.platform
    : "twitch";
  return { platform, user, text, atMs: Date.now() };
}

/** @param {unknown} raw */
function sanitizePoll(raw) {
  if (!raw || typeof raw !== "object") return null;
  const p = /** @type {Record<string, any>} */ (raw);
  const question = String(p.question ?? "").trim().slice(0, POLL_MAX_TEXT);
  const options = (Array.isArray(p.options) ? p.options : [])
    .map((o) => String(o ?? "").trim().slice(0, POLL_MAX_TEXT))
    .filter(Boolean)
    .slice(0, POLL_MAX_OPTIONS);
  if (!question || options.length < 2) return null;
  /** @type {Record<string, any>} */
  const out = {
    question,
    options,
    startedAtMs: Number.isFinite(Number(p.startedAtMs))
      ? Number(p.startedAtMs)
      : Date.now(),
    // "open" collects votes; "closed" shows final results until cleared.
    status: p.status === "closed" ? "closed" : "open",
  };
  // Optional structured meta — currently only the build vote, which
  // lets the widget show the winner's real win-rate on close.
  if (p.meta && typeof p.meta === "object" && p.meta.kind === "build") {
    /** @type {Record<string, number>} */
    const winRates = {};
    const rawRates =
      p.meta.winRates && typeof p.meta.winRates === "object"
        ? p.meta.winRates
        : {};
    for (const name of options) {
      const v = Number(rawRates[name]);
      if (Number.isFinite(v)) winRates[name] = Math.min(100, Math.max(0, Math.round(v)));
    }
    out.meta = { kind: "build", winRates };
  }
  return out;
}

/** @param {unknown} raw */
function sanitizeGoals(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {Array<Record<string, any>>} */
  const out = [];
  for (const g of raw.slice(0, GOALS_MAX)) {
    if (!g || typeof g !== "object") continue;
    const label = String(g.label ?? "").trim().slice(0, GOAL_MAX_LABEL);
    const current = Math.max(0, Math.round(Number(g.current) || 0));
    const target = Math.max(1, Math.round(Number(g.target) || 0));
    if (!label) continue;
    out.push({ label, current, target });
  }
  return out;
}

const SCENE_MODES = ["brb", "starting"];
const SCENE_MESSAGE_MAX = 80;
/** Countdown targets clamp to now+24h — a fat-fingered year-long
 * countdown shouldn't persist. */
const SCENE_COUNTDOWN_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * Scene state for the full-screen BRB / Starting Soon widget.
 * ``null`` (mode "none" or junk) means live — the widget renders
 * transparent.
 *
 * @param {unknown} raw
 */
function sanitizeScene(raw) {
  if (!raw || typeof raw !== "object") return null;
  const s = /** @type {Record<string, any>} */ (raw);
  if (!SCENE_MODES.includes(s.mode)) return null;
  const message = String(s.message ?? "").trim().slice(0, SCENE_MESSAGE_MAX);
  const ends = Number(s.countdownEndsAt);
  const now = Date.now();
  const countdownEndsAt =
    Number.isFinite(ends) && ends > now
      ? Math.min(ends, now + SCENE_COUNTDOWN_MAX_MS)
      : null;
  return { mode: s.mode, message, countdownEndsAt, setAtMs: now };
}

const TIMER_LABEL_MAX = 40;

/**
 * Standalone on-stream countdown (the countdown-timer widget) —
 * independent of the BRB/Starting Soon scene. ``null`` hides it.
 * ``endsAt`` must be in the future (clamped to +24 h); a finished
 * timer stays at 00:00 on stream until cleared from the dock.
 *
 * @param {unknown} raw
 */
function sanitizeTimer(raw) {
  if (!raw || typeof raw !== "object") return null;
  const t = /** @type {Record<string, any>} */ (raw);
  const ends = Number(t.endsAt);
  const now = Date.now();
  if (!Number.isFinite(ends) || ends <= now) return null;
  return {
    label: String(t.label ?? "").trim().slice(0, TIMER_LABEL_MAX),
    endsAt: Math.min(ends, now + SCENE_COUNTDOWN_MAX_MS),
    setAtMs: now,
  };
}

/**
 * Persisted YouTube b-roll playlist and player controls shared by the Stream
 * Dock and full-screen scene widget. Only exact YouTube video IDs and bounded
 * segment timestamps survive; remote URLs and arbitrary embed parameters are
 * deliberately not accepted. ``null``/junk resets to defaults.
 *
 * Volume is the same 0..100 integer convention as the other multichat audio
 * controls. ``skipNonce`` is a bounded counter: changing it lets the dock ask
 * every connected player to advance without adding another socket event.
 *
 * @param {unknown} raw
 * @returns {{clips: Array<{id: string, title: string, videoId: string, startSeconds: number, endSeconds: number}>, shuffle: boolean, muted: boolean, volume: number, skipNonce: number, playback: {epochMs: number, revision: number, seed: number, cursor: number}}}
 */
function sanitizeBroll(raw) {
  const b = /** @type {Record<string, unknown>} */ (
    raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
  );
  /** @type {Array<{id: string, title: string, videoId: string, startSeconds: number, endSeconds: number}>} */
  const clips = [];
  const seenIds = new Set();
  const candidates = Array.isArray(b.clips) ? b.clips : [];

  for (const candidate of candidates) {
    const sanitized = sanitizeBrollClip(candidate, seenIds);
    if (!sanitized) continue;
    clips.push(sanitized);
    seenIds.add(sanitized.id);
    if (clips.length >= BROLL_MAX_CLIPS) break;
  }

  const volumeRaw = b.volume;
  const skipNonceRaw = b.skipNonce;
  const playback = sanitizeBrollPlayback(b.playback, clips.length);
  return {
    clips,
    shuffle:
      typeof b.shuffle === "boolean" ? b.shuffle : DEFAULT_BROLL.shuffle,
    muted: typeof b.muted === "boolean" ? b.muted : DEFAULT_BROLL.muted,
    volume:
      typeof volumeRaw === "number" && Number.isFinite(volumeRaw)
        ? Math.min(100, Math.max(0, Math.round(volumeRaw)))
        : DEFAULT_BROLL.volume,
    skipNonce:
      typeof skipNonceRaw === "number" && Number.isFinite(skipNonceRaw)
        ? Math.min(
            BROLL_SKIP_NONCE_MAX,
            Math.max(0, Math.floor(skipNonceRaw)),
          )
        : DEFAULT_BROLL.skipNonce,
    playback,
  };
}

/**
 * Convert a Dock library/control write into one authoritative playback anchor.
 * Incoming playback fields are deliberately ignored: Browser Sources may read
 * the timeline, but only the server decides when it changes.
 *
 * ``cursor`` is a position in the deterministic playlist order (not a clip
 * array index). The wall-clock epoch plus clip durations carries automatic
 * handoffs without requiring either OBS copy to publish player events.
 *
 * @param {unknown} raw
 * @param {unknown} previousRaw
 * @param {number} nowMs
 */
function prepareBrollUpdate(raw, previousRaw, nowMs = Date.now()) {
  const previous = sanitizeBroll(previousRaw);
  const incoming = /** @type {Record<string, unknown>} */ (
    raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
  );
  // Treat writes as partial control patches. This is backward compatible with
  // older Docks that posted the full config, while preventing an unrelated
  // volume/mute write from restoring a stale library or skip nonce. Incoming
  // playback is always ignored because only the server owns that protocol.
  const next = raw === null
    ? sanitizeBroll(null)
    : sanitizeBroll({
        ...previous,
        ...incoming,
        playback: previous.playback,
      });
  const libraryChanged = brollLibrarySignature(next.clips) !==
    brollLibrarySignature(previous.clips);
  const shuffleChanged = next.shuffle !== previous.shuffle;
  const skipChanged = next.skipNonce !== previous.skipNonce;

  if (!libraryChanged && !shuffleChanged && !skipChanged) {
    next.playback = { ...previous.playback };
    return next;
  }

  const revision = nextBrollRevision(previous.playback.revision);
  if (next.clips.length === 0) {
    next.playback = { epochMs: 0, revision, seed: 0, cursor: 0 };
    return next;
  }

  if (libraryChanged || shuffleChanged) {
    next.playback = {
      epochMs: sanitizeBrollEpoch(nowMs),
      revision,
      seed: nextBrollSeed(
        previous.playback.seed,
        revision,
        nowMs,
        brollLibrarySignature(next.clips),
      ),
      cursor: 0,
    };
    return next;
  }

  // A skip advances from the clip that should be on screen *now*, not merely
  // from the original persisted cursor. Otherwise a skip after several
  // automatic handoffs could jump backwards in the reel.
  const currentCursor = resolveBrollCursor(previous, nowMs);
  next.playback = {
    epochMs: sanitizeBrollEpoch(nowMs),
    revision,
    seed: previous.playback.seed,
    cursor: (currentCursor + 1) % next.clips.length,
  };
  return next;
}

/** @param {unknown} raw @param {number} clipCount */
function sanitizeBrollPlayback(raw, clipCount) {
  const playback = /** @type {Record<string, unknown>} */ (
    raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
  );
  const epochMs = sanitizeBrollEpoch(playback.epochMs);
  const revisionRaw = Number(playback.revision);
  const seedRaw = Number(playback.seed);
  const cursorRaw = Number(playback.cursor);
  return {
    epochMs,
    revision: Number.isFinite(revisionRaw)
      ? Math.min(
          BROLL_PLAYBACK_REVISION_MAX,
          Math.max(0, Math.floor(revisionRaw)),
        )
      : 0,
    seed: Number.isFinite(seedRaw)
      ? Math.floor(seedRaw) >>> 0
      : 0,
    cursor:
      clipCount > 0 && Number.isFinite(cursorRaw)
        ? Math.max(0, Math.floor(cursorRaw)) % clipCount
        : 0,
  };
}

/** @param {unknown} raw */
function sanitizeBrollEpoch(raw) {
  const epoch = Number(raw);
  return Number.isFinite(epoch) && epoch >= 0
    ? Math.min(BROLL_PLAYBACK_EPOCH_MAX, Math.round(epoch))
    : 0;
}

/** @param {number} previous */
function nextBrollRevision(previous) {
  return previous >= BROLL_PLAYBACK_REVISION_MAX ? 1 : previous + 1;
}

/** @param {unknown} raw */
function sanitizeBrollWriteRevision(raw) {
  const revision = Number(raw);
  return Number.isFinite(revision)
    ? Math.min(BROLL_WRITE_REVISION_MAX, Math.max(0, Math.floor(revision)))
    : 0;
}

/** @param {number} previous */
function nextBrollWriteRevision(previous) {
  return previous >= BROLL_WRITE_REVISION_MAX ? 1 : previous + 1;
}

/**
 * Small stable 32-bit hash. This is a playback coordination seed, not a
 * security token; incorporating the server epoch gives each reset a new but
 * fully shared shuffle order.
 */
function nextBrollSeed(
  /** @type {number} */ previousSeed,
  /** @type {number} */ revision,
  /** @type {number} */ nowMs,
  /** @type {string} */ signature,
) {
  let hash = 0x811c9dc5;
  const input = `${previousSeed >>> 0}|${revision}|${Math.round(nowMs)}|${signature}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** @param {Array<{id: string, videoId: string, startSeconds: number, endSeconds: number}>} clips */
function brollLibrarySignature(clips) {
  return clips
    .map((clip) => `${clip.id}:${clip.videoId}:${clip.startSeconds}:${clip.endSeconds}`)
    .join("\u001f");
}

/**
 * Mirror of the web player's timeline order. Keep this protocol-level helper
 * in lockstep with ``createBrollPlaybackOrder`` so a server-side skip lands on
 * the same next clip both independent players would derive.
 */
function createBrollPlaybackOrder(
  /** @type {number} */ clipCount,
  /** @type {boolean} */ shuffle,
  /** @type {number} */ seed,
) {
  const order = Array.from({ length: clipCount }, (_, index) => index);
  if (!shuffle || clipCount < 2) return order;
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  for (let index = order.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [order[index], order[swap]] = [order[swap], order[index]];
  }
  return order;
}

/** @param {ReturnType<typeof sanitizeBroll>} broll @param {number} nowMs */
function resolveBrollCursor(broll, nowMs) {
  const count = broll.clips.length;
  if (count === 0) return 0;
  const order = createBrollPlaybackOrder(
    count,
    broll.shuffle,
    broll.playback.seed,
  );
  let cursor = broll.playback.cursor % count;
  const totalMs = broll.clips.reduce(
    (sum, clip) => sum + (clip.endSeconds - clip.startSeconds) * 1000,
    0,
  );
  let elapsedMs = Math.max(0, Number(nowMs) - broll.playback.epochMs);
  if (totalMs > 0) elapsedMs %= totalMs;
  for (let step = 0; step < count; step += 1) {
    const clip = broll.clips[order[cursor]];
    const durationMs = (clip.endSeconds - clip.startSeconds) * 1000;
    if (elapsedMs < durationMs) return cursor;
    elapsedMs -= durationMs;
    cursor = (cursor + 1) % count;
  }
  return cursor;
}

/**
 * @param {unknown} raw
 * @param {Set<string>} seenIds
 * @returns {{id: string, title: string, videoId: string, startSeconds: number, endSeconds: number} | null}
 */
function sanitizeBrollClip(raw, seenIds) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const clip = /** @type {Record<string, unknown>} */ (raw);
  const id = typeof clip.id === "string" ? clip.id.trim() : "";
  const title =
    typeof clip.title === "string"
      ? clip.title.trim().slice(0, BROLL_TITLE_MAX)
      : "";
  const videoId =
    typeof clip.videoId === "string" ? clip.videoId.trim() : "";
  const startRaw = clip.startSeconds;
  const endRaw = clip.endSeconds;
  if (
    !BROLL_CLIP_ID_RE.test(id) ||
    id.length > BROLL_CLIP_ID_MAX ||
    seenIds.has(id) ||
    !title ||
    !YOUTUBE_VIDEO_ID_RE.test(videoId) ||
    typeof startRaw !== "number" ||
    !Number.isFinite(startRaw) ||
    typeof endRaw !== "number" ||
    !Number.isFinite(endRaw)
  ) {
    return null;
  }
  const startSeconds = Math.floor(startRaw);
  const endSeconds = Math.floor(endRaw);
  if (
    startSeconds < 0 ||
    endSeconds <= startSeconds ||
    endSeconds > BROLL_TIMESTAMP_MAX_SECONDS
  ) {
    return null;
  }
  return { id, title, videoId, startSeconds, endSeconds };
}

/**
 * Stream-start marker (wall-clock ms) for the clip log's VOD-offset
 * math. Bounded to [now − 48h, now + 5min] — a marathon stream fits,
 * while garbage epochs (0, far-future) that would produce nonsense
 * offsets sanitize to null. null clears the marker.
 *
 * @param {unknown} raw
 * @returns {number | null}
 */
function sanitizeStreamStartMs(raw) {
  const ms = Number(raw);
  if (!Number.isFinite(ms)) return null;
  const now = Date.now();
  if (ms < now - 48 * 60 * 60 * 1000 || ms > now + 5 * 60 * 1000) return null;
  return Math.round(ms);
}

/**
 * VOD URL for clickable clip-moment links. https only, bounded, and
 * must parse — the dock renders it as an anchor href, so nothing
 * script-shaped may survive. null/junk clears.
 *
 * @param {unknown} raw
 * @returns {string | null}
 */
function sanitizeVodUrl(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().slice(0, 300);
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** @param {unknown} raw */
function sanitizeBlockedUsers(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {string[]} */
  const out = [];
  for (const u of raw) {
    const name = String(u ?? "").trim().toLowerCase().replace(/^@/, "").slice(0, 60);
    if (name && !out.includes(name)) out.push(name);
    if (out.length >= BLOCKLIST_MAX) break;
  }
  return out;
}

module.exports = {
  MultichatStudioService,
  sanitizeHighlight,
  sanitizePoll,
  sanitizeGoals,
  sanitizeBlockedUsers,
  sanitizeScene,
  sanitizeTimer,
  sanitizeBroll,
  prepareBrollUpdate,
  createBrollPlaybackOrder,
  resolveBrollCursor,
  sanitizeStreamStartMs,
  sanitizeVodUrl,
  DEFAULT_BROLL,
};
