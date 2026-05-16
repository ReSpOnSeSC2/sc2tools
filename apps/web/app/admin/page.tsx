"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";

import { useApi } from "@/lib/clientApi";
import { Card } from "@/components/ui/Card";
import { compactNumber, formatBytes } from "./components/format";
import { ForbiddenCard, LoadingRows, MetricStat } from "./components/AdminFragments";
import { AdminEventRow } from "./components/AdminEventRow";
import { useAdminEventsSocket } from "./components/useAdminEventsSocket";
import type {
  AdminEvent,
  AdminEventCountsResp,
  AdminEventsListResp,
  StorageStatsResp,
} from "./components/adminTypes";

const RECENT_FEED_SIZE = 8;

/**
 * /admin — Dashboard tab.
 *
 * Layers three sources of truth onto one screen:
 *   1. Live activity counters (signups + downloads) backed by
 *      ``GET /v1/admin/events/counts``, refreshed by the
 *      ``admin:event`` Socket.io broadcast.
 *   2. The most recent eight events, spliced live so a new signup
 *      pops to the top without a page refresh.
 *   3. Per-collection MongoDB storage stats — the original Dashboard
 *      payload, useful for capacity triage.
 */
export default function AdminDashboardPage() {
  const counts = useApi<AdminEventCountsResp>("/v1/admin/events/counts");
  const recent = useApi<AdminEventsListResp>(
    `/v1/admin/events?limit=${RECENT_FEED_SIZE}`,
  );
  const storage = useApi<StorageStatsResp>("/v1/admin/storage-stats");

  const [liveEvents, setLiveEvents] = useState<AdminEvent[]>([]);

  useAdminEventsSocket(
    useCallback(
      (event: AdminEvent) => {
        setLiveEvents((prev) => {
          if (prev.some((e) => e.eventId === event.eventId)) return prev;
          return [event, ...prev].slice(0, RECENT_FEED_SIZE);
        });
        counts.mutate();
      },
      [counts],
    ),
  );

  const merged = useMemo<AdminEvent[]>(() => {
    const base = recent.data?.items || [];
    if (liveEvents.length === 0) return base.slice(0, RECENT_FEED_SIZE);
    const seen = new Set<string>();
    const out: AdminEvent[] = [];
    for (const e of liveEvents) {
      if (seen.has(e.eventId)) continue;
      seen.add(e.eventId);
      out.push(e);
    }
    for (const e of base) {
      if (seen.has(e.eventId)) continue;
      seen.add(e.eventId);
      out.push(e);
    }
    return out.slice(0, RECENT_FEED_SIZE);
  }, [recent.data, liveEvents]);

  const forbidden =
    counts.error?.status === 403 ||
    recent.error?.status === 403 ||
    storage.error?.status === 403;
  if (forbidden) return <ForbiddenCard />;

  const loading = counts.isLoading && recent.isLoading && storage.isLoading;
  if (loading) return <DashboardSkeleton />;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <p className="text-text-muted">
          Live signup and download activity, plus per-collection
          storage breakdown for this MongoDB cluster.
        </p>
      </header>

      <ActivitySection counts={counts.data ?? null} error={counts.error?.message ?? null} />

      <RecentActivityCard
        events={merged}
        isLoading={recent.isLoading && merged.length === 0}
        error={recent.error?.message ?? null}
      />

      <StorageSection
        data={storage.data ?? null}
        error={storage.error?.message ?? null}
      />
    </div>
  );
}

function ActivitySection({
  counts,
  error,
}: {
  counts: AdminEventCountsResp | null;
  error: string | null;
}) {
  if (error) {
    return (
      <Card padded>
        <p className="text-danger">Failed to load activity: {error}</p>
      </Card>
    );
  }
  const c = counts;
  const platforms = c?.downloadsByPlatform || {
    windows: 0,
    macos: 0,
    linux: 0,
  };
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricStat
          label="Total users"
          value={compactNumber(c?.totalUsers ?? 0)}
          caption={
            c
              ? `+${c.signupsToday} today · +${c.signupsThisWeek} this week`
              : "—"
          }
        />
        <MetricStat
          label="Agent downloads"
          value={compactNumber(c?.totalDownloads ?? 0)}
          caption={
            c
              ? `+${c.downloadsToday} today · +${c.downloadsThisWeek} this week`
              : "—"
          }
        />
        <MetricStat
          label="Unread"
          value={compactNumber(c?.unreadCount ?? 0)}
          caption="open the Notifications tab to clear"
        />
        <MetricStat
          label="Downloads by OS"
          value={compactNumber(
            (platforms.windows || 0)
              + (platforms.macos || 0)
              + (platforms.linux || 0),
          )}
          caption={`Win ${compactNumber(platforms.windows)} · Mac ${compactNumber(platforms.macos)} · Linux ${compactNumber(platforms.linux)}`}
        />
      </div>
    </div>
  );
}

