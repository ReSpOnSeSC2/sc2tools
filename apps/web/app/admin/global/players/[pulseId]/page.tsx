"use client";
import { Button } from "@/components/ui/Button";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { RequestError } from "@/components/ui/RequestError";
import { AdminPagination } from "@/app/admin/components/AdminPagination";
import { AdminPageHeader } from "@/app/admin/components/AdminPageHeader";

import { Suspense, use } from "react";
import Link from "next/link";

import { useApi } from "@/lib/clientApi";
import { Card } from "@/components/ui/Card";
import { AdminTable, AdminMobileSort, type AdminColumn } from "../../../components/AdminTable";
import { useAdminQueryState } from "../../../components/useAdminQueryState";
import { useAdminCursor } from "../../../components/useAdminCursor";
import { AdminSelectedGame } from "../../../components/AdminSelectedGame";
import { AdminGamesMasterDetail } from "../../../components/AdminGamesMasterDetail";
import { AdminGameFilters } from "../../../components/AdminGameFilters";
import { RESULT_FILTERS, type AdminResultFilter } from "../../../components/adminResult";
import { BreakdownList } from "../../../components/BreakdownList";
import { compactNumber, timeSince, raceLabel, pctLabel } from "../../../components/format";
import {
  ForbiddenCard,
  LoadingRows,
  MetricStat,
} from "../../../components/AdminFragments";
import type {
  GlobalBreakdownRow,
  GlobalPlayerGamesResp,
  GlobalPlayerProfilePerUser,
  GlobalPlayerProfileResp,
} from "../../../components/adminTypes";

const PAGE_SIZE = 50;

/**
 * /admin/global/players/[pulseId] — admin-level profile for one real
 * SC2 account, merged across EVERY platform user who tracks them.
 *
 * Top: merged headline counters + a per-user breakdown (which users
 * have faced this player and their individual records) + the
 * opponent's strategy / map distributions. Bottom: a master/detail
 * games browser spanning all users — pick any game to see both build
 * orders, the APM/SPM curve, and the macro breakdown (reusing the same
 * AdminGameDetail renderer as the per-user opponent drill-down).
 */
function GlobalPlayerBody({
  params,
}: {
  params: Promise<{ pulseId: string }>;
}) {
  const { pulseId } = use(params);
  const profile = useApi<GlobalPlayerProfileResp>(
    `/v1/admin/global/players/${encodeURIComponent(pulseId)}`,
  );

  if (profile.error?.status === 403) return <ForbiddenCard />;

  return (
    <div className="space-y-6">
      <AdminPageHeader anchor="global-trends" title="Global player" description="Cross-user player statistics and recent games." actions={<><Link
          href="/admin/global"
          className="text-caption text-text-dim hover:text-text"
        >
          ← Global players
        </Link></>} />
      <p className="break-all text-body text-text">{profile.data?.displayNameSample || "Player"} · <span className="font-mono text-caption">{pulseId}</span></p>

      {profile.isLoading && !profile.data ? (
        <LoadingRows rows={5} />
      ) : profile.error ? (
        <RequestError error={profile.error} onRetry={() => profile.mutate()} />
      ) : profile.data ? (
        <>
          <SummarySection data={profile.data} />
          <PerUserSection rows={profile.data.perUser} pulseId={pulseId} />
          <div className="grid gap-4 lg:grid-cols-2">
            <BreakdownList
              title="Their strategies"
              subtitle="across every user's games"
              rows={profile.data.strategies}
            />
            <BreakdownList
              title="Maps faced on"
              subtitle="across every user's games"
              rows={profile.data.maps}
            />
          </div>
          <GamesSection pulseId={pulseId} maps={profile.data.maps} users={profile.data.perUser} />
        </>
      ) : null}
    </div>
  );
}

function SummarySection({ data }: { data: GlobalPlayerProfileResp }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <MetricStat
        label="Total games"
        value={compactNumber(data.gameCount)}
        caption={`${raceLabel(data.race)} · across all users`}
      />
      <MetricStat
        label="Record"
        value={`${data.wins}–${data.losses}`}
        caption="our wins – losses"
      />
      <MetricStat
        label="Win rate"
        value={pctLabel(data.winRate)}
        caption="from our perspective"
      />
      <MetricStat
        label="Tracked by"
        value={compactNumber(data.trackedByUsers)}
        caption={data.trackedByUsers === 1 ? "user" : "users"}
      />
      <MetricStat
        label="MMR"
        value={data.mmr !== null ? String(data.mmr) : "—"}
        caption={
          data.lastSeen ? `last seen ${timeSince(data.lastSeen)}` : "highest cached"
        }
      />
    </div>
  );
}

