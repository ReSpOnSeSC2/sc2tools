import { describe, expect, it } from "vitest";

import type { AdminEvent } from "./adminTypes";
import {
  mergeAdminEventFeed,
  upsertLiveAdminEvent,
} from "./adminEventFeed";

function signup(
  eventId: string,
  email: string | null = null,
  createdAt = "2026-09-04T12:00:00.000Z",
): AdminEvent {
  return {
    eventId,
    type: "user_signup",
    payload: {
      clerkUserId: `clerk_${eventId}`,
      userId: `user_${eventId}`,
      email,
      source: "first_touch",
    },
    createdAt,
    readAt: null,
  };
}

describe("upsertLiveAdminEvent", () => {
  it("prepends a new event and respects the feed limit", () => {
    const newest = signup("a", null, "2026-09-04T14:00:00.000Z");
    const middle = signup("b", null, "2026-09-04T13:00:00.000Z");
    const oldest = signup("c", null, "2026-09-04T12:00:00.000Z");

    expect(upsertLiveAdminEvent([middle, oldest], newest, 2))
      .toEqual([newest, middle]);
  });

  it("replaces an enriched event in place without duplicating it", () => {
    const current = [signup("a"), signup("b"), signup("c")];
    const enriched = signup("b", "new-user@example.com");

    const next = upsertLiveAdminEvent(current, enriched, 3);

    expect(next).toEqual([signup("a"), enriched, signup("c")]);
    expect(next.filter((event) => event.eventId === "b")).toHaveLength(1);
  });

  it("does not let an old enrichment evict a newer full-buffer event", () => {
    const newest = signup("newest", null, "2026-09-04T15:00:00.000Z");
    const middle = signup("middle", null, "2026-09-04T14:00:00.000Z");
    const oldEnrichment = signup(
      "old",
      "old-user@example.com",
      "2026-09-04T12:00:00.000Z",
    );

    expect(upsertLiveAdminEvent([newest, middle], oldEnrichment, 2))
      .toEqual([newest, middle]);
  });

  it("keeps an enriched old signup in chronological position", () => {
    const newer = signup("newer", null, "2026-09-04T14:00:00.000Z");
    const old = signup("old", null, "2026-09-04T12:00:00.000Z");
    const enrichedOld = signup(
      "old",
      "old-user@example.com",
      "2026-09-04T12:00:00.000Z",
    );

    expect(mergeAdminEventFeed([newer, old], [enrichedOld], 2)).toEqual([
      newer,
      enrichedOld,
    ]);
  });

  it("does not let stale live data erase fetched identity or read state", () => {
    const hydrated = {
      ...signup("same", "known@example.com"),
      readAt: "2026-09-04T13:00:00.000Z",
    };

    const [merged] = mergeAdminEventFeed(
      [hydrated],
      [signup("same")],
      1,
    );

    expect(merged.payload).toMatchObject({ email: "known@example.com" });
    expect(merged.readAt).toBe("2026-09-04T13:00:00.000Z");
  });

  it("keeps an anonymized fetched row ahead of a stale socket copy", () => {
    const scrubbed: AdminEvent = {
      ...signup("deleted"),
      payload: {
        clerkUserId: null,
        userId: "user_deleted",
        email: null,
        source: "first_touch",
      },
      anonymizedAt: "2026-09-04T15:00:00.000Z",
    };
    const stale = signup("deleted", "private@example.com");

    expect(mergeAdminEventFeed([scrubbed], [stale], 1)).toEqual([scrubbed]);
  });

  it("keeps the hydrated install identity when a stale live copy arrives", () => {
    const connected: AdminEvent = {
      eventId: "connected",
      type: "agent_connected",
      payload: {
        userId: "user-1", clerkUserId: "clerk-1", email: null,
        deviceId: "device-1", platform: "windows", version: "0.18.9", source: "heartbeat",
      },
      createdAt: "2026-10-16T12:00:00.000Z",
      readAt: null,
    };
    const hydrated = {
      ...connected,
      payload: { ...connected.payload, email: "installed@example.com" },
    };

    const [merged] = mergeAdminEventFeed([hydrated], [connected], 1);

    expect(merged.payload).toMatchObject({ email: "installed@example.com", source: "heartbeat" });
    expect(merged.createdAt).toBe(connected.createdAt);
  });

  it("keeps a resolved install account id before its email is available", () => {
    const connected: AdminEvent = {
      eventId: "connected-without-email", type: "agent_connected",
      payload: {
        userId: "user-1", clerkUserId: null, email: null,
        deviceId: "device-1", platform: "windows", version: null, source: "heartbeat",
      },
      createdAt: "2026-10-16T12:00:00.000Z", readAt: null,
    };
    const hydrated = {
      ...connected, payload: { ...connected.payload, clerkUserId: "clerk-1" },
    };
    expect(mergeAdminEventFeed([hydrated], [connected], 1)[0].payload)
      .toMatchObject({ email: null, clerkUserId: "clerk-1" });
  });
});
