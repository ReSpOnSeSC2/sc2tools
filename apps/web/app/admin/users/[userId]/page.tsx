"use client";
import { use } from "react";
import Link from "next/link";
import { useApi } from "@/lib/clientApi";
import { Card } from "@/components/ui/Card";
import { ResultBadge } from "@/components/ui/ResultBadge";
import { RequestError } from "@/components/ui/RequestError";
import { AdminActionCard } from "../../components/AdminActionCard";
import { SupportSnapshot } from "../../components/SupportSnapshot";
import { AdminRoleCard } from "../../components/AdminRoleCard";
import { AdminPageHeader } from "../../components/AdminPageHeader";
import { AdminTable, type AdminColumn } from "../../components/AdminTable";
import { AdminIdCopy } from "../../components/AdminIdCopy";
import { AdminDate } from "../../components/AdminDate";
import { AdminUserActivity } from "../../components/AdminUserActivity";
import { ForbiddenCard, LoadingRows, MetricStat } from "../../components/AdminFragments";
import { compactNumber } from "../../components/format";
import type { AdminUserDetail } from "../../components/adminTypes";

export default function AdminUserDetailPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = use(params);
  return <UserDetail key={userId} userId={userId} />;
}
function UserDetail({ userId }: { userId: string }) {
  const request = useApi<AdminUserDetail>(`/v1/admin/users/${encodeURIComponent(userId)}`);
  if (request.error?.status === 403) return <ForbiddenCard />;
  const header = <AdminPageHeader anchor="users-and-repairing-data" title="User" description="Account identity, activity and targeted data tools." actions={<Link href="/admin/users" className="text-caption text-text-dim hover:text-text">← All users</Link>} />;
  if (request.error) return <div className="space-y-6">{header}<RequestError error={request.error} onRetry={() => request.mutate()} /></div>;
  if (!request.data || request.isPreviousData) return <div className="space-y-6">{header}<LoadingRows rows={8} /></div>;
  const data = request.data, decided = data.games.wins + data.games.losses;
  const wipeGameCount = data.wipeGameCount ?? data.games.total;
  const opponentHref = (pulseId: string) => `/admin/users/${encodeURIComponent(data.userId)}/opponents/${encodeURIComponent(pulseId)}`;
  const opponents: AdminColumn<AdminUserDetail["opponents"]["top"][number]>[] = [
    { key: "name", label: "Opponent", mobile: "title", render: row => <><span>{row.displayNameSample || "Unknown"}</span><code className="block break-all text-micro text-text-muted">{row.pulseId}</code></> },
    { key: "race", label: "Race", mobile: "field", render: row => row.race || "—" },
    { key: "games", label: "Games", align: "right", mobile: "field", render: row => row.gameCount },
    { key: "record", label: "Record", align: "right", mobile: "field", render: row => `${row.wins} W · ${row.losses} L` },
  ];
  const games: AdminColumn<AdminUserDetail["recentGames"][number]>[] = [
    { key: "map", label: "Map", mobile: "title", render: row => row.map || "Unknown map" },
    { key: "date", label: "Date", mobile: "field", render: row => <AdminDate value={row.date} /> },
    { key: "opponent", label: "Opponent", mobile: "field", render: row => <span className="[overflow-wrap:anywhere]">{row.opponent.name || "Unknown"}<code className="block text-micro text-text-muted">{row.opponent.pulseId || "ID unavailable"}</code></span> },
    { key: "result", label: "Result", mobile: "field", render: row => <ResultBadge result={row.result} /> },
  ];
  return <div className="space-y-6">{header}<p className="break-all text-body">{data.email || data.userId}</p>
    <div className="space-y-2"><AdminIdCopy label="userId" value={data.userId} />{data.clerkUserId ? <AdminIdCopy label="clerkUserId" value={data.clerkUserId} /> : null}</div>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <MetricStat label="Games" value={compactNumber(data.games.total)} caption={`${data.games.wins} W · ${data.games.losses} L`} />
      <MetricStat label="Win rate" value={decided ? `${Math.round(100 * data.games.wins / decided)}%` : "—"} caption={decided ? `${decided} decided games` : "No decided games"} />
      <MetricStat label="Opponents" value={compactNumber(data.opponents.total)} />
      <MetricStat label="Last activity" value={<AdminDate value={data.games.lastActivity} />} />
      <MetricStat label="Last sign-in" value={<AdminDate value={data.lastSeenAt} />} />
      <MetricStat label="First replay" value={<AdminDate value={data.games.firstActivity} />} />
      <MetricStat label="Signed up" value={<AdminDate value={data.createdAt} />} caption={data.createdAt ? new Date(data.createdAt).toLocaleString() : undefined} />
    </div>
    <div className="grid gap-4 lg:grid-cols-2"><AdminRoleCard userId={data.userId} isAdmin={data.isAdmin} grantable={Boolean(data.clerkUserId)} onDone={() => request.mutate()} /><AdminActionCard action="rebuild-opponents" user={{ userId: data.userId, email: data.email, gameCount: data.games.total }} onDone={() => void request.mutate()} /><div className="space-y-2">{wipeGameCount > data.games.total ? <p className="text-caption text-text-muted">The wipe also includes {wipeGameCount - data.games.total} {wipeGameCount - data.games.total === 1 ? "record" : "records"} already pending deletion.</p> : null}<AdminActionCard action="wipe-games" user={{ userId: data.userId, email: data.email, gameCount: wipeGameCount }} onDone={() => void request.mutate()} /></div></div>
    <SupportSnapshot userId={data.userId} />
    <section className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-h3">Recent opponents</h2><Link className="text-caption text-accent hover:underline" href={`/admin/users/${encodeURIComponent(data.userId)}/opponents`}>View all {compactNumber(data.opponents.total)} →</Link></div><AdminTable columns={opponents} rows={data.opponents.top} rowKey={row => row.pulseId} rowHref={row => row.pulseId ? opponentHref(row.pulseId) : undefined} caption="Recent opponents" empty={<Card padded>No opponents yet.</Card>} /></section>
    <section className="space-y-3"><h2 className="text-h3">Recent games</h2><AdminTable columns={games} rows={data.recentGames || []} rowKey={row => row.gameId} rowHref={row => row.opponent.pulseId ? `${opponentHref(row.opponent.pulseId)}?game=${encodeURIComponent(row.gameId)}` : undefined} caption="Recent games" empty={<Card padded>No games yet.</Card>} /></section>
    <AdminUserActivity userId={data.userId} />
  </div>;
}
