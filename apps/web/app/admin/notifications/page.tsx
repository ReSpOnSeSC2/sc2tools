"use client";

import { useCallback, useState } from "react";
import { useAuth } from "@clerk/nextjs";

import { Card } from "@/components/ui/Card";
import { apiCall, useApi, API_BASE } from "@/lib/clientApi";
import { ForbiddenCard, LoadingRows } from "../components/AdminFragments";
import { AdminEventRow } from "../components/AdminEventRow";
import { useAdminEventsSocket } from "../components/useAdminEventsSocket";
import type {
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
  agent_connected: "Installs",
  user_message: "Messages",
  backup_stale: "Backups",
};

/**
 * /admin/notifications — full chronological feed of signup +
 * agent download and connection events with a filter toggle and a "mark all read"
 * action. Socket.io invalidations refresh durable rows when activity arrives
 * or the socket reconnects; polling recovers updates missed while offline.
 */
export default function AdminNotificationsPage() {
  const { getToken } = useAuth();
  const [filter, setFilter] = useState<Filter>("all");
  const [unreadOnly, setUnreadOnly] = useState(true);
  const [before, setBefore] = useState<string | null>(null);
  const [pageHistory, setPageHistory] = useState<Array<string | null>>([null]);
  const [markingRead, setMarkingRead] = useState(false);

  const params = new URLSearchParams();
  params.set("limit", String(PAGE_SIZE));
  if (unreadOnly) params.set("unread", "true");
  if (filter !== "all") params.set("type", filter);
  if (before) params.set("before", before);
  const path = `/v1/admin/events?${params.toString()}`;

  const { data, error, isLoading, isValidating, mutate } = useApi<AdminEventsListResp>(path, {
    refreshInterval: 60000,
  });
  const counts = useApi<AdminEventCountsResp>("/v1/admin/events/counts", {
    refreshInterval: 60000,
  });

  useAdminEventsSocket(
    useCallback(
      () => {
        counts.mutate();
        // REST rows and their cursor remain authoritative. Keeping a separate
        // capped socket list could skip an evicted boundary row, or retain a
        // now-read row after another admin's mark-all-read action.
        void mutate();
      },
      [counts, mutate],
    ),
    useCallback(() => {
      void mutate();
      void counts.mutate();
    }, [mutate, counts]),
  );

  const items = data?.items || [];

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
  const emptyType = filter === "all" ? "notifications" : FILTER_LABEL[filter].toLowerCase();

  function resetPage() {
    setBefore(null);
    setPageHistory([null]);
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold">Notifications</h1>
          <p className="text-text-muted">
            Live feed of new signups, agent downloads, confirmed installs, and user messages.
            Updates in real time while this page is open.
          </p>
          <p className="text-caption text-text-muted">
            {unread} unread across all activity.
          </p>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-2 hard-press rounded-full px-5 py-[0.55rem] font-display font-bold border-2 border-line bg-bg-surface text-text hover:bg-bg-elevated text-sm disabled:cursor-not-allowed disabled:opacity-50"
          onClick={markAllRead}
          disabled={markingRead || unread === 0}
        >
          {markingRead
            ? "Working…"
            : unread === 0
              ? "All caught up"
              : `Mark all ${unread} unread as read`}
        </button>
      </header>

      {counts.data?.supportEmail ? (
        <p className="rounded-lg border border-border bg-bg-surface px-4 py-3 text-caption text-text-muted"
          role={counts.data.supportEmail.errorCode ? "alert" : "status"}>
          {!counts.data.supportEmail.configured
            ? "Email import is not configured. Direct support email will appear in Messages once Gmail import is enabled."
            : counts.data.supportEmail.errorCode
              ? `Support email import failed (${counts.data.supportEmail.errorCode}). The next poll will retry.`
              : counts.data.supportEmail.lastSuccessAt
                ? `Support email import is enabled. Last checked ${new Date(counts.data.supportEmail.lastSuccessAt).toLocaleString()}.`
                : "Support email import is enabled. Waiting for the first successful check."}
          {counts.data.supportEmail.configured ? (
            <> Only email labeled <strong>{counts.data.supportEmail.labelName || "SC2Tools Support"}</strong> is imported.</>
          ) : null}
        </p>
      ) : null}

      <Card padded>
        <div className="mb-4 flex flex-wrap items-center gap-2" aria-label="Notification view">
          <span className="text-caption font-semibold uppercase tracking-wider text-text-dim">View</span>
          {[true, false].map((onlyUnread) => (
            <button key={String(onlyUnread)} type="button" aria-pressed={unreadOnly === onlyUnread}
              onClick={() => { setUnreadOnly(onlyUnread); resetPage(); }}
              className={[
                "rounded-full border px-3 py-1 text-caption transition-colors",
                unreadOnly === onlyUnread ? "border-accent-cyan/60 bg-accent-cyan/15 text-text"
                  : "border-border bg-bg-surface text-text-muted hover:bg-bg-elevated hover:text-text",
              ].join(" ")}>
              {onlyUnread ? "Unread" : "All activity"}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-caption font-semibold uppercase tracking-wider text-text-dim">
            Filter
          </span>
          {(
            ["all", "user_signup", "agent_download", "agent_connected", "user_message", "backup_stale"] as Filter[]
          ).map((f) => {
            const isActive = filter === f;
            return (
              <button
                key={f}
                type="button"
                onClick={() => {
                  setFilter(f);
                  resetPage();
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

      {isLoading && !data ? (
        <LoadingRows rows={8} />
      ) : error ? (
        <Card padded>
          <p className="text-danger">
            Failed to load events: {error.message}
          </p>
        </Card>
      ) : items.length === 0 ? (
        <Card padded>
          <p className="text-text-muted">
            {unreadOnly ? `No unread ${emptyType}${filter !== "all" ? " in this filter" : before ? " on this page" : ""}.`
              : `No ${emptyType} in this view.`}
          </p>
          {unreadOnly && unread > 0 ? (
            <button type="button" className="mt-3 text-caption text-accent-cyan underline-offset-2 hover:underline"
              onClick={() => { setFilter("all"); resetPage(); void mutate(); }}>
              View all {unread} unread notifications
            </button>
          ) : unreadOnly ? (
            <button type="button" className="mt-3 text-caption text-accent-cyan underline-offset-2 hover:underline"
              onClick={() => { setUnreadOnly(false); resetPage(); }}>
              View all activity
            </button>
          ) : null}
        </Card>
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-border">
            {items.map((event) => (
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
          className="inline-flex items-center gap-2 hard-press rounded-full px-5 py-[0.55rem] font-display font-bold border-2 border-line bg-bg-surface text-text hover:bg-bg-elevated text-sm disabled:cursor-not-allowed disabled:opacity-50"
          disabled={pageHistory.length <= 1}
          onClick={prevPage}
        >
          ← Newer
        </button>
        <span className="text-caption text-text-dim">
          {items.length} on this page
        </span>
        <button
          type="button"
          className="inline-flex items-center gap-2 hard-press rounded-full px-5 py-[0.55rem] font-display font-bold border-2 border-line bg-bg-surface text-text hover:bg-bg-elevated text-sm disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!data?.nextBefore || isValidating}
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
