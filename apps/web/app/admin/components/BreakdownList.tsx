import { Card } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";
import { compactNumber, pctLabel } from "./format";
import type { GlobalBreakdownRow } from "./adminTypes";

export function BreakdownList({ title, subtitle, rows, isLoading = false, onRetry }: { title: string; subtitle: string; rows: GlobalBreakdownRow[] | null; isLoading?: boolean; onRetry?: () => unknown }) {
  const max = Math.max(0, ...(rows || []).map(row => row.count));
  return <Card padded={false}><Card.Header><h3 className="text-caption font-semibold uppercase tracking-wider">{title}</h3><span className="text-caption text-text-muted">{subtitle}</span></Card.Header>
    {isLoading && !rows ? <div role="status" className="h-28 animate-pulse bg-bg-elevated"><span className="sr-only">Loading {title}</span></div> : !rows?.length ? <EmptyStatePanel size="sm" title="No data yet" action={onRetry ? <Button variant="secondary" onClick={onRetry}>Refresh</Button> : undefined} /> : <ul className="divide-y divide-border">{rows.map(row => <li key={row.key} className="space-y-1 px-4 py-3"><div className="flex justify-between gap-2"><span className="min-w-0 truncate" title={row.key}>{row.key}</span><span className="shrink-0 text-caption text-text-muted">{compactNumber(row.count)} · {pctLabel(row.winRate)} WR</span></div><div className="h-1.5 overflow-hidden rounded bg-bg-elevated"><div className="h-full bg-accent-cyan/70" style={{ width: `${max ? Math.max(3, row.count / max * 100) : 0}%` }} /></div></li>)}</ul>}</Card>;
}
