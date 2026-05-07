"use client";

import { useApi } from "@/lib/clientApi";
import { Card } from "@/components/ui/Card";
import { compactNumber, formatBytes } from "./components/format";
import { ForbiddenCard, LoadingRows, MetricStat } from "./components/AdminFragments";
import type { StorageStatsResp } from "./components/adminTypes";

/**
 * /admin — Dashboard tab.
 *
 * Renders the per-collection storage breakdown the admin uses to
 * answer "where is the data?" — the same question Atlas's Browse
 * Collections panel answers, but inside the SPA so an admin who's
 * already authenticated against Clerk doesn't have to context-switch
 * to the Atlas UI for a quick glance.
 *
 * Sort order is descending by total data size, so the largest
 * collections sit at the top of the table on every screen size.
 */
export default function AdminDashboardPage() {
  const { data, error, isLoading } = useApi<StorageStatsResp>(
    "/v1/admin/storage-stats",
  );

  if (isLoading) return <DashboardSkeleton />;
  if (error) {
    if (error.status === 403) return <ForbiddenCard />;
    return (
      <Card padded>
        <p className="text-danger">
          Failed to load storage stats: {error.message}
        </p>
      </Card>
    );
  }
  if (!data) return null;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <p className="text-text-muted">
          Per-collection storage and document counts across the
          MongoDB cluster powering this deployment.
        </p>
      </header>

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
            sorted by data size · click row for live numbers
          </span>
        </Card.Header>
        {/* Mobile: stacked card list; Desktop: table. */}
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

      <Card padded>
        <h3 className="text-caption font-semibold uppercase tracking-wider text-text">
          Notes
        </h3>
        <ul className="mt-2 space-y-1 text-caption text-text-muted">
          <li>
            <strong className="text-text">Data size</strong> is the
            uncompressed BSON size — what your code reads.
          </li>
          <li>
            <strong className="text-text">On disk</strong> is the
            compressed footprint (snappy via WiredTiger). This is the
            number that counts against your Atlas tier.
          </li>
          <li>
            Heavy per-game fields live in <code>game_details</code>;
            slim metadata stays in <code>games</code>. See the
            v0.4.4 CHANGELOG entry for the storage trim rationale.
          </li>
        </ul>
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
