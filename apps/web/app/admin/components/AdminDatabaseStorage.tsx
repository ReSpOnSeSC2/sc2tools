"use client";

import { useState } from "react";
import { useApi } from "@/lib/clientApi";
import { formatNumber } from "@/lib/i18n/format";
import { Card } from "@/components/ui/Card";
import { RequestError } from "@/components/ui/RequestError";
import { useSort } from "@/components/ui/SortableTh";
import { AdminMobileSort, AdminTable, type AdminColumn } from "./AdminTable";
import { MetricStat } from "./AdminFragments";
import { compactNumber, formatBytes, formatUsd, timeSince } from "./format";
import type { AdminStorageSummary, StorageStatsResp } from "./adminTypes";

type StorageRow = StorageStatsResp["collections"][number];
const COLUMNS: AdminColumn<StorageRow>[] = [
  { key: "name", label: "Collection", sortKey: "name", kind: "text", mobile: "title",
    render: (row) => <span className="break-words font-mono">{row.name}</span> },
  { key: "count", label: "Documents", sortKey: "count", align: "right", mobile: "field",
    render: (row) => formatNumber(row.count) },
  { key: "avgObjSize", label: "Avg doc", align: "right", mobile: "hidden",
    render: (row) => row.avgObjSize > 0 ? formatBytes(row.avgObjSize) : "—" },
  { key: "totalSize", label: "Data size", sortKey: "totalSize", align: "right", mobile: "field",
    render: (row) => formatBytes(row.totalSize) },
  { key: "storageSize", label: "On disk", align: "right", mobile: "field",
    render: (row) => formatBytes(row.storageSize) },
  { key: "indexSize", label: "Indexes", sortKey: "indexSize", align: "right", mobile: "field",
    render: (row) => formatBytes(row.indexSize) },
];

export function AdminDatabaseStorage() {
  const [open, setOpen] = useState(false);
  const summary = useApi<AdminStorageSummary>("/v1/admin/storage-summary");
  const stats = useApi<StorageStatsResp>(open ? "/v1/admin/storage-stats" : null);
  const { sortBy, sortDir, setSortExplicit, sortRows } = useSort("totalSize");
  const sort = { by: sortBy, dir: sortDir, onChange: setSortExplicit };
  const data = summary.data;
  return <Card>
    <details id="database-storage" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="min-h-11 cursor-pointer rounded py-2 text-body font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        Database storage
        <span className="ml-2 text-caption font-normal text-text-muted">
          {summary.error ? "Summary unavailable" : data
            ? "Data " + formatBytes(data.dataBytes) + " · Indexes " + formatBytes(data.indexBytes) + " · " + formatNumber(data.collectionCount) + (data.collectionCount === 1 ? " collection" : " collections")
            : "Checking storage…"}
        </span>
      </summary>
      {open ? <div className="mt-3 space-y-4">
        {summary.error ? <RequestError title="Storage summary unavailable" error={summary.error} onRetry={() => summary.mutate()} /> : null}
        {stats.data ? <>
          <DatabaseFootprint database={stats.data.database} />
          <TrackedCollectionTotals data={stats.data} />
          <AdminMobileSort columns={COLUMNS} sort={sort} />
        </> : null}
        <AdminTable columns={COLUMNS} rows={sortRows(stats.data?.collections ?? [], (row, col) => row[col as keyof StorageRow])}
          rowKey={(row) => row.name} sort={sort} loading={stats.isLoading} caption="Database collections"
          empty={<p className="text-body text-text-muted">No tracked collections.</p>}
          error={stats.error ? <RequestError title="Collection stats unavailable" error={stats.error} onRetry={() => stats.mutate()} /> : null} />
      </div> : null}
    </details>
  </Card>;
}

function TrackedCollectionTotals({ data }: { data: StorageStatsResp }) {
  return <section className="space-y-2">
    <h3 className="text-caption font-semibold uppercase tracking-wider text-text-dim">Tracked collection totals</h3>
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <MetricStat label="Total documents" value={compactNumber(data.totalDocs)} />
      <MetricStat label="Data size" value={formatBytes(data.totalDataBytes)} caption="uncompressed" />
      <MetricStat label="Storage size" value={formatBytes(data.totalStorageBytes)} caption="on disk after WiredTiger" />
      <MetricStat label="Index size" value={formatBytes(data.totalIndexBytes)} caption="secondary indexes" />
    </div>
  </section>;
}

function DatabaseFootprint({
  database,
}: {
  database: StorageStatsResp["database"] | undefined;
}) {
  const app = database?.available ? database.appData : null;
  if (!app) {
    return (
      <Card padded>
        <h3 className="text-caption font-semibold uppercase tracking-wider text-text">
          Application database footprint
        </h3>
        <p className="mt-2 text-body text-text-muted">
          Whole-database dbStats are temporarily unavailable. No storage value
          has been inferred from the collection table below.
        </p>
      </Card>
    );
  }
  const planning = database?.pricing;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-caption font-semibold uppercase tracking-wider text-text">
          Application database footprint
        </h3>
        <span className="text-caption text-text-dim">
          database-only dbStats · measured {timeSince(app.measuredAt)}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <MetricStat
          label="Logical app data"
          value={formatBytes(app.logicalDataBytes)}
          caption="uncompressed documents"
        />
        <MetricStat
          label="Allocated documents"
          value={formatBytes(app.allocatedDocumentBytes)}
          caption="WiredTiger document allocation"
        />
        <MetricStat
          label="Allocated indexes"
          value={formatBytes(app.allocatedIndexBytes)}
          caption="database index allocation"
        />
        <MetricStat
          label="Allocated app total"
          value={formatBytes(app.allocatedTotalBytes)}
          caption="documents + indexes"
        />
        <MetricStat
          label="Mongo planning baseline"
          value={
            planning
              ? `${formatUsd(planning.monthlyPlanningEstimateUsd)}/mo`
              : "Unavailable"
          }
          caption="repository planning estimate"
        />
      </div>
      <p className="text-caption text-text-dim">
        This is the SC2 Tools application database only. It is not Atlas disk
        capacity, backup storage, data transfer, or a provider bill.
      </p>
    </div>
  );
}