function PerUserSection({ rows, pulseId }: { rows: GlobalPlayerProfilePerUser[]; pulseId: string }) {
  const [view, set] = useAdminQueryState({ tableSort: "gameCount", tableOrder: "desc" }, { allowed: { tableSort: ["email", "gameCount", "winRate", "mmr", "lastSeen"], tableOrder: ["asc", "desc"] } });
  const columns: AdminColumn<GlobalPlayerProfilePerUser>[] = [
    { key: "user", label: "User", sortKey: "email", kind: "text", mobile: "title", render: row => <><span>{row.email || row.userId}</span><span className="block break-all font-mono text-caption text-text-muted">{row.userId}</span></> },
    { key: "games", label: "Games", sortKey: "gameCount", kind: "number", align: "right", mobile: "field", render: row => row.gameCount },
    { key: "record", label: "W–L", align: "right", mobile: "field", render: row => `${row.wins}–${row.losses}` },
    { key: "winRate", label: "Win rate", sortKey: "winRate", kind: "number", align: "right", mobile: "field", render: row => pctLabel(row.winRate) },
    { key: "mmr", label: "MMR", sortKey: "mmr", kind: "number", align: "right", mobile: "field", render: row => row.mmr ?? "—" },
    { key: "lastSeen", label: "Last seen", sortKey: "lastSeen", kind: "date", align: "right", mobile: "field", render: row => timeSince(row.lastSeen) },
  ];
  const sorted = [...rows].sort((a, b) => {
    const key = view.tableSort as "email" | "gameCount" | "winRate" | "mmr" | "lastSeen", left = a[key], right = b[key];
    if (left == null) return right == null ? 0 : 1; if (right == null) return -1;
    return (left < right ? -1 : left > right ? 1 : 0) * (view.tableOrder === "asc" ? 1 : -1);
  });
  const sort = { by: view.tableSort, dir: view.tableOrder as "asc" | "desc", onChange: (tableSort: string, tableOrder: "asc" | "desc") => set({ tableSort, tableOrder }) };
  return <section className="space-y-3"><h2 className="text-h2">Tracked by</h2><AdminMobileSort columns={columns} sort={sort} /><AdminTable columns={columns} rows={sorted} rowKey={row => row.userId} rowHref={row => `/admin/users/${encodeURIComponent(row.userId)}/opponents/${encodeURIComponent(pulseId)}`} sort={sort} caption="Users tracking this player" empty={<p>No users track this player.</p>} /></section>;
}

function GamesSection({ pulseId, maps, users }: { pulseId: string; maps: GlobalBreakdownRow[]; users: GlobalPlayerProfilePerUser[] }) {
  const [view, setView] = useAdminQueryState({ game: "", owner: "", before: "", result: "all", map: "", userId: "" }, { allowed: { result: RESULT_FILTERS } });
  const before = view.before;
  const result = view.result as AdminResultFilter;
  const paging = useAdminCursor(before, before => setView({ before }));
  const query = new URLSearchParams();
  query.set("limit", String(PAGE_SIZE));
  if (before) query.set("before", before);
  if (result !== "all") query.set("result", result);
  if (view.map) query.set("map", view.map);
  if (view.userId) query.set("userId", view.userId);
  const { data, error, isLoading, isValidating, mutate } = useApi<GlobalPlayerGamesResp>(
    `/v1/admin/global/players/${encodeURIComponent(
      pulseId,
    )}/games?${query.toString()}`, { keepPreviousData: true },
  );

  const items = data?.items || [];
  const selected = items.find(g => g.gameId === view.game && g.userId === view.owner);
  const filtered = result !== "all" || !!view.map || !!view.userId;

  return (
    <div className="space-y-3">
      <h2 className="text-xl font-semibold">All games</h2>

      {error && data ? <RequestError error={error} onRetry={() => mutate()} /> : null}
      {error && !data ? (
        <RequestError error={error} onRetry={() => mutate()} />
      ) : isLoading && !data ? (
        <LoadingRows rows={8} />
      ) : items.length === 0 && !view.game && !filtered ? (
        <Card padded>
          <EmptyStatePanel title="No games recorded against this player" action={<Button variant="secondary" onClick={() => void mutate()}>Refresh</Button>} />
        </Card>
      ) : (
        <AdminGamesMasterDetail
          games={items}
          gameKey={g => `${g.userId}:${g.gameId}`}
          selectedKey={view.game ? `${view.owner}:${view.game}` : null}
          onSelect={g => setView({ game: g.gameId, owner: g.userId })}
          label="Games against this player"
          busy={isValidating}
          status={<>{items.length === 0 && filtered ? "No games match these filters." : `${items.length} games`}{data && isValidating ? " · Updating…" : ""}</>}
          rowMeta={g => <span className="truncate text-caption text-text-dim">{g.userEmail || g.userId}{g.opponent.strategy ? ` · ${g.opponent.strategy}` : ""}</span>}
          filters={<div className="space-y-2">
            <AdminGameFilters result={result} map={view.map} maps={maps.map(row => row.key)}
              onResult={value => setView({ result: value })} onMap={value => setView({ map: value })}
              user={view.userId} users={users.map(row => ({ userId: row.userId, label: row.email || row.userId }))} onUser={value => setView({ userId: value })} />
            {filtered ? <Button size="sm" variant="ghost" onClick={() => setView({ result: "all", map: "", userId: "" })}>Clear filters</Button> : null}
          </div>}
          pagination={<AdminPagination hasPrev={paging.hasPrev} prevLabel={paging.prevLabel} hasNext={!!data?.nextBefore} onPrev={paging.previous} onNext={() => paging.next(data?.nextBefore || "")} label={paging.page} loading={isValidating} itemCount={items.length} />}
          detail={view.game ? <AdminSelectedGame userId={view.owner} gameId={view.game} row={selected} onClear={() => setView({ game: "", owner: "" })} /> : null}
          placeholder="Select a game to view its build orders, APM, and macro."
        />
      )}
    </div>
  );
}

export default function AdminGlobalPlayerPage(props: { params: Promise<{ pulseId: string }> }) { return <Suspense fallback={<LoadingRows rows={8} />}><GlobalPlayerBody {...props} /></Suspense>; }
