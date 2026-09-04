import type { AdminEvent, AdminEventSignupPayload } from "./adminTypes";

/**
 * Add a new live event or replace an enriched copy of one already in the feed.
 * Reconcile and cap chronologically so an old enrichment cannot evict a newer
 * socket-only row before the fetched and live feeds are merged.
 */
export function upsertLiveAdminEvent(
  current: readonly AdminEvent[],
  incoming: AdminEvent,
  limit: number,
): AdminEvent[] {
  return mergeAdminEventFeed(current, [incoming], limit);
}

/**
 * Reconcile fetched rows with socket updates without letting an enrichment
 * make an older event look new. The feed remains ordered by the event's
 * original creation time, while irreversible read/anonymization state and a
 * newly resolved signup email survive a stale copy of the same event.
 */
export function mergeAdminEventFeed(
  fetched: readonly AdminEvent[],
  live: readonly AdminEvent[],
  limit: number,
): AdminEvent[] {
  const byId = new Map<
    string,
    { event: AdminEvent; firstSeen: number }
  >();
  let firstSeen = 0;

  for (const event of [...fetched, ...live]) {
    const existing = byId.get(event.eventId);
    if (!existing) {
      byId.set(event.eventId, { event, firstSeen });
      firstSeen += 1;
      continue;
    }
    existing.event = reconcileAdminEvent(existing.event, event);
  }

  return [...byId.values()]
    .sort((a, b) => {
      const byCreatedAt = eventTimestamp(b.event) - eventTimestamp(a.event);
      return byCreatedAt || a.firstSeen - b.firstSeen;
    })
    .slice(0, limit)
    .map(({ event }) => event);
}

function reconcileAdminEvent(
  existing: AdminEvent,
  incoming: AdminEvent,
): AdminEvent {
  // Anonymization is irreversible. Never let a delayed socket payload put
  // identity data back into a row refreshed after account deletion.
  if (existing.anonymizedAt) return existing;
  if (incoming.anonymizedAt) return incoming;

  const next: AdminEvent = {
    ...existing,
    ...incoming,
    // Mark-all-read is also irreversible, while an older socket copy can
    // still carry readAt: null.
    readAt: incoming.readAt || existing.readAt,
  };

  if (existing.type === "user_signup" && incoming.type === "user_signup") {
    const oldPayload = existing.payload as AdminEventSignupPayload;
    const newPayload = incoming.payload as AdminEventSignupPayload;
    next.payload = {
      ...oldPayload,
      ...newPayload,
      email: newPayload.email || oldPayload.email,
    };
  }

  return next;
}

function eventTimestamp(event: AdminEvent): number {
  const value = Date.parse(event.createdAt);
  return Number.isFinite(value) ? value : 0;
}
