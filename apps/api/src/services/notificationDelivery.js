"use strict";

/** Notifications must not turn a committed primary action into a failed action.
 * @param {import('./notifications').NotificationsService|null|undefined} service
 * @param {string|null|undefined} userId @param {any} input @param {import('pino').Logger|null|undefined} logger */
async function deliverNotification(service, userId, input, logger) {
  if (!service || !userId) return null;
  try { return await service.notify(userId, input); }
  catch (err) { logger?.warn({ err, kind: input.kind }, "notification_delivery_failed"); return null; }
}

/** @param {any} service @param {string|null|undefined} userId @param {any} payload @param {any} logger */
async function deliverCoachingNotification(service, userId, payload, logger) {
  const id = payload.bookingId || payload.assignmentId || payload.shareId;
  if (!id || !payload.kind) return;
  /** @type {Record<string,string>} */
  const titles = {
    booked: "A coaching session was booked", cancelled: "A coaching session was cancelled",
    assigned: "You have a new practice assignment", practice_sharing_requested: "Your coach requested practice sharing",
    practice_sharing_accepted: "Practice sharing was accepted", practice_sharing_rejected: "Practice sharing was declined",
    practice_sharing_revoked: "Practice sharing was revoked",
  };
  await deliverNotification(service, userId, { kind: `coaching.${payload.kind}`,
    title: titles[payload.kind] || "Your coaching plan changed", href: "/coaching",
    groupKey: `coaching:${payload.kind}:${id}`, eventKey: `coaching:${payload.kind}:${id}` }, logger);
}

module.exports = { deliverNotification, deliverCoachingNotification };
