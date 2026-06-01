"use client";

import { useState } from "react";
import Link from "next/link";

import { useApi } from "@/lib/clientApi";
import { Card } from "@/components/ui/Card";
import { compactNumber, timeSince } from "../components/format";
import { ForbiddenCard, LoadingRows } from "../components/AdminFragments";
import type { UserListFilter, UsersListResp } from "../components/adminTypes";

const FILTERS: ReadonlyArray<{ value: UserListFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "with_games", label: "Has games" },
  { value: "no_games", label: "No games yet" },
  { value: "with_agent", label: "Has agent" },
];

/**
 * /admin/users — paginated list of users sorted by lastActivity.
 *
 * The list is the entry point for everything the Tools tab can do
 * to a single user; clicking a row navigates to ``/admin/users/<id>``
 * which renders a per-user detail with one-click actions.
 *
 * Search uses the API's ``search`` query, which is a case-insensitive
 * regex against ``userId`` / ``clerkUserId`` (no PII fields). The
 * page is intentionally not infinite-scroll — pagination is keyed on
 * the lastActivity cursor so the URL always points at a stable page.
 */
export default function AdminUsersPage() {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<UserListFilter>("all");
  const [before, setBefore] = useState<string | null>(null);
  const [pageHistory, setPageHistory] = useState<Array<string | null>>([null]);

  // Search / filter changes invalidate the cursor — jump back to page 1.
  function resetPaging() {
    setBefore(null);
    setPageHistory([null]);
  }

  const params = new URLSearchParams();
  params.set("limit", "50");
  if (search.trim()) params.set("search", search.trim());
  if (filter !== "all") params.set("filter", filter);
  if (before) params.set("before", before);
  const path = `/v1/admin/users?${params.toString()}`;

  const { data, error, isLoading } = useApi<UsersListResp>(path);

  function nextPage() {
    if (data?.nextBefore) {
      setPageHistory((h) => [...h, data.nextBefore]);
      setBefore(data.nextBefore);
    }
  }
  function prevPage() {
    if (pageHistory.length <= 1) return;
    const popped = pageHistory.slice(0, -1);
    setPageHistory(popped);
    setBefore(popped[popped.length - 1] ?? null);
  }

  if (error && error.status === 403) return <ForbiddenCard />;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold">Users</h1>
        <p className="text-text-muted">
          All users, sorted by most recent activity (users with no games
          yet appear by last sign-in). Click a row to open the per-user
          detail with rebuild / wipe actions.
        </p>
      </header>

      <Card padded>
        <div className="space-y-3">
          <label className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
            <span className="text-caption font-semibold uppercase tracking-wider text-text-dim">
              Search
            </span>
            <input
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                resetPaging();
              }}
              placeholder="email, userId, or clerkUserId fragment…"
              className="w-full rounded-lg border border-border bg-bg-surface px-3 py-2 font-mono text-sm text-text placeholder:text-text-dim focus:border-accent focus:outline-none"
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-caption font-semibold uppercase tracking-wider text-text-dim">
              Filter
            </span>
            {FILTERS.map((f) => {
              const isActive = filter === f.value;
              return (
                <button
                  key={f.value}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => {
                    setFilter(f.value);
                    resetPaging();
                  }}
                  className={[
                    "rounded-full border px-3 py-1 text-caption transition-colors",
                    isActive
                      ? "border-accent-cyan/60 bg-accent-cyan/15 text-text"
                      : "border-border bg-bg-surface text-text-muted hover:bg-bg-elevated hover:text-text",
                  ].join(" ")}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
        </div>
      </Card>

      {isLoading ? (
        <LoadingRows rows={10} />
      ) : error ? (
        <Card padded>
          <p className="text-danger">Failed to load users: {error.message}</p>
        </Card>
      ) : !data || data.items.length === 0 ? (
        <Card padded>
          <p className="text-text-muted">No matching users.</p>
        </Card>
      ) : (
        <>
          {/* Mobile: stacked list. Desktop: table. */}
          <Card padded={false}>
            <div className="block md:hidden">
              <ul className="divide-y divide-border">
                {data.items.map((u) => (
                  <li key={u.userId}>
                    <Link
                      href={`/admin/users/${encodeURIComponent(u.userId)}`}
                      className="flex flex-col gap-2 px-4 py-3 hover:bg-bg-elevated/40"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-body font-semibold text-text">
                          {u.email ?? "(no email on file)"}
                        </span>
                        <span className="text-caption text-text-dim">
                          {timeSince(u.lastActivity)}
                        </span>
                      </div>
                      <span className="truncate font-mono text-caption text-text-dim">
                        {u.clerkUserId ?? u.userId}
                      </span>
                      <div className="flex items-center gap-3 text-caption text-text-muted">
                        <span>
                          <strong className="text-text">
                            {compactNumber(u.gameCount)}
                          </strong>{" "}
                          games
                        </span>
                        <span>
                          <strong className="text-text">
                            {compactNumber(u.opponentCount)}
                          </strong>{" "}
                          opponents
                        </span>
                        {u.hasAgent ? (
                          <AgentBadge lastSeen={u.agentLastSeenAt} />
                        ) : null}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
            <div className="hidden md:block">
              <table className="w-full text-sm">
                <thead className="bg-bg-elevated/40 text-left text-caption uppercase tracking-wider text-text-dim">
                  <tr>
                    <th className="px-4 py-3 font-semibold">User</th>
                    <th className="px-4 py-3 text-right font-semibold">Games</th>
                    <th className="px-4 py-3 text-right font-semibold">
                      Opponents
                    </th>
                    <th className="px-4 py-3 text-right font-semibold">
                      Last activity
                    </th>
                    <th
                      className="px-4 py-3 text-right font-semibold"
                      title="Date of the user's earliest replay in the database"
                    >
                      First replay
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.items.map((u) => (
                    <tr
                      key={u.userId}
                      className="cursor-pointer transition-colors hover:bg-bg-elevated/30"
                    >
                      <td className="px-4 py-2">
                        <Link
                          href={`/admin/users/${encodeURIComponent(u.userId)}`}
                          className="block"
                        >
                          <div className="font-medium text-text">
                            {u.email ?? "(no email on file)"}
                          </div>
                          <div className="font-mono text-caption text-text-dim">
                            {u.clerkUserId ?? u.userId}
                          </div>
                          {u.hasAgent ? (
                            <AgentBadge lastSeen={u.agentLastSeenAt} />
                          ) : null}
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-text">
                        {u.gameCount.toLocaleString()}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-text">
                        {u.opponentCount.toLocaleString()}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-text-muted">
                        {timeSince(u.lastActivity)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-text-muted">
                        {timeSince(u.firstActivity)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-lg px-4 py-[0.55rem] font-semibold transition-colors border border-border bg-bg-elevated text-text hover:bg-bg-subtle text-sm disabled:cursor-not-allowed disabled:opacity-50"
              disabled={pageHistory.length <= 1}
              onClick={prevPage}
            >
              ← Previous
            </button>
            <span className="text-caption text-text-dim">
              {data.items.length} on this page
            </span>
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-lg px-4 py-[0.55rem] font-semibold transition-colors border border-border bg-bg-elevated text-text hover:bg-bg-subtle text-sm disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!data.nextBefore}
              onClick={nextPage}
            >
              Next →
            </button>
          </div>
        </>
      )}
    </div>
  );
}

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