function RecentActivityCard({
  events,
  isLoading,
  error,
}: {
  events: AdminEvent[];
  isLoading: boolean;
  error: string | null;
}) {
  return (
    <Card padded={false}>
      <Card.Header>
        <h3 className="text-caption font-semibold uppercase tracking-wider text-text">
          Recent activity
        </h3>
        <Link
          href="/admin/notifications"
          className="text-caption text-accent-cyan underline-offset-2 hover:underline"
        >
          View all →
        </Link>
      </Card.Header>
      {isLoading ? (
        <ul className="divide-y divide-border">
          {Array.from({ length: 4 }).map((_, i) => (
            <li key={i} className="flex animate-pulse gap-3 px-4 py-3">
              <div className="h-9 w-9 rounded-full bg-bg-elevated" />
              <div className="flex-1 space-y-1.5">
                <div className="h-4 w-2/5 rounded bg-bg-elevated" />
                <div className="h-3 w-3/5 rounded bg-bg-elevated" />
              </div>
            </li>
          ))}
        </ul>
      ) : error ? (
        <div className="px-4 py-6 text-caption text-danger">{error}</div>
      ) : events.length === 0 ? (
        <div className="px-4 py-6 text-caption text-text-muted">
          No activity yet — new signups and agent downloads will appear here.
        </div>
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

function StorageSection({
  data,
  error,
}: {
  data: StorageStatsResp | null;
  error: string | null;
}) {
  if (error) {
    return (
      <Card padded>
        <p className="text-danger">Failed to load storage stats: {error}</p>
      </Card>
    );
  }
  if (!data) return null;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricStat
          label="Total documents"
          value={compactNumber(data.totalDocs)}
          caption="across tracked collections"
        />
        <MetricStat
          label="Data size"
          value={formatBytes(data.totalDataBytes)}
          caption="uncompressed"
        />
        <MetricStat
          label="Storage size"
          value={formatBytes(data.totalStorageBytes)}
          caption="on disk after WiredTiger"
        />
        <MetricStat
          label="Index size"
          value={formatBytes(data.totalIndexBytes)}
          caption="all secondary indexes"
        />
      </div>

      <Card padded={false}>
        <Card.Header>
          <h3 className="text-caption font-semibold uppercase tracking-wider text-text">
            Collections
          </h3>
          <span className="text-caption text-text-dim">
            sorted by data size
          </span>
        </Card.Header>
        <div className="block md:hidden">
          <ul className="divide-y divide-border">
            {data.collections.map((row) => (
              <li key={row.name} className="space-y-1 px-4 py-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-mono text-body font-semibold">
                    {row.name}
                  </span>
                  <span className="text-caption text-text-dim">
                    {compactNumber(row.count)} docs
                  </span>
                </div>
                <dl className="grid grid-cols-3 gap-2 text-caption text-text-muted">
                  <div>
                    <dt className="text-text-dim">Data</dt>
                    <dd className="tabular-nums text-text">
                      {formatBytes(row.totalSize)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-text-dim">Disk</dt>
                    <dd className="tabular-nums text-text">
                      {formatBytes(row.storageSize)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-text-dim">Indexes</dt>
                    <dd className="tabular-nums text-text">
                      {formatBytes(row.indexSize)}
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        </div>
        <div className="hidden md:block">
          <table className="w-full text-sm">
            <thead className="bg-bg-elevated/40 text-left text-caption uppercase tracking-wider text-text-dim">
              <tr>
                <th className="px-4 py-3 font-semibold">Collection</th>
                <th className="px-4 py-3 text-right font-semibold">Documents</th>
                <th className="px-4 py-3 text-right font-semibold">Avg doc</th>
                <th className="px-4 py-3 text-right font-semibold">Data size</th>
                <th className="px-4 py-3 text-right font-semibold">On disk</th>
                <th className="px-4 py-3 text-right font-semibold">Indexes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.collections.map((row) => (
                <tr key={row.name} className="hover:bg-bg-elevated/30">
                  <td className="px-4 py-2 font-mono text-text">{row.name}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-text">
                    {row.count.toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-text-muted">
                    {row.avgObjSize > 0 ? formatBytes(row.avgObjSize) : "—"}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-text">
                    {formatBytes(row.totalSize)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-text">
                    {formatBytes(row.storageSize)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-text-muted">
                    {formatBytes(row.indexSize)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="h-8 w-40 animate-pulse rounded bg-bg-elevated" />
        <div className="h-4 w-72 animate-pulse rounded bg-bg-elevated" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-24 animate-pulse rounded-xl bg-bg-elevated"
          />
        ))}
      </div>
      <LoadingRows rows={8} />
    </div>
  );
}
