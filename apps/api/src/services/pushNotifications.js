"use strict";

const crypto = require("crypto");
const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");
const { isDuplicateKey } = require("../util/jobLock");
const { claimUserDataLease } = require("../middleware/userDataWriteFence");
const { sanitizeNotificationPrefs } = require("./notificationPrefs");
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
 * only for rows it actually stored, so muted kinds never push. New or
 * unset preferences do not select any kinds. A device
 * answering 404/410 (gone) or 401/403 (VAPID keys rotated) is removed.
 */

const MAX_DEVICES = 10;
const PUSH_ENROLLMENT_VERSION = 1;
const ENDPOINT_MAX = 1024;
const LABEL_MAX = 80;

/** @typedef {{_id: string, userId: string, endpoint: string, endpointHash: string, keys: {p256dh: string, auth: string},
 *   expiresAt?: Date|null, updatedAt?: Date|null, failures?: number}} DeliveryDevice */
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
  { id: "reviews", label: "Review answers", match: (/** @type {string} */ kind) => kind === "review.reply" },
  { id: "review-requests", label: "New reviews", match: (/** @type {string} */ kind) => kind === "review.new" },
  { id: "coaching-reminders", label: "Coaching reminders", match: (/** @type {string} */ kind) => kind === "coaching.reminder" },
  { id: "coaching-booked", label: "Coaching bookings", match: (/** @type {string} */ kind) => kind === "coaching.booked" },
  { id: "coaching-cancelled", label: "Coaching cancellations", match: (/** @type {string} */ kind) => kind === "coaching.cancelled" },
  { id: "coaching-assigned", label: "New practice assignments", match: (/** @type {string} */ kind) => kind === "coaching.assigned" },
  { id: "coaching", label: "Other coaching updates", match: (/** @type {string} */ kind) => kind.startsWith("coaching.") },
  { id: "playback", label: "Accurate playback ready", match: (/** @type {string} */ kind) => kind === "playback_ready" },
  { id: "reports", label: "Weekly report", match: (/** @type {string} */ kind) => kind === "report.weekly" },
  { id: "stream-reports", label: "Stream reports", match: (/** @type {string} */ kind) => kind === "report.stream" },
  { id: "goals", label: "Goal met", match: (/** @type {string} */ kind) => kind === "goal_met" },
  { id: "agent-unlinked", label: "Desktop app unlinked", match: (/** @type {string} */ kind) => kind === "agent.unlinked" },
  { id: "desktop", label: "Desktop app updates and integrations", match: (/** @type {string} */ kind) => kind.startsWith("agent.") || kind.startsWith("integration.") },
  { id: "moment.crossed_mmr_mark", label: "Rating mark reached" },
  { id: "moment.new_season_peak", label: "Season rating peak" },
  { id: "moment.win_streak", label: "Win streak" },
  { id: "moment.loss_streak_broken", label: "Loss streak broken" },
  { id: "moment.revenge_win", label: "Revenge win" },
  { id: "moment.giant_killer", label: "Giant-killer win" },
  { id: "moment.marathon_win", label: "Marathon win" },
  { id: "support.reply", label: "Replies to reports" },
  { id: "import.done", label: "Import finished" },
  { id: "other", label: "Other notifications", match: (/** @type {string} */ kind) => !kind.startsWith("moment.") },
]);
const GROUP_IDS = new Set(PUSH_GROUPS.map((group) => group.id));
const GROUP_VERSION = 3;
const LEGACY_GROUPS = new Map([
  ["reviews", ["review-requests"]],
  ["coaching", ["coaching-reminders"]],
  ["reports", ["stream-reports"]],
  ["desktop", ["agent-unlinked"]],
  ["other", ["goals"]],
]);
const COACHING_GROUPS = ["coaching-booked", "coaching-cancelled", "coaching-assigned"];

/** @param {string} kind */
function pushGroupFor(kind) {
  return PUSH_GROUPS.find((group) => group.match ? group.match(kind) : group.id === kind)?.id;
}

/** @param {unknown} input @returns {string[]} */
function sanitizePushGroups(input) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.filter((id) => typeof id === "string" && GROUP_IDS.has(id)))];
}

