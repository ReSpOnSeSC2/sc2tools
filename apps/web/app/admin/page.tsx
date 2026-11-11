"use client";
import { AdminLiveStatus } from "./components/AdminLiveStatus";
import { RequestError } from "@/components/ui/RequestError";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";
import { AdminPageHeader } from "@/app/admin/components/AdminPageHeader";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";

import { useApi, type ClientApiError } from "@/lib/clientApi";
import { Card } from "@/components/ui/Card";
import {
  compactNumber,
  formatBytes,
} from "./components/format";
import { ForbiddenCard, LoadingRows, MetricStat } from "./components/AdminFragments";
import { AdminEventRow } from "./components/AdminEventRow";
import {
  mergeAdminEventFeed,
  upsertLiveAdminEvent,
} from "./components/adminEventFeed";
import { useAdminEventsSocket } from "./components/useAdminEventsSocket";
import { AdminNeedsAttention } from "./components/AdminNeedsAttention";
import { AdminDailyActivity } from "./components/AdminDailyActivity";
import { weekOverWeek } from "./components/adminDailyEvents";
import type {
  AdminDailyEvent,
  AdminDailyEventsResp,
  AdminEvent,
  AdminEventCountsResp,
  AdminEventsListResp,
  AdminStorageSummary,
} from "./components/adminTypes";

const RECENT_FEED_SIZE = 8;

export default function AdminDashboardPage() {
  const { userId } = useAuth();
  const counts = useApi<AdminEventCountsResp>("/v1/admin/events/counts", { refreshInterval: 60000 });
  const recent = useApi<AdminEventsListResp>(
    `/v1/admin/events?limit=${RECENT_FEED_SIZE}`,
    { refreshInterval: 60000 },
  );
  const storage = useApi<AdminStorageSummary>("/v1/admin/storage-summary");
  const daily = useApi<AdminDailyEventsResp>("/v1/admin/events/daily?days=30", { refreshInterval: 60_000 });
  const refreshCounts = counts.mutate;
  const refreshRecent = recent.mutate;
  const refreshDaily = daily.mutate;

  const [liveEvents, setLiveEvents] = useState<AdminEvent[]>([]);
  useEffect(() => { setLiveEvents([]); }, [userId]);

  useAdminEventsSocket(
    useCallback(
      (event: AdminEvent) => {
        setLiveEvents((prev) =>
          upsertLiveAdminEvent(prev, event, RECENT_FEED_SIZE),
        );
        void refreshCounts();
        if (event.type === "user_signup" || event.type === "agent_download" || event.type === "agent_connected") void refreshDaily();
      },
      [refreshCounts, refreshDaily],
    ),
    useCallback(() => {
      void refreshRecent();
      void refreshCounts();
      void refreshDaily();
    }, [refreshRecent, refreshCounts, refreshDaily]),
  );

  const merged = useMemo<AdminEvent[]>(() => {
    const base = recent.data?.items || [];
    return mergeAdminEventFeed(base, liveEvents, RECENT_FEED_SIZE);
  }, [recent.data, liveEvents]);

  const forbidden =
    counts.error?.status === 403 ||
    recent.error?.status === 403 ||
    storage.error?.status === 403 ||
    daily.error?.status === 403;
  if (forbidden) return <ForbiddenCard />;

  return (
    <div className="space-y-6">
      <AdminPageHeader anchor="daily-triage" title="Dashboard" description="Review open queues and recent platform activity." />
      <AdminNeedsAttention />
      <ActivitySection counts={counts.data} days={daily.error ? undefined : daily.data?.days}
        error={counts.error} onRetry={refreshCounts} />
      <AdminDailyActivity days={daily.data?.days} error={daily.error} onRetry={refreshDaily} />
      <RecentActivityCard
        events={merged}
        data={recent.data}
        isLoading={recent.isLoading && merged.length === 0}
        error={recent.error ?? null}
        onRetry={refreshRecent}
      />
      {storage.error ? <RequestError title="Storage summary unavailable" error={storage.error} onRetry={() => storage.mutate()} />
        : storage.data ? <Link href="/admin/health" className="inline-flex min-h-11 items-center rounded text-body text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          Database {formatBytes(storage.data.dataBytes + storage.data.indexBytes)} → Infrastructure
        </Link> : null}
    </div>
  );
}

