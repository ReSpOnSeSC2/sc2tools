"use strict";

/**
 * TikTok live-chat relay for the multichat overlay widget.
 *
 * TikTok Live has no public chat API and its webcast WebSocket needs
 * signed URLs, so the browser can't connect directly. This relay owns
 * one upstream TikTok connection per (streamer username) — via
 * `tiktok-live-connector`, which reads chat with NOTHING but the
 * @username: no stream key, no login, no TikTok API credentials — and
 * fans the messages out to however many overlay subscribers (OBS
 * scenes, preview tabs) are attached.
 *
 * Lifecycle contract:
 *   - `subscribe(username, listener)` returns an unsubscribe fn. The
 *     first subscriber spins the upstream connection up; the last one
 *     leaving tears it down. Listeners immediately receive the current
 *     status so a late-joining Browser Source renders honestly.
 *   - While at least one subscriber is attached and the streamer is
 *     NOT live, the relay retries on a slow timer — the widget can sit
 *     in an OBS scene all day and light up when the stream starts.
 *   - Global + per-user caps bound the fan-in so a leaked token can't
 *     turn the API into a TikTok-scraping botnet.
 *
 * Events pushed to listeners (also the SSE wire shape):
 *   { type: "status", state: "connecting"|"connected"|"offline"|
 *     "ended"|"error", detail? }
 *   { type: "chat", message: { id, user, text, badges, atMs },
 *     session?, replay? }
 *   { type: "event", event: { id, kind, user, detail, amount?, atMs } }
 *
 * The connector library is loaded lazily via dynamic import (it is
 * ESM-only) and injected in tests — unit tests never touch TikTok.
 */

/** Retry cadence while the streamer is offline / after an error. */
const OFFLINE_RETRY_MS = 60 * 1000;
/** Retry cadence after an unexpected disconnect mid-stream. */
const DISCONNECT_RETRY_MS = 10 * 1000;

const DEFAULT_MAX_CHANNELS = 16;
/** Bound replay de-duplication for one long-lived channel. */
const MAX_SEEN_CHAT_IDS = 512;
/**
 * Recent chat retained for subscribers that join an already-connected
 * channel. A single upstream is shared by the Dock and several OBS
 * widgets; without a small backlog, whichever surface attaches first
 * consumes TikTok's startup batch and every later surface turns green
 * with an empty feed until the next brand-new comment.
 */
const MAX_RECENT_CHAT_EVENTS = 50;
/**
 * Recent normalized events retained so a chat widget joining the shared
 * upstream after the alert widget sees the same follows/gifts/subscriptions.
 * Replays are explicitly marked; alert surfaces suppress replayed toasts and
 * sounds while timeline surfaces still show the recognition row.
 */
const MAX_RECENT_PLATFORM_EVENTS = 50;
const TIKTOK_CONNECTION_OPTIONS = Object.freeze({
  // TikTok returns a small recent-comment batch during connect. Keeping
  // it is important when an OBS source starts after chat has begun; the
  // Channel de-duplicates comments that the websocket repeats.
  processInitialData: true,
  // Supplies each gift's diamond cost so recognition can show the
  // streamer's actual diamond total instead of only the combo count.
  enableExtendedGiftInfo: true,
});

/** @typedef {(event: Record<string, any>) => void} RelayListener */

class TikTokChatRelay {
  /**
   * @param {{
   *   maxChannels?: number,
   *   connectionFactory?: (username: string) => Promise<any>,
   *   log?: { info: Function, warn: Function },
   * }} [opts]
   */
  constructor(opts = {}) {
    this.maxChannels = opts.maxChannels || DEFAULT_MAX_CHANNELS;
    this.connectionFactory =
      opts.connectionFactory || defaultConnectionFactory;
    this.log = opts.log || null;
    /** @type {Map<string, Channel>} */
    this.channels = new Map();
  }

