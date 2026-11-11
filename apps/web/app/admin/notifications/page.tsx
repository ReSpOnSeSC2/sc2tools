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
import { useSearchParams } from "next/navigation";
import { useAuth } from "@clerk/nextjs";

import { Card } from "@/components/ui/Card";
import { apiCall, useApi, API_BASE } from "@/lib/clientApi";
import { ForbiddenCard, LoadingRows } from "../components/AdminFragments";
import { AdminEventRow } from "../components/AdminEventRow";
import { useAdminEventsSocket } from "../components/useAdminEventsSocket";
import type {
  AdminEventCountsResp,
  AdminEventReadResp,
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
const FILTERS = Object.keys(FILTER_LABEL) as Filter[];

/** What one type's mark-all names: "Mark 3 messages read". */
const TYPE_NOUN: Record<AdminEventType, [one: string, many: string]> = {
  user_signup: ["signup", "signups"],
  agent_download: ["download", "downloads"],
  agent_connected: ["install", "installs"],
  user_message: ["message", "messages"],
  backup_stale: ["backup alert", "backup alerts"],
  job_overdue: ["job alert", "job alerts"],
};

function markAllLabel(filter: Filter, count: number): string {
  if (count === 0) return "All caught up";
  if (filter === "all") return `Mark all ${count} read`;
  const [one, many] = TYPE_NOUN[filter];
  return `Mark ${count} ${count === 1 ? one : many} read`;
}

/**
 * /admin/notifications — full chronological feed of signup +
 * agent download and connection events with a filter toggle and a "mark all read"
 * action. Socket.io invalidations refresh durable rows when activity arrives
 * or the socket reconnects; polling recovers updates missed while offline.
 */
function NotificationsBody() {
  const { getToken } = useAuth();
  const realtime = useRealtimeStatus();
  const [view, setView] = useAdminQueryState({ type: "all", unread: true, before: "", userId: "" }, { allowed: { type: Object.keys(FILTER_LABEL) } });
  const filter = view.type as Filter, unreadOnly = view.unread, before = view.before;
  const setFilter = (type: Filter) => setView({ type });
  const setUnreadOnly = (unread: boolean) => setView({ unread });
  const paging = useAdminCursor(before, before => setView({ before }));
  const debug = useSearchParams().get("debug") === "1";
  const [markingRead, setMarkingRead] = useState(false);
  const [markError, setMarkError] = useState<Filter | null>(null);

  const params = new URLSearchParams();
  params.set("limit", String(PAGE_SIZE));
  if (unreadOnly) params.set("unread", "true");
  if (filter !== "all") params.set("type", filter);
  if (before) params.set("before", before);
  if (view.userId) params.set("userId", view.userId);
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
    if (markingRead || view.userId) return;
    setMarkingRead(true);
    setMarkError(null);
    try {
      await apiCall(getToken, "/v1/admin/events/mark-read", {
        method: "POST", ...(filter !== "all" ? { body: JSON.stringify({ type: filter }) } : {}),
      });
      await Promise.allSettled([mutate(), counts.mutate()]);
    } catch {
      setMarkError(filter);
    } finally {
      setMarkingRead(false);
    }
  }

  // One row's read state. The saved row replaces the cached one without a
  // refetch (an Unread view keeps the row in place until the next refresh),
  // and the shared counts revalidate so the sidebar badge updates here too.
  // A count refresh failure never turns a saved change into a rollback.
  const setEventRead = useCallback(async (eventId: string, read: boolean) => {
    const saved = await apiCall<AdminEventReadResp>(getToken, `/v1/admin/events/${encodeURIComponent(eventId)}/${read ? "read" : "unread"}`, { method: "POST" });
    void Promise.allSettled([
      mutate((current) => current && { ...current, items: current.items.map((item) => item.eventId === eventId ? { ...item, readAt: saved.event.readAt } : item) }, { revalidate: false }),
      counts.mutate(),
    ]);
  }, [getToken, mutate, counts]);

  if (error && error.status === 403) return <ForbiddenCard />;

  const unread = counts.data?.unreadCount ?? 0;
  const byType = counts.data?.unreadByType;
  const scopedUnread = filter === "all" ? unread : byType?.[filter] ?? 0;
  const emptyType = filter === "all" ? "notifications" : FILTER_LABEL[filter].toLowerCase();

  function resetPage() { setView({ before: "" }); }

  return (
    <div className="space-y-6">
      {view.userId ? <div className="flex flex-wrap items-center gap-2 text-caption"><span className="break-all">Activity for user {view.userId}</span><Button size="sm" variant="ghost" onClick={() => setView({ userId: "" })}>Clear user filter</Button></div> : null}
      <AdminPageHeader anchor="notifications-and-support-inbox" title="Notifications" description="Triage activity and support messages." actions={<><AdminLiveStatus onRefresh={() => { void mutate(); void counts.mutate(); }} data={data} /><Button variant="secondary" size="sm"
          type="button"

          onClick={markAllRead}
          disabled={markingRead || scopedUnread === 0 || !!view.userId}
        >
          {markingRead ? "Working…" : markAllLabel(filter, scopedUnread)}
        </Button></>} />
      {markError === filter && !view.userId ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-caption text-text">
          <span>Couldn&apos;t mark {filter === "all" ? "activity" : FILTER_LABEL[filter].toLowerCase()} read. Try again.</span>
          <Button size="sm" variant="secondary" onClick={() => { void markAllRead(); }} loading={markingRead}>Retry</Button>
        </div>
      ) : null}
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
          {FILTERS.map((f) => {
            const isActive = filter === f;
            const count = f === "all" ? unread : byType?.[f] ?? 0;
            return (
              <Button variant="secondary" size="sm"
                key={f}
                type="button"
                aria-pressed={isActive}
                aria-label={count > 0 ? `${FILTER_LABEL[f]}, ${count} unread` : undefined}
                onClick={() => {
                  setFilter(f);
                  resetPage();
                  setMarkError(null);
                }}
                className={[
                  "rounded-full border px-3 py-1 text-caption transition-colors",
                  isActive
                    ? "border-accent-cyan/60 bg-accent-cyan/15 text-text"
                    : "border-border bg-bg-surface text-text-muted hover:bg-bg-elevated hover:text-text",
                ].join(" ")}
              >
                {FILTER_LABEL[f]}
                {count > 0 ? <span aria-hidden="true" className="ml-1.5 rounded-full bg-bg-elevated px-1.5 text-micro tabular-nums text-text">{count > 99 ? "99+" : count}</span> : null}
              </Button>
            );
          })}
        </div>
      </Card>

      {error && data ? <RequestError error={error} onRetry={() => mutate()} /> : null}
      {isLoading && !data ? (
        <LoadingRows rows={8} />
      ) : error && !data ? (
        <RequestError error={error} onRetry={() => mutate()} />
      ) : items.length === 0 ? (
        <Card padded>
          <EmptyStatePanel title={unreadOnly ? `No unread ${emptyType}` : `No ${emptyType}`} description={unreadOnly ? `No unread ${emptyType}${filter !== "all" ? " in this filter" : before ? " on this page" : ""}.` : `No ${emptyType} in this view.`} action={<div className="flex flex-wrap gap-2">{unreadOnly && unread > 0 ? <Button variant="secondary" onClick={() => { setFilter("all"); resetPage(); void mutate(); }}>View all {unread} unread notifications</Button> : null}<Button variant="secondary" onClick={() => { setUnreadOnly(false); setFilter("all"); resetPage(); void mutate(); }}>View all activity</Button></div>} />

        </Card>
      ) : (
        <Card padded={false}>
          <ul aria-busy={isValidating} className={`divide-y divide-border transition-opacity ${isValidating ? "opacity-60" : ""}`}>
            {items.map((event) => (
              <AdminEventRow
                key={event.eventId}
                event={event}
                onReportUpdated={() => mutate()}
                onSetRead={(read) => setEventRead(event.eventId, read)}
                unread={!event.readAt}
              />
            ))}
          </ul>
        </Card>
      )}

      {items.length > 0 ? <AdminPagination hasPrev={paging.hasPrev} prevLabel={paging.prevLabel} hasNext={!!data?.nextBefore} onPrev={paging.previous} onNext={() => paging.next(data?.nextBefore || "")} label={paging.page} loading={isValidating} itemCount={items.length} /> : null}

      {/* The live API_BASE, for verifying a staging deployment; ?debug=1 only. */}
      {debug ? <p className="text-caption text-text-dim">
        Source: <code className="font-mono text-text-muted">{API_BASE}/v1/admin/events</code>
      </p> : null}
    </div>
  );
}

export default function AdminNotificationsPage() { return <Suspense fallback={<LoadingRows rows={8} />}><NotificationsBody /></Suspense>; }
