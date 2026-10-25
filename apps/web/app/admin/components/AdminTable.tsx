"use client";
import type { ReactNode } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { SortableTh, type SortDir } from "@/components/ui/SortableTh";
import { Select } from "@/components/ui/Select";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { LoadingRows } from "./AdminFragments";

export type AdminColumn<T> = { key: string; label: string; sortKey?: string; defaultDir?: SortDir; kind?: "text" | "number" | "date"; align?: "left" | "right"; render: (row: T) => ReactNode; mobile: "title" | "field" | "hidden" };
type Sort = { by: string; dir: SortDir; onChange: (by: string, dir: SortDir) => void };
export function AdminTable<T>({ columns, rows, rowKey, rowHref, sort, loading, updating, empty, error, caption }: {
  columns: AdminColumn<T>[]; rows: T[]; rowKey: (row: T) => string; rowHref?: (row: T) => string | undefined; sort?: Sort;
  loading?: boolean; updating?: boolean; empty: ReactNode; error?: ReactNode; caption: string;
}) {
  if (error && !rows.length) return <>{error}</>;
  if (loading && !rows.length) return <LoadingRows rows={8} />;
  if (!rows.length) return <>{empty}</>;
  const toggle = (key: string) => { const column = columns.find(item => item.sortKey === key); sort?.onChange(key, sort.by === key ? sort.dir === "asc" ? "desc" : "asc" : column?.defaultDir || (column?.kind === "text" ? "asc" : "desc")); };
  return <div className="space-y-2">{error}<div aria-busy={!!updating} className={`transition-opacity ${updating ? "opacity-60" : ""}`}>
    <Card padded={false}><div className="hidden max-h-[70vh] overflow-auto md:block"><table className="w-full text-left text-caption"><caption className="sr-only">{caption}</caption>
      <thead className="sticky top-0 bg-bg-elevated"><tr>{columns.map(column => sort && column.sortKey ? <SortableTh key={column.key} col={column.sortKey} label={column.label} align={column.align} sortBy={sort.by} sortDir={sort.dir} setSort={toggle} /> : <th key={column.key} className={`px-3 py-2 ${column.align === "right" ? "text-right" : ""}`}>{column.label}</th>)}</tr></thead>
      <tbody className="divide-y divide-border">{rows.map(row => <tr key={rowKey(row)} className="relative hover:bg-bg-elevated/40">{columns.map((column, index) => <td key={column.key} className={`px-3 py-3 ${column.align === "right" ? "text-right tabular-nums" : ""} [&_button]:relative [&_button]:z-10 [&_input]:relative [&_input]:z-10 [&_select]:relative [&_select]:z-10`}>
        {index === 0 && rowHref?.(row) ? <Link href={rowHref(row)!} className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-accent">{column.render(row)}</Link> : <span className="[&_a]:relative [&_a]:z-10">{column.render(row)}</span>}</td>)}</tr>)}</tbody></table></div>
      <ul className="divide-y divide-border md:hidden" aria-label={`${caption}, cards`}>{rows.map(row => <li key={rowKey(row)} className="relative space-y-2 p-4 hover:bg-bg-elevated/40">{columns.filter(column => column.mobile !== "hidden").map(column => <div key={column.key} className={column.mobile === "title" ? "break-words font-semibold" : "flex justify-between gap-4 text-caption"}>
        {column.mobile === "title" ? rowHref?.(row) ? <Link href={rowHref(row)!} className="after:absolute after:inset-0 after:content-['']">{column.render(row)}</Link> : column.render(row) : <><span className="text-text-muted">{column.label}</span><span className="text-right [&_a]:relative [&_a]:z-10 [&_button]:relative [&_button]:z-10">{column.render(row)}</span></>}</div>)}</li>)}</ul>
    </Card></div><p role="status" className="text-caption text-text-muted">{rows.length} {rows.length === 1 ? "result" : "results"}{updating ? <span className="ml-2 inline-flex items-center gap-1"><span aria-hidden className="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />Updating…</span> : null}</p></div>;
}

export function AdminMobileSort<T>({ columns, sort }: { columns: AdminColumn<T>[]; sort: Sort }) {
  const column = columns.find(item => item.sortKey === sort.by), kind = column?.kind || "number";
  const label = kind === "date" ? sort.dir === "desc" ? "Newest first" : "Oldest first" : kind === "text" ? sort.dir === "asc" ? "A–Z" : "Z–A" : sort.dir === "desc" ? "Highest first" : "Lowest first";
  return <div className="flex flex-wrap items-end gap-2 md:hidden"><Field label="Sort by"><Select value={sort.by} onChange={event => { const next = columns.find(item => item.sortKey === event.target.value); sort.onChange(event.target.value, next?.defaultDir || (next?.kind === "text" ? "asc" : "desc")); }}>{columns.filter(item => item.sortKey).map(item => <option key={item.key} value={item.sortKey}>{item.label}</option>)}</Select></Field><Button variant="secondary" onClick={() => sort.onChange(sort.by, sort.dir === "asc" ? "desc" : "asc")}>{label}</Button></div>;
}