  /**
   * Attach a listener to a username's chat. Throws
   * `relay_at_capacity` when the global cap is hit.
   *
   * @param {string} rawUsername
   * @param {RelayListener} listener
   * @returns {() => void} unsubscribe
   */
  subscribe(rawUsername, listener) {
    const username = normalizeTikTokUsername(rawUsername);
    let channel = this.channels.get(username);
    if (!channel) {
      if (this.channels.size >= this.maxChannels) {
        const err = new Error("tiktok relay at capacity");
        // @ts-ignore structured code for the route layer
        err.code = "relay_at_capacity";
        throw err;
      }
      channel = new Channel(username, this.connectionFactory, this.log);
      this.channels.set(username, channel);
      channel.start();
    }
    channel.listeners.set(listener, new Set());
    // Late joiners see the current state and the same recent chat/events that
    // earlier surfaces received. Event replays are wire-marked so timeline
    // surfaces catch up without firing a second toast or sound.
    channel.deliver(listener, { type: "status", state: channel.state });
    if (channel.state === "connected") {
      channel.replayRecent(listener);
    }
    return () => {
      channel.listeners.delete(listener);
      if (channel.listeners.size === 0) {
        channel.stop();
        this.channels.delete(username);
      }
    };
  }

  /** Total upstream connections currently held (for /metrics-ish introspection). */
  get size() {
    return this.channels.size;
  }

  /**
   * Latest live viewer count TikTok reported for a username, or null
   * when this process holds no connected channel for it (nobody
   * subscribed, or the stream is offline). Null means UNKNOWN — the
   * caller must not render it as zero.
   *
   * @param {string} rawUsername
   * @returns {number | null}
   */
  viewerCount(rawUsername) {
    /** @type {string} */
    let username;
    try {
      username = normalizeTikTokUsername(rawUsername);
    } catch {
      return null;
    }
    const channel = this.channels.get(username);
    if (!channel || channel.state !== "connected") return null;
    return channel.viewers;
  }
}

/**
 * One upstream TikTok connection + its fan-out set.
 * @private
 */
class Channel {
  /**
   * @param {string} username
   * @param {(username: string) => Promise<any>} connectionFactory
   * @param {{ info: Function, warn: Function } | null} log
   */
  constructor(username, connectionFactory, log) {
    this.username = username;
    this.connectionFactory = connectionFactory;
    this.log = log;
    /** @type {Map<RelayListener, Set<string>>} */
    this.listeners = new Map();
    /** @type {"connecting"|"connected"|"offline"|"ended"|"error"} */
    this.state = "connecting";
    /**
     * Latest viewer count from the webcast's `roomUser` frames, or
     * null until TikTok sends the first one. Cleared on every
     * (re)connect so a stale number can never outlive its stream.
     * @type {number | null}
     */
    this.viewers = null;
    this.stopped = false;
    /** @type {any} */
    this.connection = null;
    /** @type {string | null} TikTok room id for the current broadcast. */
    this.roomId = null;
    /** @type {NodeJS.Timeout | null} */
    this.retryTimer = null;
    /**
     * TikTok can deliver the same comment in the connect response and
     * again on the newly-opened websocket. Keep a bounded set across
     * reconnects so enabling the startup comment batch cannot duplicate
     * messages in the overlay.
     * @type {Set<string>}
     */
    this.seenChatIds = new Set();
    /** Event ids seen in this broadcast (gifts/follows/subs/shares). */
    this.seenEventIds = new Set();
    /**
     * Bounded chat backlog shared with late Dock/widget listeners.
     * Entries already use the relay wire shape and are immutable after
     * mapping, so replay cannot diverge from the original fan-out.
     * @type {Record<string, any>[]}
     */
    this.recentChatEvents = [];
    /**
     * Bounded normalized-event backlog for late timeline surfaces.
     * @type {Record<string, any>[]}
     */
    this.recentPlatformEvents = [];
  }

  /** @param {Record<string, any>} event */
  emit(event) {
    if (event.type === "status") {
      this.state = event.state;
    } else if (event.type === "chat") {
      this.rememberRecentChat(event);
    } else if (event.type === "event") {
      this.rememberRecentPlatformEvent(event);
    }
    for (const listener of this.listeners.keys()) {
      this.deliver(listener, event);
    }
  }

  /** @param {Record<string, any>} event */
  rememberRecentChat(event) {
    this.recentChatEvents.push(event);
    if (this.recentChatEvents.length > MAX_RECENT_CHAT_EVENTS) {
      this.recentChatEvents.splice(
        0,
        this.recentChatEvents.length - MAX_RECENT_CHAT_EVENTS,
      );
    }
  }

