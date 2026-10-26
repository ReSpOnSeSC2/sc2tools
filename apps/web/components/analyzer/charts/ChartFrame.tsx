"use client";

import { useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/Card";
import { QueryState, hasQueryData, type QueryLike } from "@/components/ui/QueryState";

export type ChartTableColumn<Row> = { key: string; label: ReactNode; render: (row: Row) => ReactNode; align?: "left" | "right" };
export type ChartFrameProps<Row> = {
  title: string; showTitle?: boolean; summary: string; rows: readonly Row[]; columns: readonly ChartTableColumn<Row>[];
  children: ReactNode; legend?: ReactNode; toolbar?: ReactNode; query?: QueryLike<unknown>; empty?: ReactNode; className?: string; testId?: string;
};

/** The table uses the same supplied rows as the plot, with no independent
 * request or recalculation. QueryState preserves failure/empty/stale semantics. */
export function ChartFrame<Row>({ title, showTitle = false, summary, rows, columns, children, legend, toolbar, query, empty, className = "", testId }: ChartFrameProps<Row>) {
  const [table, setTable] = useState(false), id = useId();
  const ready = !query || hasQueryData(query);
  const content = () => !rows.length ? empty || <EmptyState title="No chart data in this view" /> : table
    ? <ChartDataTable title={title} summary={summary} rows={rows} columns={columns} /> : children;
  return <section aria-label={title} className={`min-w-0 space-y-3 ${className}`} data-testid={testId}>
    {ready ? <p className="sr-only">{summary}</p> : null}
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
      {showTitle ? <h3 className="text-caption font-semibold text-text">{title}</h3> : null}
      {ready ? legend : null}{toolbar}
      {ready && rows.length > 0 ? <Button variant="ghost" size="sm" className="min-h-11" aria-pressed={table} aria-controls={id} onClick={() => setTable(value => !value)}>{table ? "Show chart" : "View as table"}<span className="sr-only"> · {title}</span></Button> : null}
    </div>
    <div id={id}>{query ? <QueryState q={query}>{content}</QueryState> : content()}</div>
  </section>;
}

function ChartDataTable<Row>({ title, summary, rows, columns }: Pick<ChartFrameProps<Row>, "title" | "summary" | "rows" | "columns">) {
  // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- The named overflow region must accept keyboard scrolling.
  return <div role="region" aria-label={`${title} data table`} tabIndex={0} className="max-w-full overflow-x-auto rounded-lg border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
    <table className="w-full border-collapse text-caption">
      <caption className="sr-only">{title}. {summary}</caption>
      <thead className="bg-bg-elevated"><tr>{columns.map(column => <th key={column.key} scope="col" className={`px-3 py-2 font-semibold text-text ${column.align === "right" ? "text-right" : "text-left"}`}>{column.label}</th>)}</tr></thead>
      <tbody className="divide-y divide-border">{rows.map((row, index) => <tr key={index}>{columns.map(column => <td key={column.key} className={`break-words px-3 py-2 text-text-muted ${column.align === "right" ? "text-right tabular-nums" : "text-left"}`}>{column.render(row)}</td>)}</tr>)}</tbody>
    </table>
  </div>;
}

export function ChartLegend({ items }: { items: readonly { key: string; label: string; color: string; strokeDasharray?: string }[] }) {
  return <ul aria-label="Chart series" className="flex min-w-0 flex-wrap gap-x-4 gap-y-2 text-caption text-text-muted">{items.map(item => <li key={item.key} className="inline-flex min-w-0 items-center gap-2"><svg width="20" height="12" aria-hidden="true" className="shrink-0"><line x1="0" x2="20" y1="6" y2="6" stroke={item.color} strokeWidth="3" strokeDasharray={item.strokeDasharray} /></svg><span className="break-words">{item.label}</span></li>)}</ul>;
}
