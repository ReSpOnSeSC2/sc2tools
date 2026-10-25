"use client";
import { Suspense } from "react";
import { useApi } from "@/lib/clientApi";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { RequestError } from "@/components/ui/RequestError";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { AdminPageHeader } from "../components/AdminPageHeader";
import { AdminPagination } from "../components/AdminPagination";
import { AdminSearchField } from "../components/AdminSearchField";
import { AdminTable, AdminMobileSort, type AdminColumn } from "../components/AdminTable";
import { ForbiddenCard, LoadingRows } from "../components/AdminFragments";
import { useAdminQueryState } from "../components/useAdminQueryState";
import { AdminDate } from "../components/AdminDate";
import { AdminUsersExport } from "../components/AdminUsersExport";
import type { AdminUserRow, UsersListResp } from "../components/adminTypes";

const filters = [{ value: "all", label: "All" }, { value: "with_games", label: "Has games" }, { value: "no_games", label: "No games yet" }, { value: "with_agent", label: "Has agent" }, { value: "signed_up_7d", label: "Signed up in 7 days" }, { value: "agent_inactive_14d", label: "Agent inactive 14 days" }, { value: "admins", label: "Admins" }];
const columns: AdminColumn<AdminUserRow>[] = [
  { key: "user", label: "User", mobile: "title", render: row => <><span className="[overflow-wrap:anywhere]">{row.email || "(no email on file)"}</span><span className="block break-all font-mono text-caption text-text-muted">{row.clerkUserId || row.userId}</span><span className="mt-1 inline-flex flex-wrap gap-1">{row.isAdmin ? <Badge size="sm" variant="accent">Admin</Badge> : null}{row.hasAgent ? <Badge size="sm" variant="neutral">Agent paired</Badge> : null}</span></> },
  { key: "createdAt", label: "Signed up", sortKey: "createdAt", kind: "date", align: "right", mobile: "field", render: row => <AdminDate value={row.createdAt} /> },
  { key: "games", label: "Games", sortKey: "games", kind: "number", align: "right", mobile: "field", render: row => row.gameCount.toLocaleString() },
  { key: "opponents", label: "Opponents", sortKey: "opponents", kind: "number", align: "right", mobile: "field", render: row => row.opponentCount.toLocaleString() },
  { key: "lastActivity", label: "Last activity", sortKey: "lastActivity", kind: "date", align: "right", mobile: "field", render: row => <AdminDate value={row.lastActivity} /> },
  { key: "agentLastSeen", label: "Agent last seen", sortKey: "agentLastSeen", kind: "date", align: "right", mobile: "field", render: row => <AdminDate value={row.agentLastSeenAt} /> },
];
/** URL page/limit works for every sort; the previous activity cursor remains readable. */
function UsersBody() {
  const [state, set] = useAdminQueryState({ q: "", filter: "all", sort: "lastActivity", order: "desc", page: 1, before: "" }, { allowed: { filter: filters.map(filter => filter.value), sort: columns.flatMap(column => column.sortKey ? [column.sortKey] : []), order: ["asc", "desc"] } });
  const page = Math.max(1, Math.min(10000, state.page));
  const params = new URLSearchParams({ limit: "50", sort: state.sort, order: state.order });
  if (state.q.trim()) params.set("search", state.q.trim());
  if (state.filter !== "all") params.set("filter", state.filter);
  if (state.before && state.sort === "lastActivity" && state.order === "desc") params.set("before", state.before); else params.set("page", String(page));
  const request = useApi<UsersListResp>(`/v1/admin/users?${params}`, { keepPreviousData: true });
  const exportQuery = new URLSearchParams({ filter: state.filter }); if (state.q.trim()) exportQuery.set("q", state.q.trim());
  const data = request.data, rows = data?.items || [], total = data?.total ?? rows.length;
  const start = rows.length ? (page - 1) * 50 + 1 : 0, end = rows.length ? start + rows.length - 1 : 0;
  const sort = { by: state.sort, dir: state.order as "asc" | "desc", onChange: (sort: string, order: "asc" | "desc") => set({ sort, order }) };
  if (request.error?.status === 403) return <ForbiddenCard />;
  return <div className="space-y-6"><AdminPageHeader anchor="users-and-repairing-data" title="Users" description="Find accounts and inspect their activity before repairing data." actions={<AdminUsersExport query={exportQuery.toString()} />} />
    <Card padded><AdminSearchField value={state.q} onChange={q => set({ q })} placeholder="Email, userId, or Clerk ID" /><div className="mt-3 flex flex-wrap gap-2">{filters.map(filter => <Button key={filter.value} variant="secondary" size="sm" aria-pressed={state.filter === filter.value} onClick={() => set({ filter: filter.value })}>{filter.label}</Button>)}</div>{state.filter === "agent_inactive_14d" ? <p className="mt-3 text-caption text-text-muted">Paired at least once; newest recorded device activity is older than 14 days. Missing activity is unknown and excluded.</p> : null}</Card>
    <AdminMobileSort columns={columns} sort={sort} />
    <AdminTable columns={columns} rows={rows} sort={sort} rowKey={row => row.userId} rowHref={row => `/admin/users/${encodeURIComponent(row.userId)}`} loading={!data && request.isLoading} updating={!!data && request.isValidating} caption="User accounts"
      error={request.error ? <RequestError error={request.error} onRetry={() => request.mutate()} /> : null} empty={<Card padded><EmptyStatePanel title="No matching users" description="Try a wider search or another account filter." action={<Button variant="secondary" onClick={() => { set({ q: "", filter: "all" }); void request.mutate(); }}>Clear filters</Button>} /></Card>} />
    <AdminPagination hasPrev={page > 1 || !!state.before} hasNext={!!(data?.hasMore ?? data?.nextBefore)} onPrev={() => set({ page: Math.max(1, page - 1), before: "" })} onNext={() => set({ page: page + 1, before: "" })} label={state.before ? `${rows.length} of ${total.toLocaleString()} users · legacy activity page` : `${start.toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()} users`} loading={request.isValidating} itemCount={rows.length} />
  </div>;
}
export default function AdminUsersPage() { return <Suspense fallback={<LoadingRows rows={8} />}><UsersBody /></Suspense>; }
