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
import { BreakdownList } from "../../../components/BreakdownList";
import { compactNumber, timeSince, raceLabel, pctLabel } from "../../../components/format";
import {
  ForbiddenCard,
  LoadingRows,
  MetricStat,
} from "../../../components/AdminFragments";
import {
  fmtDate,
  fmtDuration,
} from "../../../components/AdminGameDetail";
import { ResultBadge } from "../../../components/ResultBadge";
import type {
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
          <GamesSection pulseId={pulseId} />
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

function GamesSection({ pulseId }: { pulseId: string }) {
  const [view, setView] = useAdminQueryState({ game: "", owner: "", before: "" });
  const before = view.before;
  const paging = useAdminCursor(before, before => setView({ before }));
  const query = new URLSearchParams();
  query.set("limit", String(PAGE_SIZE));
  if (before) query.set("before", before);
  const { data, error, isLoading, isValidating, mutate } = useApi<GlobalPlayerGamesResp>(
    `/v1/admin/global/players/${encodeURIComponent(
      pulseId,
    )}/games?${query.toString()}`, { keepPreviousData: true },
  );

  const selected = data?.items.find(g => g.gameId === view.game && g.userId === view.owner);

  return (
    <div className="space-y-3">
      <h2 className="text-xl font-semibold">All games</h2>

      {error && data ? <RequestError error={error} onRetry={() => mutate()} /> : null}
      {error && !data ? (
        <RequestError error={error} onRetry={() => mutate()} />
      ) : isLoading && !data ? (
        <LoadingRows rows={8} />
      ) : (!data || data.items.length === 0) && !view.game ? (
        <Card padded>
          <EmptyStatePanel title="No games recorded against this player" action={<Button variant="secondary" onClick={() => void mutate()}>Refresh</Button>} />
        </Card>
      ) : (
        <div className="lg:grid lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)] lg:gap-4">
          {/* Games list — hidden on mobile once a game is selected. */}
          <div className={view.game ? "hidden lg:block" : "block"}>
            <Card padded={false}>
              <p role="status" className="text-caption text-text-muted">{data?.items.length || 0} games{data && isValidating ? " · Updating…" : ""}</p>
              <ul aria-busy={isValidating} className={`divide-y divide-border transition-opacity ${isValidating ? "opacity-60" : ""}`}>
                {(data?.items || []).map((g) => {
                  const active = g.gameId === view.game && g.userId === view.owner;
                  return (
                    <li key={`${g.userId}:${g.gameId}`}>
                      <button
                        type="button"
                        aria-current={active ? "true" : undefined}
                        onClick={() => setView({ game: g.gameId, owner: g.userId })}
                        className={[
                          "flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors",
                          active ? "bg-accent/10" : "hover:bg-bg-elevated/40",
                        ].join(" ")}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <ResultBadge result={g.result} />
                          <span className="text-caption text-text-dim">
                            {fmtDate(g.date)}
                          </span>
                        </div>
                        <div className="text-caption text-text-muted">
                          {(g.myRace || "?")[0]}v{(g.opponent.race || "?")[0]}
                          {" · "}
                          {g.map || "—"}
                          {" · "}
                          {fmtDuration(g.durationSec)}
                        </div>
                        <div className="truncate text-caption text-text-dim">
                          {g.userEmail || g.userId}
                          {g.opponent.strategy ? ` · ${g.opponent.strategy}` : ""}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Card>

            <AdminPagination hasPrev={paging.hasPrev} prevLabel={paging.prevLabel} hasNext={!!data?.nextBefore} onPrev={paging.previous} onNext={() => paging.next(data?.nextBefore || "")} label={paging.page} loading={isValidating} itemCount={data?.items.length || 0} />
          </div>

          {/* Detail — hidden on mobile until a game is selected. */}
          <div className={view.game ? "block" : "hidden lg:block"}>
            {view.game ? (
              <AdminSelectedGame userId={view.owner} gameId={view.game} row={selected} onClear={() => setView({ game: "", owner: "" })} />
            ) : (
              <Card padded>
                <p className="text-text-muted">
                  Select a game to view its build orders, APM, and macro.
                </p>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function AdminGlobalPlayerPage(props: { params: Promise<{ pulseId: string }> }) { return <Suspense fallback={<LoadingRows rows={8} />}><GlobalPlayerBody {...props} /></Suspense>; }