/** Expand legacy groups before they are first edited, keeping each prior choice. @param {{groups?: unknown, groupVersion?: unknown}|undefined} preferences */
function storedPushGroups(preferences) {
  const groups = sanitizePushGroups(preferences?.groups);
  if (!preferences || (typeof preferences.groupVersion === "number" && preferences.groupVersion >= GROUP_VERSION)) return groups;
  const legacy = preferences.groupVersion === 2 ? [] : groups.flatMap((group) => LEGACY_GROUPS.get(group) ?? []);
  const coaching = groups.includes("coaching") ? COACHING_GROUPS : [];
  return [...new Set([...groups, ...legacy, ...coaching])];
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
      groups: storedPushGroups(user?.preferences?.push),
      available: PUSH_GROUPS.map(({ id, label }) => ({ id, label })),
      devices: rows.map((row) => ({
        id: String(row._id), label: row.label, key: String(row.endpointHash || "").slice(0, 16),
        createdAt: new Date(row.createdAt).toISOString(), lastOkAt: row.lastOkAt ? new Date(row.lastOkAt).toISOString() : null,
      })),
    };
  }

  /**
   * Register (or re-register) this browser. One endpoint belongs to one
   * account. Explicit registration from a new account transfers it.
   * @param {string} userId
   * @param {{endpoint?: unknown, keys?: {p256dh?: unknown, auth?: unknown}, expirationTime?: unknown, label?: unknown, enrollmentVersion?: unknown}} body
   */
  async subscribe(userId, body) {
    if (!this.enabled) throw pushError(503, "push_unavailable", "Push notifications are not available on this server yet.");
    const { endpoint, keys } = parseSubscription(body);
    const now = new Date(this.now());
    const hash = endpointHash(endpoint);
    const filter = { endpointHash: hash };
    const values = stampVersion({ userId, endpoint, keys, label: cleanLabel(body.label), expiresAt: subscriptionExpiry(body.expirationTime),
      failures: 0, updatedAt: now }, COLLECTIONS.PUSH_SUBSCRIPTIONS);
    await this._saveSubscription(filter, values, now, body.enrollmentVersion === PUSH_ENROLLMENT_VERSION);
    await this._capDevices(userId);
    const saved = await this.db.pushSubscriptions.findOne({ userId, ...filter }, { projection: { _id: 1 } });
    if (!saved) throw pushError(409, "push_device_changed", "This device changed while it was being registered. Try again.");
    return { id: String(saved._id), key: hash.slice(0, 16) };
  }

  /** @param {{endpointHash: string}} filter @param {{userId: string}} values @param {Date} now @param {boolean} enroll */
  async _saveSubscription(filter, values, now, enroll) {
    if (!enroll) {
      // Older Settings bundles re-register on load. They may refresh their own device.
      const refreshed = await this.db.pushSubscriptions.updateOne({ ...filter, userId: values.userId }, { $set: values });
      if (!refreshed.matchedCount) {
        throw pushError(409, "push_enrollment_required", "Update SC2 Tools and choose Turn on for this device.");
      }
      return;
    }
    const transfer = [{ $set: {
      ...Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { $literal: value }])),
      createdAt: { $cond: [{ $eq: ["$userId", { $literal: values.userId }] }, "$createdAt", now] },
      lastOkAt: { $cond: [{ $eq: ["$userId", { $literal: values.userId }] }, { $ifNull: ["$lastOkAt", null] }, null] },
      enrollment: { $cond: [{ $eq: ["$userId", { $literal: values.userId }] }, "$enrollment", crypto.randomUUID()] },
    } }];
    if ((await this.db.pushSubscriptions.updateOne(filter, transfer)).matchedCount) return;
    try {
      await this.db.pushSubscriptions.insertOne({ ...filter, ...values,
        _id: `ps_${crypto.randomBytes(12).toString("base64url")}`, createdAt: now, lastOkAt: null, enrollment: crypto.randomUUID() });
    } catch (error) {
      if (!isDuplicateKey(error) || !(await this.db.pushSubscriptions.updateOne(filter, transfer)).matchedCount) throw error;
    }
  }

  /** @param {string} userId */
  async _capDevices(userId) {
    // Rotation refreshes the endpoint within the same enrollment. A transfer creates a new enrollment.
    const extra = await this.db.pushSubscriptions.find({ userId }, { projection: { _id: 1, enrollment: 1 } })
      .sort({ createdAt: -1, _id: -1 }).skip(MAX_DEVICES).toArray();
    if (extra.length) await this.db.pushSubscriptions.deleteMany({ userId, $or: extra.map((row) => ({ _id: row._id, enrollment: row.enrollment ?? null })) });
  }

  /** @param {string} userId @param {string} id */
  async removeDevice(userId, id) {
    const res = await this.db.pushSubscriptions.deleteOne({ userId, _id: String(id).slice(0, 64) });
    return { removed: res.deletedCount || 0 };
  }

  /** Turning push off in this browser. @param {string} userId @param {unknown} endpoint @param {unknown} [enrollmentVersion] */
  async unsubscribe(userId, endpoint, enrollmentVersion) {
    if (typeof endpoint !== "string" || endpoint.length > ENDPOINT_MAX) return { removed: 0 };
    const filter = { endpointHash: endpointHash(endpoint) };
    const { deletedCount: removed } = await this.db.pushSubscriptions.deleteOne({ userId, ...filter });
    if (enrollmentVersion !== PUSH_ENROLLMENT_VERSION) return { removed };
    // A retry may follow a lost response. Leave another account's browser registration alone.
    const remaining = await this.db.pushSubscriptions.findOne(filter, { projection: { _id: 1 } });
    return { removed, canDeactivate: !remaining };
  }

  /**
   * ``pushsubscriptionchange`` from the service worker, which holds no
   * session: the previous endpoint (known only to that browser and this
   * server) proves ownership of the row it replaces.
   * @param {{oldEndpoint?: unknown, subscription?: {endpoint?: unknown, keys?: {p256dh?: unknown, auth?: unknown}, expirationTime?: unknown}}} body
   */
  async rotate(body) {
    if (!this.enabled) throw pushError(503, "push_unavailable", "Push notifications are not available on this server yet.");
    const oldEndpoint = safePushEndpoint(body.oldEndpoint);
    if (!oldEndpoint) throw pushError(400, "invalid_subscription", "Invalid subscription.");
    const { endpoint, keys } = parseSubscription(body.subscription || {});
    const previousHash = endpointHash(oldEndpoint);
    const hash = endpointHash(endpoint);
    if (previousHash === hash) return { rotated: false };
    const previous = await this.db.pushSubscriptions.findOne({ endpointHash: previousHash }, { projection: { _id: 1, userId: 1 } });
    if (!previous) return { rotated: false };
    const filter = { _id: previous._id, userId: previous.userId, endpointHash: previousHash };
    const lease = await claimUserDataLease(this.db.users, previous.userId);
    try {
      const res = await this.db.pushSubscriptions.updateOne(filter, {
        $set: { endpoint, endpointHash: hash, keys, failures: 0, updatedAt: new Date(this.now()),
          expiresAt: subscriptionExpiry(body.subscription?.expirationTime) },
      });
      return { rotated: res.modifiedCount === 1 };
    } catch (error) {
      // An explicit registration of the replacement takes precedence.
      if (!isDuplicateKey(error)) throw error;
      return { rotated: false };
    } finally { await lease.release(); }
  }

  /** @param {string} userId @param {unknown} groups */
  async setGroups(userId, groups) {
    if (!Array.isArray(groups)) throw pushError(400, "invalid_push_groups", "Choose which notifications to push.");
    const value = sanitizePushGroups(groups);
    await this.db.users.updateOne({ userId }, { $set: { "preferences.push": { groups: value, groupVersion: GROUP_VERSION } } });
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
   * @param {{_id?: unknown, kind: string, groupKey?: unknown}} row
   */
  async deliver(userId, row) {
    if (!this.enabled) return { sent: 0, removed: 0 };
    try {
      const group = pushGroupFor(row.kind);
      const choice = group ? { group, kind: row.kind } : null;
      if (!choice || !await this._mayDeliver(userId, choice)) return { sent: 0, removed: 0 };
      return await this._fanOut(userId, pushMessage(userId, row), choice);
    } catch (err) {
      this.logger?.warn({ code: errorCode(err) }, "push_delivery_failed");
      return { sent: 0, removed: 0 };
    }
  }

  /** @param {string} userId @param {{group: string, kind: string}} choice */
  async _mayDeliver(userId, { group, kind }) {
    const user = await this.db.users.findOne({ userId, _gdprMutation: { $exists: false } },
      { projection: { _id: 0, "preferences.push": 1, "preferences.notifications": 1 } });
    if (!user || !storedPushGroups(user.preferences?.push).includes(group)) return false;
    const prefs = sanitizeNotificationPrefs(user.preferences?.notifications);
    return !prefs.muted.includes(kind) && (!kind.startsWith("moment.") || prefs.milestones);
  }

  /** @param {string} userId @param {{title: string, body: string, href: string, tag: string}} message
   * @param {{group: string, kind: string}} [choice] */
  async _fanOut(userId, message, choice) {
    const rows = await this.db.pushSubscriptions.find({ userId }).sort({ createdAt: -1 }).limit(MAX_DEVICES).toArray();
    const payload = JSON.stringify({ title: message.title.slice(0, 140), body: message.body.slice(0, 280), href: message.href, tag: message.tag.slice(0, 64) });
    let sent = 0; let removed = 0;
    for (const row of rows) {
      if (choice && !await this._mayDeliver(userId, choice)) break;
      const outcome = await this._sendOne(row, payload);
      if (outcome === "ok") sent += 1;
      if (outcome === "gone") removed += 1;
    }
    return { sent, removed };
  }

  /** @param {DeliveryDevice} row @param {string} payload @returns {Promise<"ok"|"gone"|"failed">} */
  async _sendOne(row, payload) {
    const now = this.now();
    const current = deliveryDeviceFilter(row);
    const endpoint = availableEndpoint(row, now);
    const vapid = this.vapid;
    if (!endpoint || !vapid) return await this._removeDeliveryDevice(current);
    if (!await this.db.pushSubscriptions.findOne(current, { projection: { _id: 1 } })) return "failed";
    const status = await this._sendPayload(row, payload, endpoint, now, vapid);
    if (status >= 200 && status < 300) {
      await this.db.pushSubscriptions.updateOne(current, { $set: { lastOkAt: new Date(now), failures: 0 } });
      return "ok";
    }
    if ([401, 403, 404, 410].includes(status) || (row.failures || 0) >= 9) return await this._removeDeliveryDevice(current);
    await this.db.pushSubscriptions.updateOne(current, { $inc: { failures: 1 } });
    return "failed";
  }

  /** @param {{_id: string, userId: string, endpointHash: string|null, updatedAt: Date|null}} filter @returns {Promise<"gone"|"failed">} */
  async _removeDeliveryDevice(filter) {
    const result = await this.db.pushSubscriptions.deleteOne(filter);
    return result.deletedCount === 1 ? "gone" : "failed";
  }

  /** @param {Pick<DeliveryDevice, "_id"|"keys">} row @param {string} payload
   * @param {string} endpoint @param {number} now @param {NonNullable<ReturnType<typeof parseVapidKeys>>} vapid */
  async _sendPayload(row, payload, endpoint, now, vapid) {
    try {
      const res = await this.fetchImpl(endpoint, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        headers: {
          Authorization: vapidAuthorization({ endpoint, subject: this.subject, vapid, nowSec: Math.floor(now / 1000) }),
          "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: String(PUSH_TTL_SEC), Urgency: "normal",
        },
        body: new Uint8Array(encryptPushPayload(payload, row.keys)),
      });
      return res.status;
    } catch (err) {
      this.logger?.warn({ code: errorCode(err), device: String(row._id) }, "push_send_failed");
      return 0;
    }
  }
}

/** @param {DeliveryDevice} row */
function deliveryDeviceFilter(row) {
  return { _id: row._id, userId: row.userId, endpointHash: row.endpointHash ?? null, updatedAt: row.updatedAt ?? null };
}

/** @param {DeliveryDevice} row @param {number} now */
function availableEndpoint(row, now) {
  return row.expiresAt && new Date(row.expiresAt).getTime() <= now ? null : safePushEndpoint(row.endpoint);
}

/** Lock-screen copy contains no bell text or private destination.
 * @param {string} userId @param {{_id?: unknown, kind: string, groupKey?: unknown}} row */
function pushMessage(userId, row) {
  const grouped = typeof row.groupKey === "string" && row.groupKey.length > 0;
  const identity = grouped ? ["group", row.groupKey] : ["row", String(row._id || row.kind)];
  const digest = crypto.createHash("sha256").update(JSON.stringify([userId, ...identity])).digest("base64url");
  return { title: "SC2 Tools", body: "You have a new notification.", href: "/notifications", tag: `n:${digest}` };
}

/** @param {unknown} value */
function subscriptionExpiry(value) {
  if (typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
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

module.exports = { PushNotificationsService, pushGroupFor, sanitizePushGroups, safePushEndpoint, pushMessage };
