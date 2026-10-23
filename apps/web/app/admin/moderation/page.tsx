"use client";

import { useEffect, useMemo, useState } from "react";
import { useApi } from "@/lib/clientApi";
import { Button } from "@/components/ui/Button";
import { Card, Skeleton } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { AdminPageHeader as PageHeader } from "@/app/admin/components/AdminPageHeader";
import { RequestError } from "@/components/ui/RequestError";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { ForbiddenCard } from "../components/AdminFragments";
import { ReportGroupCard } from "./ReportGroupCard";
import { groupReports, TARGET_LABEL, type Report } from "./moderationGroups";

type ReportsResp = { items: Report[]; total?: number; capped?: boolean };
type Sort = "oldest" | "newest" | "reported";

export default function AdminModerationPage() {
  const q = useApi<ReportsResp>("/v1/community/admin/reports");
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  useEffect(() => { if (q.data && !q.error) setLastChecked(new Date()); }, [q.data, q.error]);
  const [filter, setFilter] = useState<"all" | Report["targetType"]>("all");
  const [sort, setSort] = useState<Sort>("oldest");
  const groups = useMemo(() => groupReports(q.data?.items ?? []), [q.data]);
  const visible = groups.filter((g) => filter === "all" || g.reports[0].targetType === filter)
    .sort((a, b) => sort === "reported" ? b.reports.length - a.reports.length || a.oldest - b.oldest
      : sort === "newest" ? b.newest - a.newest : a.oldest - b.oldest);
  if (q.error?.status === 403) return <ForbiddenCard />;
  return (
    <div className="space-y-6">
      <PageHeader anchor="moderation" eyebrow="Admin" title="Moderation queue" description="Dismiss keeps the content; Remove takes it down."
        actions={<Button variant="secondary" onClick={() => void q.mutate()} loading={q.isValidating}>Refresh</Button>} />
      <details className="text-caption text-text-muted"><summary>How moderation works</summary>
        <p>Review content is hidden after three distinct reports. Dismiss restores it; Remove takes it down and costs its author 20 review karma. Your resolution note is recorded. One decision clears all reports on the same target.</p>
      </details>
      {q.data?.capped ? <p role="status">Showing the oldest 100 of {q.data.total} open reports. Resolve these to see the rest.</p> : null}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-wrap gap-2" aria-label="Filter reports by type">
          <Button variant="secondary" size="sm" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All ({groups.length})</Button>
          {Object.entries(TARGET_LABEL).filter(([kind]) => groups.some((g) => g.reports[0].targetType === kind)).map(([kind, label]) => (
            <Button key={kind} variant="secondary" size="sm" aria-pressed={filter === kind} onClick={() => setFilter(kind as Report["targetType"])}>
              {label} ({groups.filter((g) => g.reports[0].targetType === kind).length})
            </Button>
          ))}
        </div>
        <Field label="Sort reports"><Select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          <option value="oldest">Oldest first</option><option value="newest">Newest first</option><option value="reported">Most reported</option>
        </Select></Field>
      </div>
      {q.error ? <RequestError error={q.error} onRetry={() => q.mutate()} title="Moderation queue" />
        : !q.data ? <Skeleton rows={4} />
          : visible.length ? <ul className="space-y-3">{visible.map((group) => <li key={group.key}>
            <ReportGroupCard group={group} onResolved={() => q.mutate()} />
          </li>)}</ul> : <Card><EmptyStatePanel title={groups.length ? "No reports match this type" : "Queue clear"}
            description={groups.length ? "Choose another report type." : `No open reports. Last checked ${lastChecked?.toLocaleTimeString() ?? "not available"}.`}
            action={<Button variant="secondary" onClick={() => groups.length ? setFilter("all") : void q.mutate()}>{groups.length ? "Clear filters" : "Refresh"}</Button>} /></Card>}
    </div>
  );
}
