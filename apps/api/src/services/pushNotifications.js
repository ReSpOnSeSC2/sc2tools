"use strict";

const crypto = require("crypto");
const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");
const { parseVapidKeys, vapidAuthorization, encryptPushPayload, decodeKey } = require("./webPushCrypto");

/**
 * Web Push for the notification center (docs/notifications.md).
 *
 * Inert until the owner sets WEB_PUSH_VAPID_PUBLIC_KEY,
 * WEB_PUSH_VAPID_PRIVATE_KEY and WEB_PUSH_VAPID_SUBJECT: without a valid
 * pair ``enabled`` is false, subscribe answers 503 and ``deliver`` is a
 * no-op. Messages go to the browsers' own free push services only — the
 * endpoint host allowlist below keeps a stored endpoint from turning this
 * server into a request proxy.
 *
 * Fan-out follows the bell: ``NotificationsService`` calls ``deliver``
 * only for rows it actually stored, so muted kinds never push. A device
 * answering 404/410 (gone) or 401/403 (VAPID keys rotated) is removed.
 */

const MAX_DEVICES = 10;
const ENDPOINT_MAX = 1024;
const LABEL_MAX = 80;
const PUSH_TTL_SEC = 24 * 60 * 60;
const SEND_TIMEOUT_MS = 10_000;
const TEST_COOLDOWN_MS = 10_000;
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/,
  /^(updates\.)?push\.services\.mozilla\.com$/,
  /^([a-z0-9-]+\.)?push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];

/** Ordered: a kind belongs to the first group that matches. */
const PUSH_GROUPS = Object.freeze([
  { id: "reviews", label: "Review answers", match: (/** @type {string} */ kind) => kind === "review.new" || kind === "review.reply" },
  { id: "coaching", label: "Coaching bookings and reminders", match: (/** @type {string} */ kind) => kind.startsWith("coaching.") },
  { id: "playback", label: "Accurate playback ready", match: (/** @type {string} */ kind) => kind === "playback_ready" },
  { id: "reports", label: "Weekly and stream reports", match: (/** @type {string} */ kind) => kind.startsWith("report.") },
  { id: "desktop", label: "Desktop app and integrations", match: (/** @type {string} */ kind) => kind.startsWith("agent.") || kind.startsWith("integration.") },
  { id: "other", label: "Everything else", match: () => true },
]);
const GROUP_IDS = new Set(PUSH_GROUPS.map((group) => group.id));
const DEFAULT_GROUPS = ["reviews", "coaching", "playback", "reports", "desktop"];

/** @param {string} kind */
function pushGroupFor(kind) {
  return (PUSH_GROUPS.find((group) => group.match(kind)) || PUSH_GROUPS[PUSH_GROUPS.length - 1]).id;
}

/** @param {unknown} input @returns {string[]} */
function sanitizePushGroups(input) {
  if (!Array.isArray(input)) return [...DEFAULT_GROUPS];
  return [...new Set(input.filter((id) => typeof id === "string" && GROUP_IDS.has(id)))];
}

/**
 * Only a known browser push service, over https on the default port.
 * @param {unknown} raw
 * @returns {string|null}
 */
function safePushEndpoint(raw) {
  if (typeof raw !== "string" || raw.length > ENDPOINT_MAX || raw !== raw.trim()) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return null;
  // The browser's exact string: its hash is the device key the page computes.
  return PUSH_HOSTS.some((pattern) => pattern.test(url.hostname)) ? raw : null;
}

/** @param {string} endpoint */
const endpointHash = (endpoint) => crypto.createHash("sha256").update(endpoint).digest("hex");

/** @param {unknown} value */
function cleanLabel(value) {
  const text = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, LABEL_MAX) : "";
  return text || "Browser";
}

/** @param {number} status @param {string} code @param {string} message */
function pushError(status, code, message) { return Object.assign(new Error(message), { status, code }); }

