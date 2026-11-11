"use strict";

const crypto = require("crypto");
const { encryptSecret, decryptSecret, parseTokenEncryptionKey } = require("./platformCredentialVault");

/**
 * Private coaching calendar feed: ``GET /v1/calendar/<secret>.ics``.
 *
 * The feed looks up the SHA-256 of its 32-byte random secret. When the
 * credential vault is configured, a separate owner-bound encrypted copy
 * is available to the authenticated account export. Rotation replaces
 * both values and revocation removes them. The feed lists bookings only: a coach
 * sees "Coaching session" without student names, a student sees their own
 * sessions with their coach's display name. Request logs redact the path
 * segment (middleware/requestLogging.js).
 */

const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const PAST_MS = 30 * 24 * 60 * 60 * 1000;
const FUTURE_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_EVENTS = 200;
const SITE = "https://sc2tools.com";

/** @param {string} secret */
const hashSecret = (secret) => crypto.createHash("sha256").update(secret).digest("hex");

/** @param {string} userId @param {string} hash */
const calendarAad = (userId, hash) => JSON.stringify(["calendar-feed", userId, hash]);

/** The vault copy never leaves storage, including for legacy hash-only rows.
 * @param {{hash?: string, createdAt?: Date, secretBox?: Parameters<typeof decryptSecret>[0]}} record
 * @param {string} userId @param {Buffer|null} [key]
 */
function calendarExportRecord(record, userId, key = null) {
  const { hash, createdAt, secretBox } = record;
  if (key && typeof hash === "string" && secretBox) {
    try {
      const secret = decryptSecret(secretBox, key, calendarAad(userId, hash));
      if (SECRET_RE.test(secret) && hashSecret(secret) === hash) return { hash, createdAt, secret };
    } catch { /* An unavailable old key leaves calendar export metadata readable. */ }
  }
  return { hash, createdAt };
}