  /** @param {Record<string, any>} event */
  rememberRecentPlatformEvent(event) {
    this.recentPlatformEvents.push(event);
    if (this.recentPlatformEvents.length > MAX_RECENT_PLATFORM_EVENTS) {
      this.recentPlatformEvents.splice(
        0,
        this.recentPlatformEvents.length - MAX_RECENT_PLATFORM_EVENTS,
      );
    }
  }

  /**
   * Deliver once per listener/message id. This lets reconnecting
   * listeners catch up after the room is known without duplicating
   * chat they already received from the same shared channel.
   * @param {RelayListener} listener
   * @param {Record<string, any>} event
   */
  deliver(listener, event) {
    const delivered = this.listeners.get(listener);
    if (!delivered) return;
    const deliveryId =
      event.type === "chat"
        ? `chat:${String(event.message?.id || "")}`
        : event.type === "event"
          ? `event:${String(event.event?.id || "")}`
          : "";
    if (deliveryId && delivered.has(deliveryId)) return;
    try {
      listener(event);
    } catch {
      /* one bad SSE pipe must not break the fan-out */
    }
    if (deliveryId) rememberBoundedId(delivered, deliveryId);
  }

  /** @param {RelayListener} listener */
  replayRecent(listener) {
    const recent = [
      ...this.recentChatEvents,
      ...this.recentPlatformEvents,
    ].sort((a, b) => wireEventTimestamp(a) - wireEventTimestamp(b));
    for (const event of recent) {
      this.deliver(listener, { ...event, replay: true });
    }
  }

  clearSessionHistory() {
    this.recentChatEvents = [];
    this.recentPlatformEvents = [];
    this.seenChatIds.clear();
    this.seenEventIds.clear();
    for (const delivered of this.listeners.values()) delivered.clear();
  }

  start() {
    void this.connectOnce();
  }

