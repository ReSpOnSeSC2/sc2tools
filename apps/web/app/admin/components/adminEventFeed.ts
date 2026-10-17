import type {
  AdminEvent,
  AdminEventAgentConnectedPayload,
  AdminEventSignupPayload,
} from "./adminTypes";

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
 * newly resolved account email survive a stale copy of the same event.
 */
export function mergeAdminEventFeed(
  fetched: readonly AdminEvent[],
  live: readonly AdminEvent[],
  limit: number,
): AdminEvent[] {
  const byId = new Map<string, AdminEvent>();

  for (const event of [...fetched, ...live]) {
    const existing = byId.get(event.eventId);
    if (!existing) {
      byId.set(event.eventId, event);
      continue;
    }
    byId.set(event.eventId, reconcileAdminEvent(existing, event));
  }

  return [...byId.values()]
    .sort((a, b) => {
      const byCreatedAt = eventTimestamp(b) - eventTimestamp(a);
      // Match the API's keyset order, including events sharing a timestamp.
      return byCreatedAt || (a.eventId > b.eventId ? -1 : a.eventId < b.eventId ? 1 : 0);
    })
    .slice(0, limit);
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

  if (
    existing.type === incoming.type &&
    (existing.type === "user_signup" || existing.type === "agent_connected")
  ) {
    const oldPayload = existing.payload as AdminEventSignupPayload | AdminEventAgentConnectedPayload;
    const newPayload = incoming.payload as AdminEventSignupPayload | AdminEventAgentConnectedPayload;
    next.payload = {
      ...oldPayload,
      ...newPayload,
      email: newPayload.email || oldPayload.email,
      clerkUserId: newPayload.clerkUserId || oldPayload.clerkUserId,
    };
  }

  return next;
}

function eventTimestamp(event: AdminEvent): number {
  const value = Date.parse(event.createdAt);
  return Number.isFinite(value) ? value : 0;
}