function ActivitySection({ counts, days, error, onRetry }: {
  counts: AdminEventCountsResp | undefined;
  days: AdminDailyEvent[] | undefined;
  error: ClientApiError | undefined;
  onRetry: () => unknown;
}) {
  if (error) return <RequestError title="Activity totals unavailable" error={error} onRetry={onRetry} />;
  if (!counts) return <div role="status" aria-label="Loading activity totals"><LoadingRows rows={2} /></div>;
  const { windows, macos, linux } = counts.downloadsByPlatform;
  const signupDelta = days ? weekOverWeek(days, "user_signup") : null;
  const downloadDelta = days ? weekOverWeek(days, "agent_download") : null;
  const connectionDelta = days ? weekOverWeek(days, "agent_connected") : null;
  return <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
    <MetricStat label="Total users" value={compactNumber(counts.totalUsers)} href="/admin/users"
      caption="Registered accounts"
      detail={signupDelta ? "Signups " + signupDelta : null} />
    <MetricStat label="Active agents" value={compactNumber(counts.agents.active24h)} href="/admin/users?filter=with_agent"
      caption="Paired devices seen in the last 24h"
      detail={connectionDelta ? "First connections " + connectionDelta : null} />
    <MetricStat label="Agent downloads" value={compactNumber(counts.totalDownloads)} href="/admin/notifications?type=agent_download&unread=0"
      caption="Recorded download clicks"
      detail={["Windows " + compactNumber(windows), "macOS " + compactNumber(macos), "Linux " + compactNumber(linux), downloadDelta].filter(Boolean).join(" · ")} />
    <MetricStat label="Unread" value={compactNumber(counts.unreadCount)} href="/admin/notifications"
      caption="Activity and messages marked unread" />
  </div>;
}

function RecentActivityCard({
  events,
  data,
  isLoading,
  error,
  onRetry,
}: {
  events: AdminEvent[];
  data: AdminEventsListResp | undefined;
  isLoading: boolean;
  error: ClientApiError | null;
  onRetry: () => unknown;
}) {
  return (
    <Card padded={false}>
      <Card.Header className="flex-wrap">
        <h3 className="text-caption font-semibold uppercase tracking-wider text-text">
          Recent activity
        </h3>
        <AdminLiveStatus onRefresh={onRetry} data={data} />
        <Link
          href="/admin/notifications"
          className="text-caption text-accent-cyan underline-offset-2 hover:underline"
        >
          View all →
        </Link>
      </Card.Header>
      {error ? (
        <RequestError error={error} onRetry={onRetry} />
      ) : isLoading ? (
        <ul className="divide-y divide-border">
          {Array.from({ length: 4 }).map((_, i) => (
            <li key={i} className="flex motion-safe:animate-pulse gap-3 px-4 py-3">
              <div className="h-9 w-9 rounded-full bg-bg-elevated" />
              <div className="flex-1 space-y-1.5">
                <div className="h-4 w-2/5 rounded bg-bg-elevated" />
                <div className="h-3 w-3/5 rounded bg-bg-elevated" />
              </div>
            </li>
          ))}
        </ul>
      ) : events.length === 0 ? (
        <EmptyStatePanel title="No activity yet" description="New signups, agent download clicks and first connections will appear here."
          action={<Button variant="secondary" onClick={onRetry}>Refresh</Button>} />
      ) : (
        <ul className="divide-y divide-border">
          {events.map((event) => (
            <AdminEventRow
              key={event.eventId}
              event={event}
              unread={!event.readAt}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}