  /** @param {number} delayMs */
  scheduleRetry(delayMs) {
    if (this.stopped) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connectOnce();
    }, delayMs);
    // Never hold the process open just for a retry timer.
    if (typeof this.retryTimer.unref === "function") this.retryTimer.unref();
  }

  async connectOnce() {
    if (this.stopped) return;
    if (this.state === "offline" || this.state === "ended") {
      // A confirmed offline/end boundary separates broadcasts. Keep a
      // transient-disconnect backlog, but never carry an old live into
      // a later one that happens to use the same username.
      this.clearSessionHistory();
      this.roomId = null;
    }
    // A count from a previous connection describes a stream that is
    // no longer on air — drop it before the new one reports.
    this.viewers = null;
    this.emit({ type: "status", state: "connecting" });
    let connection;
    try {
      connection = await this.connectionFactory(this.username);
    } catch (err) {
      this.emit({
        type: "status",
        state: "error",
        detail: "tiktok connector unavailable",
      });
      this.log?.warn?.(
        { err: String(err), username: this.username },
        "tiktok connector load failed",
      );
      this.scheduleRetry(OFFLINE_RETRY_MS);
      return;
    }
    if (this.stopped) {
      safeDisconnect(connection);
      return;
    }
    this.connection = connection;

    /** @type {Record<string, any>[]} */
    const startupChatEvents = [];
    const startupChatIds = new Set();
    let startupPhase = true;
    let acceptEvents = true;

    connection.on("chat", (/** @type {Record<string, any>} */ data) => {
      if (!acceptEvents || this.connection !== connection) return;
      const message = mapChatEvent(data);
      if (!message) return;
      if (startupPhase) {
        if (startupChatIds.has(message.id)) return;
        startupChatIds.add(message.id);
        startupChatEvents.push({ type: "chat", message, replay: true });
        return;
      }
      if (!this.rememberChatId(message.id)) return;
      this.emit({
        type: "chat",
        message,
        ...(this.roomId ? { session: this.roomId } : {}),
        ...(this.state === "connected" ? {} : { replay: true }),
      });
    });
    for (const [wireName, eventName] of [
      ["gift", "gift"],
      ["follow", "follow"],
      ["share", "share"],
      // Connector 2.x calls subscription notifications `subNotify`.
      ["subNotify", "subscribe"],
    ]) {
      connection.on(wireName, (/** @type {Record<string, any>} */ data) => {
        if (!acceptEvents || this.connection !== connection) return;
        // Initial-data processing intentionally restores recent comments,
        // but replaying an old gift/follow/subscription would fire a stale
        // alert every time OBS reconnects.
        if (this.state !== "connected") return;
        const event = mapTikTokEvent(eventName, data);
        if (event && rememberBoundedId(this.seenEventIds, event.id)) {
          this.emit({
            type: "event",
            event,
            ...(this.roomId ? { session: this.roomId } : {}),
          });
        }
      });
    }
    // `roomUser` is the webcast's viewer-count heartbeat — the live
    // audience TikTok itself shows. Connector 2.x may expose that as
    // normalized `viewerCount` or raw protobuf `total`. `totalUser` is
    // cumulative unique viewers and must never appear as "watching
    // now" in the dock.
    connection.on("roomUser", (/** @type {Record<string, any>} */ data) => {
      if (!acceptEvents || this.connection !== connection) return;
      this.viewers = currentRoomViewerCount(data);
    });
    connection.on("streamEnd", () => {
      if (!acceptEvents || this.connection !== connection) return;
      // `processInitialData` can surface an end frame before connect()
      // settles. Make the end terminal for this attempt so its eventual
      // promise resolution cannot overwrite `ended` with `connected`.
      acceptEvents = false;
      this.viewers = null;
      // A later live is a new chat session. Existing browser feeds keep
      // what they already rendered, but a surface opened after the end
      // must not inherit comments from the previous broadcast.
      this.clearSessionHistory();
      this.roomId = null;
      this.emit({ type: "status", state: "ended" });
      this.scheduleRetry(OFFLINE_RETRY_MS);
    });
    connection.on("disconnected", () => {
      if (!acceptEvents || this.connection !== connection) return;
      if (startupPhase) acceptEvents = false;
      this.viewers = null;
      if (this.stopped || this.state === "ended") return;
      this.emit({ type: "status", state: "connecting" });
      this.scheduleRetry(DISCONNECT_RETRY_MS);
    });
    connection.on("error", () => {
      /* handled by disconnected/retry — swallow to avoid unhandled 'error' crashes */
    });

    try {
      const connectedState = await connection.connect();
      if (!acceptEvents || this.stopped || this.connection !== connection) {
        acceptEvents = false;
        safeDisconnect(connection);
        return;
      }
      const nextRoomId = connectRoomId(connectedState);
      if (this.roomId && nextRoomId && this.roomId !== nextRoomId) {
        this.clearSessionHistory();
      }
      if (nextRoomId) this.roomId = nextRoomId;
      // Initial-data chat is held until the room id confirms whether
      // this is a reconnect or a new broadcast. Store it first, then
      // each listener receives only the history it has not seen.
      for (const event of startupChatEvents) {
        if (!this.rememberChatId(event.message.id)) continue;
        this.rememberRecentChat({
          ...event,
          ...(this.roomId ? { session: this.roomId } : {}),
        });
      }
      startupPhase = false;
      this.emit({ type: "status", state: "connected" });
      for (const listener of this.listeners.keys()) {
        this.replayRecent(listener);
      }
    } catch (err) {
      acceptEvents = false;
      const offline = /isn'?t online|offline|not.*live/i.test(
        String(/** @type {any} */ (err)?.message || err),
      );
      if (offline) {
        this.clearSessionHistory();
        this.roomId = null;
      }
      this.emit({
        type: "status",
        state: offline ? "offline" : "error",
        detail: offline ? undefined : trimDetail(err),
      });
      this.scheduleRetry(OFFLINE_RETRY_MS);
    }
  }

  /**
   * @param {string} id
   * @returns {boolean} true only for the first occurrence
   */
  rememberChatId(id) {
    return rememberBoundedId(this.seenChatIds, String(id));
  }

  stop() {
    this.stopped = true;
    this.viewers = null;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    safeDisconnect(this.connection);
    this.connection = null;
    this.listeners.clear();
  }
}

/**
 * Read only fields known to mean the current concurrent audience.
 * The normalized connector field takes precedence over its raw-proto
 * equivalent, but an empty normalized field may fall through safely.
 *
 * @param {Record<string, any>} data
 * @returns {number | null}
 */