class PushNotificationsService {
  /**
   * @param {{pushSubscriptions: import('mongodb').Collection<any>, users: import('mongodb').Collection<any>}} db
   * @param {{config?: {publicKey?: string, privateKey?: string, subject?: string}|null,
   *   fetchImpl?: typeof fetch, logger?: import('pino').Logger|null, now?: () => number}} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    const config = opts.config || {};
    const subject = typeof config.subject === "string" && /^(mailto:|https:\/\/)\S{3,200}$/.test(config.subject) ? config.subject : null;
    const vapid = subject ? parseVapidKeys(config.publicKey, config.privateKey) : null;
    this.vapid = vapid;
    this.subject = subject || "";
    this.fetchImpl = opts.fetchImpl || fetch;
    this.logger = opts.logger || null;
    this.now = opts.now || Date.now;
    /** @type {Map<string, number>} */
    this.lastTest = new Map();
  }

  get enabled() { return this.vapid !== null; }

  /** @param {string} userId */
  async status(userId) {
    const [user, rows] = await Promise.all([
      this.db.users.findOne({ userId }, { projection: { _id: 0, "preferences.push": 1 } }),
      this.db.pushSubscriptions.find({ userId }, { projection: { _id: 1, label: 1, endpointHash: 1, createdAt: 1, lastOkAt: 1 } })
        .sort({ createdAt: -1 }).limit(MAX_DEVICES).toArray(),
    ]);
    return {
      enabled: this.enabled,
      publicKey: this.vapid ? this.vapid.publicKey : null,
      groups: sanitizePushGroups(user?.preferences?.push?.groups),
      available: PUSH_GROUPS.map(({ id, label }) => ({ id, label })),
      devices: rows.map((row) => ({
        id: String(row._id), label: row.label, key: String(row.endpointHash || "").slice(0, 16),
        createdAt: new Date(row.createdAt).toISOString(), lastOkAt: row.lastOkAt ? new Date(row.lastOkAt).toISOString() : null,
      })),
    };
  }

  /**
   * Register (or re-register) this browser. One endpoint belongs to one
   * account: signing in as someone else on the same browser moves it.
   * @param {string} userId
   * @param {{endpoint?: unknown, keys?: {p256dh?: unknown, auth?: unknown}, expirationTime?: unknown, label?: unknown}} body
   */
  async subscribe(userId, body) {
    if (!this.enabled) throw pushError(503, "push_unavailable", "Push notifications are not available on this server yet.");
    const { endpoint, keys } = parseSubscription(body);
    const now = new Date(this.now());
    const expires = typeof body.expirationTime === "number" && Number.isFinite(body.expirationTime) ? new Date(body.expirationTime) : null;
    const hash = endpointHash(endpoint);
    await this.db.pushSubscriptions.updateOne({ endpointHash: hash }, {
      $set: stampVersion({ userId, endpoint, keys, label: cleanLabel(body.label), expiresAt: expires, failures: 0, updatedAt: now }, COLLECTIONS.PUSH_SUBSCRIPTIONS),
      $setOnInsert: { _id: `ps_${crypto.randomBytes(12).toString("base64url")}`, createdAt: now, lastOkAt: null },
    }, { upsert: true });
    const extra = await this.db.pushSubscriptions.find({ userId }, { projection: { _id: 1 } }).sort({ createdAt: -1 }).skip(MAX_DEVICES).toArray();
    if (extra.length) await this.db.pushSubscriptions.deleteMany({ userId, _id: { $in: extra.map((row) => row._id) } });
    const saved = await this.db.pushSubscriptions.findOne({ endpointHash: hash }, { projection: { _id: 1 } });
    return { id: String(saved?._id || ""), key: hash.slice(0, 16) };
  }

  /** @param {string} userId @param {string} id */
  async removeDevice(userId, id) {
    const res = await this.db.pushSubscriptions.deleteOne({ userId, _id: String(id).slice(0, 64) });
    return { removed: res.deletedCount || 0 };
  }

  /** Turning push off in this browser. @param {string} userId @param {unknown} endpoint */
  async unsubscribe(userId, endpoint) {
    if (typeof endpoint !== "string" || endpoint.length > ENDPOINT_MAX) return { removed: 0 };
    const res = await this.db.pushSubscriptions.deleteOne({ userId, endpointHash: endpointHash(endpoint) });
    return { removed: res.deletedCount || 0 };
  }

  /**
   * ``pushsubscriptionchange`` from the service worker, which holds no
   * session: the previous endpoint (known only to that browser and this
   * server) proves ownership of the row it replaces.
   * @param {{oldEndpoint?: unknown, subscription?: any}} body
   */
  async rotate(body) {
    if (!this.enabled) throw pushError(503, "push_unavailable", "Push notifications are not available on this server yet.");
    if (typeof body.oldEndpoint !== "string" || body.oldEndpoint.length > ENDPOINT_MAX) throw pushError(400, "invalid_subscription", "Invalid subscription.");
    const { endpoint, keys } = parseSubscription(body.subscription || {});
    const previous = await this.db.pushSubscriptions.findOne({ endpointHash: endpointHash(body.oldEndpoint) }, { projection: { _id: 1 } });
    if (!previous) return { rotated: false };
    const hash = endpointHash(endpoint);
    // The browser may already have registered the new endpoint itself.
    await this.db.pushSubscriptions.deleteMany({ endpointHash: hash, _id: { $ne: previous._id } });
    const res = await this.db.pushSubscriptions.updateOne({ _id: previous._id }, {
      $set: { endpoint, endpointHash: hash, keys, failures: 0, updatedAt: new Date(this.now()) },
    });
    return { rotated: res.modifiedCount === 1 };
  }

  /** @param {string} userId @param {unknown} groups */
  async setGroups(userId, groups) {
    if (!Array.isArray(groups)) throw pushError(400, "invalid_push_groups", "Choose which notifications to push.");
    const value = sanitizePushGroups(groups);
    await this.db.users.updateOne({ userId }, { $set: { "preferences.push": { groups: value } } });
    return { groups: value };
  }

  /** @param {string} userId */
  async sendTest(userId) {
    if (!this.enabled) throw pushError(503, "push_unavailable", "Push notifications are not available on this server yet.");
    const last = this.lastTest.get(userId) || 0;
    if (this.now() - last < TEST_COOLDOWN_MS) throw pushError(429, "push_test_cooldown", "Wait a few seconds before sending another test.");
    this.lastTest.set(userId, this.now());
    if (this.lastTest.size > 5000) this.lastTest.clear();
    return this._fanOut(userId, { title: "SC2 Tools test notification", body: "Push notifications work on this device.", href: "/settings?tab=preferences#push", tag: "push-test" });
  }

  /**
   * Called after the bell stored ``row``. Never throws.
   * @param {string} userId
   * @param {{_id?: unknown, kind: string, title: string, body?: string, href?: string|null}} row
   */
  async deliver(userId, row) {
    if (!this.enabled) return { sent: 0, removed: 0 };
    try {
      const user = await this.db.users.findOne({ userId }, { projection: { _id: 0, "preferences.push": 1, _gdprMutation: 1 } });
      if (!user || user._gdprMutation) return { sent: 0, removed: 0 };
      if (!sanitizePushGroups(user.preferences?.push?.groups).includes(pushGroupFor(row.kind))) return { sent: 0, removed: 0 };
      return await this._fanOut(userId, { title: row.title, body: row.body || "", href: row.href || "/notifications", tag: `n:${String(row._id || row.kind)}` });
    } catch (err) {
      this.logger?.warn({ code: errorCode(err) }, "push_delivery_failed");
      return { sent: 0, removed: 0 };
    }
  }

  /** @param {string} userId @param {{title: string, body: string, href: string, tag: string}} message */
  async _fanOut(userId, message) {
    const rows = await this.db.pushSubscriptions.find({ userId }).limit(MAX_DEVICES).toArray();
    const payload = JSON.stringify({ title: message.title.slice(0, 140), body: message.body.slice(0, 280), href: message.href, tag: message.tag.slice(0, 64) });
    let sent = 0; let removed = 0;
    for (const row of rows) {
      const outcome = await this._sendOne(row, payload);
      if (outcome === "ok") sent += 1;
      if (outcome === "gone") removed += 1;
    }
    return { sent, removed };
  }

  /** @param {any} row @param {string} payload @returns {Promise<"ok"|"gone"|"failed">} */
  async _sendOne(row, payload) {
    const now = this.now();
    const endpoint = safePushEndpoint(row.endpoint);
    if (!endpoint || (row.expiresAt && new Date(row.expiresAt).getTime() <= now) || !this.vapid) {
      await this.db.pushSubscriptions.deleteOne({ _id: row._id });
      return "gone";
    }
    let status = 0;
    try {
      const res = await this.fetchImpl(endpoint, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        headers: {
          Authorization: vapidAuthorization({ endpoint, subject: this.subject, vapid: this.vapid, nowSec: Math.floor(now / 1000) }),
          "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: String(PUSH_TTL_SEC), Urgency: "normal",
        },
        body: new Uint8Array(encryptPushPayload(payload, row.keys || {})),
      });
      status = res.status;
    } catch (err) {
      this.logger?.warn({ code: errorCode(err), device: String(row._id) }, "push_send_failed");
    }
    if (status >= 200 && status < 300) {
      await this.db.pushSubscriptions.updateOne({ _id: row._id }, { $set: { lastOkAt: new Date(now), failures: 0 } });
      return "ok";
    }
    if ([401, 403, 404, 410].includes(status) || (row.failures || 0) >= 9) {
      await this.db.pushSubscriptions.deleteOne({ _id: row._id });
      return "gone";
    }
    await this.db.pushSubscriptions.updateOne({ _id: row._id }, { $inc: { failures: 1 } });
    return "failed";
  }
}

/** @param {{endpoint?: unknown, keys?: {p256dh?: unknown, auth?: unknown}}} body */
function parseSubscription(body) {
  const endpoint = safePushEndpoint(body && body.endpoint);
  const p256dh = body?.keys?.p256dh;
  const auth = body?.keys?.auth;
  if (!endpoint || !decodeKey(p256dh, 65) || !decodeKey(auth, 16)) {
    throw pushError(400, "invalid_subscription", "This browser returned a push subscription SC2 Tools cannot use.");
  }
  return { endpoint, keys: { p256dh: String(p256dh), auth: String(auth) } };
}

/** @param {unknown} err */
function errorCode(err) {
  const code = /** @type {any} */ (err)?.code || /** @type {any} */ (err)?.name;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,48}$/.test(code) ? code : "push_error";
}

module.exports = { PushNotificationsService, PUSH_GROUPS, DEFAULT_GROUPS, pushGroupFor, sanitizePushGroups, safePushEndpoint };
