"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import useSWR from "swr";

import { Card } from "@/components/ui/Card";
import { apiCall, useApi, API_BASE } from "@/lib/clientApi";
import { ForbiddenCard, LoadingRows } from "../components/AdminFragments";
import { AdminEventRow } from "../components/AdminEventRow";
import { useAdminEventsSocket } from "../components/useAdminEventsSocket";
import type {
  AdminEvent,
  AdminEventCountsResp,
  AdminEventsListResp,
  AdminEventType,
} from "../components/adminTypes";

const PAGE_SIZE = 50;
type Filter = "all" | AdminEventType;

const FILTER_LABEL: Record<Filter, string> = {
  all: "All",
  user_signup: "Signups",
  agent_download: "Downloads",
  user_message: "Messages",
};

/**
 * /admin/notifications — full chronological feed of signup +
 * agent-download events with a filter toggle and a "mark all read"
 * action. Reuses the dashboard's Socket.io subscription to splice
 * brand-new events onto the top of the list the moment they land.
 */
export default function AdminNotificationsPage() {
  const { getToken } = useAuth();
  const [filter, setFilter] = useState<Filter>("all");
  const [before, setBefore] = useState<string | null>(null);
  const [pageHistory, setPageHistory] = useState<Array<string | null>>([null]);
  const [liveEvents, setLiveEvents] = useState<AdminEvent[]>([]);
  const [markingRead, setMarkingRead] = useState(false);

  const params = new URLSearchParams();
  params.set("limit", String(PAGE_SIZE));
  if (filter !== "all") params.set("type", filter);
  if (before) params.set("before", before);
  const path = `/v1/admin/events?${params.toString()}`;

  const { data, error, isLoading, mutate } = useApi<AdminEventsListResp>(path);
  const counts = useSWR<AdminEventCountsResp>(
    "/v1/admin/events/counts",
    () => apiCall<AdminEventCountsResp>(getToken, "/v1/admin/events/counts"),
  );

  useAdminEventsSocket(
    useCallback(
      (event: AdminEvent) => {
        // Only splice when we're on the first page and the filter
        // matches; otherwise the cursor would jump unexpectedly.
        if (before !== null) return;
        if (filter !== "all" && event.type !== filter) return;
        setLiveEvents((prev) => {
          if (prev.some((e) => e.eventId === event.eventId)) return prev;
          return [event, ...prev].slice(0, PAGE_SIZE);
        });
        counts.mutate();
      },
      [before, filter, counts],
    ),
  );

  useEffect(() => {
    setLiveEvents([]);
  }, [filter, before]);

  const merged = useMemo(() => {
    if (!data) return null;
    if (liveEvents.length === 0) return data.items;
    const seen = new Set<string>();
    const out: AdminEvent[] = [];
    for (const e of liveEvents) {
      if (seen.has(e.eventId)) continue;
      seen.add(e.eventId);
      out.push(e);
    }
    for (const e of data.items) {
      if (seen.has(e.eventId)) continue;
      seen.add(e.eventId);
      out.push(e);
    }
    return out.slice(0, PAGE_SIZE);
  }, [data, liveEvents]);

  async function markAllRead() {
    if (markingRead) return;
    setMarkingRead(true);
    try {
      await apiCall(getToken, "/v1/admin/events/mark-read", { method: "POST" });
      await Promise.all([mutate(), counts.mutate()]);
    } finally {
      setMarkingRead(false);
    }
  }

  function nextPage() {
    if (data?.nextBefore) {
      setPageHistory((h) => [...h, data.nextBefore]);
      setBefore(data.nextBefore);
    }
  }
  function prevPage() {
    if (pageHistory.length <= 1) return;
    const popped = pageHistory.slice(0, -1);
    setPageHistory(popped);
    setBefore(popped[popped.length - 1] ?? null);
  }

  if (error && error.status === 403) return <ForbiddenCard />;

  const unread = counts.data?.unreadCount ?? 0;

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold">Notifications</h1>
          <p className="text-text-muted">
            Live feed of new signups, agent downloads, and user messages.
            Updates in real time while this page is open.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-secondary text-sm disabled:cursor-not-allowed disabled:opacity-50"
          onClick={markAllRead}
          disabled={markingRead || unread === 0}
        >
          {markingRead
            ? "Working…"
            : unread === 0
              ? "All caught up"
              : `Mark ${unread} as read`}
        </button>
      </header>

      <Card padded>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-caption font-semibold uppercase tracking-wider text-text-dim">
            Filter
          </span>
          {(
            ["all", "user_signup", "agent_download", "user_message"] as Filter[]
          ).map((f) => {
            const isActive = filter === f;
            return (
              <button
                key={f}
                type="button"
                onClick={() => {
                  setFilter(f);
                  setBefore(null);
                  setPageHistory([null]);
                }}
                className={[
                  "rounded-full border px-3 py-1 text-caption transition-colors",
                  isActive
                    ? "border-accent-cyan/60 bg-accent-cyan/15 text-text"
                    : "border-border bg-bg-surface text-text-muted hover:bg-bg-elevated hover:text-text",
                ].join(" ")}
              >
                {FILTER_LABEL[f]}
              </button>
            );
          })}
        </div>
      </Card>

      {isLoading && !merged ? (
        <LoadingRows rows={8} />
      ) : error ? (
        <Card padded>
          <p className="text-danger">
            Failed to load events: {error.message}
          </p>
        </Card>
      ) : !merged || merged.length === 0 ? (
        <Card padded>
          <p className="text-text-muted">
            No events yet. New signups, agent downloads, and user messages
            will appear here as they happen.
          </p>
        </Card>
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-border">
            {merged.map((event) => (
              <AdminEventRow
                key={event.eventId}
                event={event}
                unread={!event.readAt}
              />
            ))}
          </ul>
        </Card>
      )}

      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          className="btn btn-secondary text-sm disabled:cursor-not-allowed disabled:opacity-50"
          disabled={pageHistory.length <= 1}
          onClick={prevPage}
        >
          ← Newer
        </button>
        <span className="text-caption text-text-dim">
          {merged?.length ?? 0} on this page
        </span>
        <button
          type="button"
          className="btn btn-secondary text-sm disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!data?.nextBefore}
          onClick={nextPage}
        >
          Older →
        </button>
      </div>

      {/* Hint about the live API_BASE so admins can verify the
          environment when triaging in a staging deployment. */}
      <p className="text-caption text-text-dim">
        Source: <code className="font-mono text-text-muted">{API_BASE}/v1/admin/events</code>
      </p>
    </div>
  );
}