function currentRoomViewerCount(data) {
  for (const raw of [data?.viewerCount, data?.total]) {
    if (raw === null || raw === undefined || raw === "") continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return null;
}

/**
 * Connector versions return the current room id on the connect result.
 * Keep this tolerant of normalized and raw-ish shapes so a library
 * upgrade cannot silently disable broadcast-boundary detection.
 *
 * @param {Record<string, any> | null | undefined} connectedState
 * @returns {string | null}
 */
function connectRoomId(connectedState) {
  const raw =
    connectedState?.roomId ??
    connectedState?.room_id ??
    connectedState?.roomInfo?.roomId;
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim();
  return value ? value.slice(0, 128) : null;
}

/**
 * @param {Set<string>} ids
 * @param {string} id
 * @returns {boolean} true only for the first bounded occurrence
 */
function rememberBoundedId(ids, id) {
  if (ids.has(id)) return false;
  ids.add(id);
  if (ids.size > MAX_SEEN_CHAT_IDS) {
    const oldest = ids.values().next().value;
    if (oldest !== undefined) ids.delete(oldest);
  }
  return true;
}

/** @param {any} connection */
function safeDisconnect(connection) {
  try {
    connection?.disconnect?.();
  } catch {
    /* already down */
  }
}

/** @param {unknown} err @returns {string} */
function trimDetail(err) {
  return String(/** @type {any} */ (err)?.message || err).slice(0, 160);
}

/**
 * Normalize "@name", "tiktok.com/@name", full profile URLs → bare name.
 *
 * @param {string} raw
 * @returns {string}
 */
function normalizeTikTokUsername(raw) {
  let input = String(raw || "").trim().toLowerCase();
  if (!input) {
    const err = new Error("username required");
    // @ts-ignore
    err.code = "bad_input";
    throw err;
  }
  input = input.replace(/^https?:\/\//, "").replace(/^www\./, "");
  if (input.startsWith("tiktok.com/")) input = input.slice("tiktok.com/".length);
  input = input.split(/[/?#]/)[0];
  if (input.startsWith("@")) input = input.slice(1);
  if (!/^[a-z0-9._]{2,32}$/.test(input)) {
    const err = new Error("unrecognized TikTok username");
    // @ts-ignore
    err.code = "bad_input";
    throw err;
  }
  return input;
}

/**
 * Map a connector `chat` event to the slim relay message. Connector
 * 2.4.x can expose the v3-schema fields as `content` and
 * `user.displayId`, while other payload paths use `comment` and
 * `user.uniqueId`. Accept both shapes so a schema-path change cannot
 * silently drop an otherwise healthy chat stream.
 *
 * @param {Record<string, any>} data
 */
function mapChatEvent(data) {
  const legacyText = String(data?.comment || "").trim();
  const currentText = String(data?.content || "").trim();
  const text = legacyText || currentText;
  if (!text) return null;
  const user =
    data?.user?.uniqueId ||
    data?.user?.displayId ||
    data?.user?.nickname ||
    data?.uniqueId ||
    data?.displayId ||
    data?.nickname ||
    "viewer";
  /** @type {string[]} */
  const badges = [];
  if (data?.user?.isModerator || data?.isModerator) badges.push("moderator");
  if (data?.user?.isSubscriber || data?.isSubscriber) badges.push("member");
  const msgId = data?.msgId || data?.common?.msgId;
  return {
    id: msgId ? String(msgId) : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    user: String(user),
    text: text.slice(0, 500),
    badges,
    atMs: sourceTimestampMs(data),
  };
}

/** @param {Record<string, any>} wire */
function wireEventTimestamp(wire) {
  const value = Number(
    wire?.type === "chat" ? wire?.message?.atMs : wire?.event?.atMs,
  );
  return Number.isFinite(value) ? value : 0;
}

/**
 * Map a connector event (`gift`, `follow`, `subscribe`) to the slim
 * relay event, or null for anything not worth surfacing. Streakable
 * gifts (giftType 1) fire once per tap while a combo runs — only the
 * `repeatEnd` frame carries the final count, so intermediate frames
 * are dropped; when the connector omits those fields, emit rather than
 * silently swallow every gift.
 *
 * @param {string} name
 * @param {Record<string, any>} data
 * @returns {{ id: string, kind: string, user: string, detail: string,
 *   amount?: string, atMs: number } | null}
 */
function mapTikTokEvent(name, data) {
  const user =
    data?.user?.uniqueId ||
    data?.user?.displayId ||
    data?.user?.nickname ||
    data?.uniqueId ||
    data?.displayId ||
    data?.nickname ||
    "viewer";
  const msgId = data?.msgId || data?.common?.msgId;
  const atMs = sourceTimestampMs(data);
  const discriminator =
    data?.giftId ||
    data?.action ||
    data?.shareType ||
    data?.subMonth ||
    data?.repeatCount ||
    "event";
  const base = {
    id: msgId
      ? String(msgId)
      : `${name}:${atMs}:${String(user)}:${String(discriminator)}`,
    user: String(user),
    atMs,
  };
  if (name === "gift") {
    const details = data?.giftDetails || data?.gift || {};
    const extended = data?.extendedGiftInfo || {};
    const giftType = details?.giftType ?? data?.giftType;
    if (giftType === 1 && !data?.repeatEnd) return null;
    const count = Number(data?.repeatCount) || 1;
    const giftName =
      details?.giftName ||
      details?.name ||
      extended?.name ||
      extended?.giftName ||
      data?.giftName ||
      "a gift";
    const rawDiamondCost =
      extended?.diamond_count ??
      extended?.diamondCount ??
      extended?.cost ??
      details?.diamondCount ??
      details?.diamond_count ??
      data?.diamondCount;
    const diamondCost = Number(rawDiamondCost);
    const diamonds =
      Number.isFinite(diamondCost) && diamondCost > 0
        ? Math.round(diamondCost * count)
        : 0;
    return {
      ...base,
      kind: "gift",
      detail:
        `sent ${giftName}` + (count > 1 ? ` x${count}` : ""),
      amount:
        diamonds > 0
          ? `${diamonds.toLocaleString("en-US")} ${diamonds === 1 ? "diamond" : "diamonds"}`
          : `${count} ${count === 1 ? "gift" : "gifts"}`,
    };
  }
  if (name === "follow") {
    return { ...base, kind: "follow", detail: "followed" };
  }
  if (name === "subscribe") {
    const months = Number(data?.subMonth ?? data?.month ?? data?.months);
    if (Number.isFinite(months) && months > 1) {
      return {
        ...base,
        kind: "resub",
        detail: `subscribed for ${Math.floor(months)} months`,
        amount: `${Math.floor(months)} months`,
      };
    }
    return { ...base, kind: "sub", detail: "subscribed" };
  }
  if (name === "share") {
    return { ...base, kind: "share", detail: "shared the stream" };
  }
  return null;
}

/**
 * Production connection factory — lazy dynamic import because
 * tiktok-live-connector is ESM-only and this codebase is CJS.
 *
 * @param {string} username
 */
async function defaultConnectionFactory(username) {
  const mod = await import("tiktok-live-connector");
  const { TikTokLiveConnection } = /** @type {any} */ (mod);
  return new TikTokLiveConnection(username, TIKTOK_CONNECTION_OPTIONS);
}

/**
 * Preserve TikTok's source time for startup-history comments. Treating
 * every decoded frame as `Date.now()` makes replayed chat look live to
 * TTS, message sounds, engagement, and command responders.
 *
 * Connector v3 uses a millisecond string at `common.createTime`; older
 * shapes may expose seconds directly or under `event.createTime`.
 *
 * @param {Record<string, any>} data
 * @returns {number}
 */
function sourceTimestampMs(data) {
  for (const raw of [
    data?.common?.createTime,
    data?.event?.createTime,
    data?.createTime,
  ]) {
    if (raw === null || raw === undefined || raw === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) continue;
    // Ten-digit Unix timestamps are seconds; connector v3's are ms.
    return Math.floor(n < 100_000_000_000 ? n * 1000 : n);
  }
  return Date.now();
}

module.exports = {
  TikTokChatRelay,
  normalizeTikTokUsername,
  mapChatEvent,
  mapTikTokEvent,
  sourceTimestampMs,
  TIKTOK_CONNECTION_OPTIONS,
  MAX_RECENT_CHAT_EVENTS,
  OFFLINE_RETRY_MS,
  DISCONNECT_RETRY_MS,
};