/** RFC 5545 TEXT escaping. @param {unknown} value */
function escapeText(value) {
  return String(value ?? "").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ")
    .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Fold to 75 octets per line without splitting a character. @param {string} line */
function foldLine(line) {
  if (Buffer.byteLength(line, "utf8") <= 75) return line;
  let out = ""; let current = ""; let size = 0; let limit = 75;
  for (const ch of line) {
    const width = Buffer.byteLength(ch, "utf8");
    if (size + width > limit) { out += `${current}\r\n `; current = ""; size = 0; limit = 74; }
    current += ch; size += width;
  }
  return out + current;
}

/** @param {Date} date */
const icsDate = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/**
 * @param {Array<{uid: string, start: Date, end: Date, summary: string, description?: string, cancelled?: boolean, sequence?: number}>} events
 * @param {{name: string, now: Date}} opts
 */
function renderIcs(events, opts) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//SC2 Tools//Coaching//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(opts.name)}`, "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H"];
  for (const event of events) {
    lines.push("BEGIN:VEVENT", `UID:${escapeText(event.uid)}`, `DTSTAMP:${icsDate(opts.now)}`,
      `DTSTART:${icsDate(event.start)}`, `DTEND:${icsDate(event.end)}`, `SUMMARY:${escapeText(event.summary)}`,
      `DESCRIPTION:${escapeText(event.description || `Details: ${SITE}/coaching`)}`, `URL:${SITE}/coaching`,
      `STATUS:${event.cancelled ? "CANCELLED" : "CONFIRMED"}`, `SEQUENCE:${Math.max(0, Math.floor(event.sequence || 0))}`, "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

/** @param {unknown} value */
function toDate(value) {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  return Number.isNaN(date.getTime()) ? null : date;
}

class CalendarFeedService {
  /**
   * @param {{users: import('mongodb').Collection<any>, coaching: import('mongodb').Collection<any>}} db
   * @param {{now?: () => number, encryptionKey?: string|null}} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.now = opts.now || Date.now;
    this.key = opts.encryptionKey ? parseTokenEncryptionKey(opts.encryptionKey) : null;
  }

  /** @param {string} userId @param {Parameters<typeof calendarExportRecord>[0]} record */
  exportRecord(userId, record) { return calendarExportRecord(record, userId, this.key); }

  /** @param {string} userId */
  async status(userId) {
    const user = await this.db.users.findOne({ userId }, { projection: { _id: 0, "calendarFeed.createdAt": 1 } });
    const createdAt = user?.calendarFeed?.createdAt;
    return { active: Boolean(createdAt), createdAt: createdAt ? new Date(createdAt).toISOString() : null };
  }

  /** Create or regenerate. Settings only shows the new secret at creation. @param {string} userId */
  async rotate(userId) {
    const secret = crypto.randomBytes(32).toString("base64url");
    const createdAt = new Date(this.now());
    const hash = hashSecret(secret);
    const secretBox = this.key ? encryptSecret(secret, this.key, calendarAad(userId, hash)) : null;
    const calendarFeed = { hash, createdAt, ...(secretBox ? { secretBox } : {}) };
    const res = await this.db.users.updateOne({ userId, _gdprMutation: { $exists: false } }, { $set: { calendarFeed } });
    if (!res.matchedCount) throw Object.assign(new Error("gdpr_operation_busy"), { status: 409, code: "gdpr_operation_busy" });
    return { active: true, createdAt: createdAt.toISOString(), path: `/v1/calendar/${secret}.ics` };
  }

  /** @param {string} userId */
  async revoke(userId) {
    await this.db.users.updateOne({ userId }, { $unset: { calendarFeed: "" } });
    return { active: false, createdAt: null };
  }

  /** @param {unknown} secret @returns {Promise<string|null>} */
  async feed(secret) {
    if (typeof secret !== "string" || !SECRET_RE.test(secret)) return null;
    const current = { "calendarFeed.hash": hashSecret(secret), _gdprMutation: { $exists: false } };
    const projection = { _id: 0, userId: 1 };
    const user = await this.db.users.findOne(current, { projection });
    if (typeof user?.userId !== "string") return null;
    const now = new Date(this.now());
    const events = await this.events(user.userId, now);
    const stillCurrent = await this.db.users.findOne({ ...current, userId: user.userId }, { projection });
    return stillCurrent ? renderIcs(events, { name: "SC2 Tools coaching", now }) : null;
  }

  /** @param {string} userId @param {Date} now */
  async events(userId, now) {
    const from = now.getTime() - PAST_MS;
    const to = now.getTime() + FUTURE_MS;
    const calendars = await this.db.coaching.find(
      { _id: { $regex: "^calendar:" }, $or: [{ coachUserId: userId }, { "bookings.studentUserId": userId }] },
      { projection: { _id: 0, coachUserId: 1, coachName: 1, bookings: 1 } },
    ).limit(50).toArray();
    /** @type {Parameters<typeof renderIcs>[0]} */
    const events = [];
    for (const calendar of calendars) {
      const isCoach = calendar.coachUserId === userId;
      for (const booking of Array.isArray(calendar.bookings) ? calendar.bookings : []) {
        if (!booking || (!isCoach && booking.studentUserId !== userId)) continue;
        const start = toDate(booking.startAt); const end = toDate(booking.endAt);
        if (!start || !end || start.getTime() < from || start.getTime() > to || typeof booking.id !== "string") continue;
        events.push({
          uid: `${booking.id}@sc2tools.com`, start, end,
          summary: isCoach ? "Coaching session" : `Coaching session with ${String(calendar.coachName || "your coach").slice(0, 60)}`,
          cancelled: booking.status === "cancelled",
          sequence: booking.status === "cancelled" ? 1 : 0,
        });
      }
    }
    return events.sort((a, b) => a.start.getTime() - b.start.getTime()).slice(0, MAX_EVENTS);
  }
}

module.exports = { CalendarFeedService, renderIcs, foldLine, escapeText, hashSecret, calendarExportRecord };
