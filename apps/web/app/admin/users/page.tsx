"use client";

import { useState } from "react";
import Link from "next/link";

import { useApi } from "@/lib/clientApi";
import { Card } from "@/components/ui/Card";
import { compactNumber, timeSince } from "../components/format";
import { ForbiddenCard, LoadingRows } from "../components/AdminFragments";
import type { UsersListResp } from "../components/adminTypes";

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
  const [before, setBefore] = useState<string | null>(null);
  const [pageHistory, setPageHistory] = useState<Array<string | null>>([null]);

  const params = new URLSearchParams();
  params.set("limit", "50");
  if (search.trim()) params.set("search", search.trim());
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
          Sorted by most recent activity. Click a row to open the
          per-user detail with rebuild / wipe actions.
        </p>
      </header>

      <Card padded>
        <label className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
          <span className="text-caption font-semibold uppercase tracking-wider text-text-dim">
            Search
          </span>
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setBefore(null);
              setPageHistory([null]);
            }}
            placeholder="userId or clerkUserId fragment…"
            className="w-full rounded-lg border border-border bg-bg-surface px-3 py-2 font-mono text-sm text-text placeholder:text-text-dim focus:border-accent focus:outline-none"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
          />
        </label>
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
                        <span className="truncate font-mono text-body font-semibold text-text">
                          {u.userId}
                        </span>
                        <span className="text-caption text-text-dim">
                          {timeSince(u.lastActivity)}
                        </span>
                      </div>
                      {u.clerkUserId ? (
                        <span className="font-mono text-caption text-text-dim">
                          {u.clerkUserId}
                        </span>
                      ) : null}
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
                    <th className="px-4 py-3 text-right font-semibold">First</th>
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
                          <div className="font-mono text-text">{u.userId}</div>
                          {u.clerkUserId ? (
                            <div className="font-mono text-caption text-text-dim">
                              {u.clerkUserId}
                            </div>
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
              className="btn btn-secondary text-sm disabled:cursor-not-allowed disabled:opacity-50"
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
              className="btn btn-secondary text-sm disabled:cursor-not-allowed disabled:opacity-50"
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
