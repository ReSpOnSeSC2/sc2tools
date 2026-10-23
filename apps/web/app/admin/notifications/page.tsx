"use client";
import { AdminLiveStatus } from "../components/AdminLiveStatus";
import { useRealtimeStatus } from "@/components/realtime/RealtimeProvider";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { RequestError } from "@/components/ui/RequestError";
import { useAdminQueryState } from "../components/useAdminQueryState";
import { useAdminCursor } from "../components/useAdminCursor";
import { AdminPagination } from "@/app/admin/components/AdminPagination";
import { Button } from "@/components/ui/Button";
import { AdminPageHeader } from "@/app/admin/components/AdminPageHeader";

import { Suspense, useCallback, useState } from "react";
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
  job_overdue: "Jobs",
};

/**
 * /admin/notifications — full chronological feed of signup +
 * agent download and connection events with a filter toggle and a "mark all read"
 * action. Socket.io invalidations refresh durable rows when activity arrives
 * or the socket reconnects; polling recovers updates missed while offline.
 */
function NotificationsBody() {
  const { getToken } = useAuth();
  const realtime = useRealtimeStatus();
  const [view, setView] = useAdminQueryState({ type: "all", unread: true, before: "" }, { allowed: { type: Object.keys(FILTER_LABEL) } });
  const filter = view.type as Filter, unreadOnly = view.unread, before = view.before;
  const setFilter = (type: Filter) => setView({ type });
  const setUnreadOnly = (unread: boolean) => setView({ unread });
  const paging = useAdminCursor(before, before => setView({ before }));
  const [markingRead, setMarkingRead] = useState(false);

  const params = new URLSearchParams();
  params.set("limit", String(PAGE_SIZE));
  if (unreadOnly) params.set("unread", "true");
  if (filter !== "all") params.set("type", filter);
  if (before) params.set("before", before);
  const path = `/v1/admin/events?${params.toString()}`;

  const { data, error, isLoading, isValidating, mutate } = useApi<AdminEventsListResp>(path, {
    refreshInterval: 60000, keepPreviousData: true,
  });
  const counts = useApi<AdminEventCountsResp>("/v1/admin/events/counts", {
    refreshInterval: 60000, keepPreviousData: true,
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

  if (error && error.status === 403) return <ForbiddenCard />;

  const unread = counts.data?.unreadCount ?? 0;
  const emptyType = filter === "all" ? "notifications" : FILTER_LABEL[filter].toLowerCase();

  function resetPage() { setView({ before: "" }); }

  return (
    <div className="space-y-6">
      <AdminPageHeader anchor="notifications-and-support-inbox" title="Notifications" description="Triage activity and support messages." actions={<><AdminLiveStatus onRefresh={() => { void mutate(); void counts.mutate(); }} data={data} /><Button variant="secondary" size="sm"
          type="button"

          onClick={markAllRead}
          disabled={markingRead || unread === 0}
        >
          {markingRead
            ? "Working…"
            : unread === 0
              ? "All caught up"
              : `Mark all ${unread} unread as read`}
        </Button></>} />
      <details className="text-caption text-text-muted"><summary>Learn more</summary><p className="text-text-muted">
            Live feed of new signups, agent downloads, confirmed installs, and user messages.
            {realtime.status === "connected" ? "Updates in real time while this page is open." : "Refresh now or wait for the next automatic check while live updates reconnect."}
          </p></details>
      <p className="text-caption text-text-muted">{unread} unread across all activity.{data && isValidating ? <span role="status" className="ml-2">Updating…</span> : null}</p>

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
            <Button variant="secondary" size="sm" key={String(onlyUnread)} type="button" aria-pressed={unreadOnly === onlyUnread}
              onClick={() => { setUnreadOnly(onlyUnread); resetPage(); }}
              className={[
                "rounded-full border px-3 py-1 text-caption transition-colors",
                unreadOnly === onlyUnread ? "border-accent-cyan/60 bg-accent-cyan/15 text-text"
                  : "border-border bg-bg-surface text-text-muted hover:bg-bg-elevated hover:text-text",
              ].join(" ")}>
              {onlyUnread ? "Unread" : "All activity"}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-caption font-semibold uppercase tracking-wider text-text-dim">
            Filter
          </span>
          {(
            ["all", "user_signup", "agent_download", "agent_connected", "user_message", "backup_stale", "job_overdue"] as Filter[]
          ).map((f) => {
            const isActive = filter === f;
            return (
              <Button variant="secondary" size="sm"
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
              </Button>
            );
          })}
        </div>
      </Card>

      {isLoading && !data ? (
        <LoadingRows rows={8} />
      ) : error ? (
        <RequestError error={error} onRetry={() => mutate()} />
      ) : items.length === 0 ? (
        <Card padded>
          <EmptyStatePanel title="No activity in this view" description={unreadOnly ? `No unread ${emptyType}${filter !== "all" ? " in this filter" : before ? " on this page" : ""}.` : `No ${emptyType} in this view.`} action={<div className="flex flex-wrap gap-2">{unreadOnly && unread > 0 ? <Button variant="secondary" onClick={() => { setFilter("all"); resetPage(); void mutate(); }}>View all {unread} unread notifications</Button> : null}<Button variant="secondary" onClick={() => { setUnreadOnly(false); setFilter("all"); resetPage(); void mutate(); }}>View all activity</Button></div>} />

        </Card>
      ) : (
        <Card padded={false}>
          <ul aria-busy={isValidating} className={`divide-y divide-border transition-opacity ${isValidating ? "opacity-60" : ""}`}>
            {items.map((event) => (
              <AdminEventRow
                key={event.eventId}
                event={event}
                onReportUpdated={() => mutate()}
                unread={!event.readAt}
              />
            ))}
          </ul>
        </Card>
      )}

      <AdminPagination hasPrev={paging.hasPrev} prevLabel={paging.prevLabel} hasNext={!!data?.nextBefore} onPrev={paging.previous} onNext={() => paging.next(data?.nextBefore || "")} label={paging.page} loading={isValidating} itemCount={data?.items.length || 0} />

      {/* Hint about the live API_BASE so admins can verify the
          environment when triaging in a staging deployment. */}
      <p className="text-caption text-text-dim">
        Source: <code className="font-mono text-text-muted">{API_BASE}/v1/admin/events</code>
      </p>
    </div>
  );
}

export default function AdminNotificationsPage() { return <Suspense fallback={<LoadingRows rows={8} />}><NotificationsBody /></Suspense>; }
