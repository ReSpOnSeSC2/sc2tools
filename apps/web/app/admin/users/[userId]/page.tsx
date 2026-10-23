"use client";
import { Button } from "@/components/ui/Button";
import { AdminActionCard } from "../../components/AdminActionCard";
import { SupportSnapshot } from "../../components/SupportSnapshot";
import { AdminRoleCard } from "../../components/AdminRoleCard";
import { RequestError } from "@/components/ui/RequestError";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { AdminPageHeader } from "@/app/admin/components/AdminPageHeader";

import { use } from "react";
import Link from "next/link";

import { useApi } from "@/lib/clientApi";
import { Card } from "@/components/ui/Card";
import {
  compactNumber,
  timeSince,
} from "../../components/format";
import {
  ForbiddenCard,
  MetricStat,
} from "../../components/AdminFragments";
import type {
  AdminUserDetail,
} from "../../components/adminTypes";

/**
 * /admin/users/[userId] — per-user detail snapshot + targeted
 * actions (rebuild opponents, wipe games).
 *
 * Reuses the same Tools-tab confirmation pattern: destructive
 * action → inline ConfirmInline → API call → result line. No modal.
 */
export default function AdminUserDetailPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const { userId } = use(params);
  const { data, error, isLoading, mutate } = useApi<AdminUserDetail>(
    `/v1/admin/users/${encodeURIComponent(userId)}`,
  );

  if (error?.status === 403) return <ForbiddenCard />;
  if (isLoading && !error) {
    return (
      <div className="space-y-6">
        <AdminPageHeader anchor="users-and-repairing-data" title="User" description="Account identity, activity and targeted data tools." /><div className="h-8 w-64 animate-pulse rounded bg-bg-elevated" />
        <div className="h-32 animate-pulse rounded-xl bg-bg-elevated" />
        <div className="h-64 animate-pulse rounded-xl bg-bg-elevated" />
      </div>
    );
  }
  if (error) {
    if (error.status === 403) return <ForbiddenCard />;
    return <div className="space-y-6"><AdminPageHeader anchor="users-and-repairing-data" title="User" description="Account identity, activity and targeted data tools." /><RequestError error={error} onRetry={() => mutate()} /></div>;
  }
  if (!data) return null;

  return (
    <div className="space-y-6">
      <AdminPageHeader anchor="users-and-repairing-data" title="User" description="Account identity, activity and targeted data tools." actions={<><Link
          href="/admin/users"
          className="text-caption text-text-dim hover:text-text"
        >
          ← All users
        </Link></>} /><p className="break-all text-body text-text">{data.email ?? data.userId}</p><p className="break-all font-mono text-caption text-text-dim">{data.userId}{data.clerkUserId ? " · Clerk: " + data.clerkUserId : ""}</p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricStat
          label="Games"
          value={compactNumber(data.games.total)}
          caption={`${data.games.wins} W · ${data.games.losses} L`}
        />
        <MetricStat
          label="Opponents"
          value={compactNumber(data.opponents.total)}
        />
        <MetricStat
          label="Last activity"
          value={timeSince(data.games.lastActivity)}
          caption={
            data.games.lastActivity
              ? new Date(data.games.lastActivity).toLocaleDateString()
              : ""
          }
        />
        <MetricStat
          label="Account age"
          value={timeSince(data.createdAt)}
          caption={
            data.createdAt
              ? new Date(data.createdAt).toLocaleDateString()
              : ""
          }
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <AdminRoleCard
          userId={data.userId}
          isAdmin={data.isAdmin}
          grantable={Boolean(data.clerkUserId)}
          onDone={() => mutate()}
        />
        <AdminActionCard action="rebuild-opponents" user={{userId:data.userId,email:data.email,gameCount:data.games.total}} onDone={() => void mutate()} />
        <AdminActionCard action="wipe-games" user={{userId:data.userId,email:data.email,gameCount:data.games.total}} onDone={() => void mutate()} />
      </div>

      <SupportSnapshot userId={data.userId} />
      <Card padded={false}>
        <Card.Header>
          <h3 className="text-caption font-semibold uppercase tracking-wider text-text">
            Recent opponents
          </h3>
          <div className="flex items-center gap-3">
            <span className="text-caption text-text-dim">
              5 most recently seen
            </span>
            <Link
              href={`/admin/users/${encodeURIComponent(data.userId)}/opponents`}
              className="text-caption font-medium text-accent hover:underline"
            >
              View all {compactNumber(data.opponents.total)} →
            </Link>
          </div>
        </Card.Header>
        {data.opponents.top.length === 0 ? (
          <EmptyStatePanel title="No opponents recorded yet" action={<Button variant="secondary" onClick={() => mutate()}>Refresh</Button>} />
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-bg-elevated/40 text-left text-caption uppercase tracking-wider text-text-dim">
              <tr>
                <th className="px-4 py-3 font-semibold">Opponent</th>
                <th className="px-4 py-3 font-semibold">Race</th>
                <th className="px-4 py-3 text-right font-semibold">Games</th>
                <th className="px-4 py-3 text-right font-semibold">W–L</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.opponents.top.map((o) => (
                <tr key={o.pulseId} className="hover:bg-bg-elevated/30">
                  <td className="px-4 py-2">
                    <div className="text-text">
                      {o.displayNameSample || "—"}
                    </div>
                    <div className="font-mono text-caption text-text-dim">
                      {o.pulseId}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-text-muted">{o.race || "—"}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-text">
                    {o.gameCount}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    <span className="text-success">{o.wins}</span>
                    <span className="text-text-dim">–</span>
                    <span className="text-danger">{o.losses}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

