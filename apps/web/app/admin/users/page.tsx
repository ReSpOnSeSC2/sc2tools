"use client";
import { Suspense } from "react";
import { useApi } from "@/lib/clientApi";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { RequestError } from "@/components/ui/RequestError";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { AdminPageHeader } from "../components/AdminPageHeader";
import { AdminPagination } from "../components/AdminPagination";
import { AdminSearchField } from "../components/AdminSearchField";
import { AdminTable, type AdminColumn } from "../components/AdminTable";
import { ForbiddenCard, LoadingRows } from "../components/AdminFragments";
import { useAdminQueryState } from "../components/useAdminQueryState";
import { useAdminCursor } from "../components/useAdminCursor";
import { timeSince } from "../components/format";
import type { AdminUserRow, UsersListResp } from "../components/adminTypes";

const filters = [{ value: "all", label: "All" }, { value: "with_games", label: "Has games" }, { value: "no_games", label: "No games yet" }, { value: "with_agent", label: "Has agent" }];
const columns: AdminColumn<AdminUserRow>[] = [
  { key: "user", label: "User", mobile: "title", render: row => <><span>{row.email || "(no email on file)"}</span><span className="block break-all font-mono text-caption text-text-muted">{row.clerkUserId || row.userId}</span>{row.hasAgent ? <AgentBadge lastSeen={row.agentLastSeenAt} /> : null}</> },
  { key: "games", label: "Games", align: "right", mobile: "field", render: row => row.gameCount.toLocaleString() },
  { key: "opponents", label: "Opponents", align: "right", mobile: "field", render: row => row.opponentCount.toLocaleString() },
  { key: "lastActivity", label: "Last activity", align: "right", mobile: "field", render: row => timeSince(row.lastActivity) },
  { key: "firstActivity", label: "First replay", align: "right", mobile: "field", render: row => timeSince(row.firstActivity) },
];
/** Search matches email, internal ID and Clerk ID; the activity cursor is shareable. */
function UsersBody() {
  const [state, set] = useAdminQueryState({ q: "", filter: "all", before: "" }, { allowed: { filter: filters.map(filter => filter.value) } });
  const paging = useAdminCursor(state.before, before => set({ before }));
  const params = new URLSearchParams({ limit: "50" });
  if (state.q.trim()) params.set("search", state.q.trim());
  if (state.filter !== "all") params.set("filter", state.filter);
  if (state.before) params.set("before", state.before);
  const request = useApi<UsersListResp>(`/v1/admin/users?${params}`, { keepPreviousData: true });
  if (request.error?.status === 403) return <ForbiddenCard />;
  return <div className="space-y-6"><AdminPageHeader anchor="users-and-repairing-data" title="Users" description="Find accounts and inspect their activity before repairing data." />
    <Card padded><AdminSearchField value={state.q} onChange={q => set({ q })} placeholder="Email, userId, or Clerk ID" /><div className="mt-3 flex flex-wrap gap-2">{filters.map(filter => <Button key={filter.value} variant="secondary" size="sm" aria-pressed={state.filter === filter.value} onClick={() => set({ filter: filter.value })}>{filter.label}</Button>)}</div></Card>
    <AdminTable columns={columns} rows={request.data?.items || []} rowKey={row => row.userId} rowHref={row => `/admin/users/${encodeURIComponent(row.userId)}`} loading={!request.data && request.isLoading} updating={!!request.data && request.isValidating} caption="User accounts"
      error={request.error ? <RequestError error={request.error} onRetry={() => request.mutate()} /> : null} empty={<Card padded><EmptyStatePanel title="No matching users" description="Try a wider search or another account filter." action={<Button variant="secondary" onClick={() => { set({ q: "", filter: "all" }); void request.mutate(); }}>Clear filters</Button>} /></Card>} />
    <AdminPagination hasPrev={paging.hasPrev} prevLabel={paging.prevLabel} hasNext={!!request.data?.nextBefore} onPrev={paging.previous} onNext={() => paging.next(request.data?.nextBefore || "")} label={paging.page} loading={request.isValidating} itemCount={request.data?.items.length || 0} />
  </div>;
}
export default function AdminUsersPage() { return <Suspense fallback={<LoadingRows rows={8} />}><UsersBody /></Suspense>; }

/**
 * Small pill marking a user who has paired at least one agent, with the
 * most recent agent heartbeat. Surfaces the "is this user actually
 * running the agent?" signal right in the list.
 */
function AgentBadge({ lastSeen }: { lastSeen: string | null }) {
  return (
    <span className="mt-1 inline-flex w-fit items-center gap-1 rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-micro font-medium text-success">
      <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
      Agent
      {lastSeen ? (
        <span className="text-success/80">· {timeSince(lastSeen)}</span>
      ) : null}
    </span>
  );
}
