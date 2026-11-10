"use strict";

const { deliverNotification } = require("./notificationDelivery");

/**
 * Coaching session reminders, 24 hours and 1 hour before a booked
 * session, to both the coach and the student (``coaching.reminder``).
 *
 * Driven by jobs/deliveryJobs.js on the existing in-process timer. The
 * notification delivery key ``coaching:reminder:<booking>:<window>`` makes
 * every sweep idempotent, so overlapping instances or a restart inside
 * the window never send twice. A reminder is skipped when the booking was
 * made after its moment had already passed (booking 3 hours ahead gets
 * the 1-hour reminder only).
 */

const HOUR = 60 * 60 * 1000;
const WINDOWS = [
  { id: "24h", leadMs: 24 * HOUR, title: "Coaching session in 24 hours", body: "Your coaching session starts in about a day." },
  { id: "1h", leadMs: HOUR, title: "Coaching session in 1 hour", body: "Your coaching session starts in about an hour." },
];

/**
 * Which reminder (if any) is due for a booking right now.
 * @param {{startAt?: unknown, createdAt?: unknown, status?: unknown}} booking
 * @param {number} now
 */
function dueReminder(booking, now) {
  if (booking.status !== "booked") return null;
  const start = new Date(String(booking.startAt ?? "")).getTime();
  const created = new Date(String(booking.createdAt ?? "")).getTime();
  if (!Number.isFinite(start) || start <= now) return null;
  // Nearest window first: inside the last hour only the 1-hour reminder applies.
  for (const window of [...WINDOWS].reverse()) {
    if (start - now > window.leadMs) continue;
    if (Number.isFinite(created) && created > start - window.leadMs) return null;
    return window;
  }
  return null;
}

class CoachingRemindersService {
  /**
   * @param {{coaching: import('mongodb').Collection<any>}} db
   * @param {{notifications: import('./notifications').NotificationsService, logger?: import('pino').Logger|null, now?: () => number}} opts
   */
  constructor(db, opts) {
    this.db = db;
    this.notifications = opts.notifications;
    this.logger = opts.logger || null;
    this.now = opts.now || Date.now;
  }

  async sweep() {
    const now = this.now();
    const calendars = await this.db.coaching.find({
      _id: { $regex: "^calendar:" },
      bookings: { $elemMatch: { status: "booked", startAt: { $gt: new Date(now), $lte: new Date(now + WINDOWS[0].leadMs) } } },
    }, { projection: { _id: 0, coachUserId: 1, bookings: 1 } }).limit(500).toArray();
    let sent = 0;
    for (const calendar of calendars) {
      for (const booking of Array.isArray(calendar.bookings) ? calendar.bookings : []) {
        const window = booking && typeof booking.id === "string" ? dueReminder(booking, now) : null;
        if (!window) continue;
        for (const userId of new Set([calendar.coachUserId, booking.studentUserId])) {
          if (typeof userId !== "string" || !userId) continue;
          const key = `coaching:reminder:${booking.id}:${window.id}`;
          const row = await deliverNotification(this.notifications, userId, {
            kind: "coaching.reminder", title: window.title, body: window.body, href: "/coaching", groupKey: key, eventKey: key,
          }, this.logger);
          if (row) sent += 1;
        }
      }
    }
    return { sent };
  }
}

module.exports = { CoachingRemindersService, dueReminder };
