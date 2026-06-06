"use client";

import { use, useState } from "react";
import Link from "next/link";

import { useApi } from "@/lib/clientApi";
import { Card } from "@/components/ui/Card";
import { compactNumber, timeSince } from "../../../components/format";
import {
  ForbiddenCard,
  LoadingRows,
  MetricStat,
} from "../../../components/AdminFragments";
import {
  AdminGameDetail,
  fmtDate,
  fmtDuration,
  isWin,
} from "../../../components/AdminGameDetail";
import type {
  GlobalBreakdownRow,
  GlobalPlayerGameRow,
  GlobalPlayerGamesResp,
  GlobalPlayerProfilePerUser,
  GlobalPlayerProfileResp,
} from "../../../components/adminTypes";

const PAGE_SIZE = 50;

function raceLabel(race: string): string {
  if (!race || race === "U") return "Unknown";
  return race;
}

function pctLabel(frac: number): string {
  if (!Number.isFinite(frac)) return "—";
  return `${Math.round(frac * 100)}%`;
}

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
export default function AdminGlobalPlayerPage({
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
      <header className="space-y-2">
        <Link
          href="/admin/global"
          className="text-caption text-text-dim hover:text-text"
        >
          ← Global players
        </Link>
        <h1 className="text-3xl font-bold">
          {profile.data?.displayNameSample || "Player"}
        </h1>
        <p className="break-all font-mono text-caption text-text-dim">
          {pulseId}
        </p>
        <p className="text-text-muted">
          Everything the platform knows about this player, merged across
          every user who has faced them — combined record, who&apos;s
          tracking them, the strategies they play, and every game on
          record. Click a game for its full build order and macro.
        </p>
      </header>

      {profile.isLoading && !profile.data ? (
        <LoadingRows rows={5} />
      ) : profile.error ? (
        <Card padded>
          <p className="text-danger">
            {profile.error.status === 404
              ? "No platform user is tracking this player."
              : `Failed to load profile: ${profile.error.message}`}
          </p>
        </Card>
      ) : profile.data ? (
        <>
          <SummarySection data={profile.data} />
          <PerUserSection rows={profile.data.perUser} pulseId={pulseId} />
          <div className="grid gap-4 lg:grid-cols-2">
            <BreakdownCard
              title="Their strategies"
              subtitle="across every user's games"
              rows={profile.data.strategies}
            />
            <BreakdownCard
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

function PerUserSection({
  rows,
  pulseId,
}: {
  rows: GlobalPlayerProfilePerUser[];
  pulseId: string;
}) {
  return (
    <div className="space-y-3">
      <h2 className="text-xl font-semibold">Tracked by</h2>
      <Card padded={false}>
        {/* Mobile: stacked list. Desktop: table. */}
        <div className="block md:hidden">
          <ul className="divide-y divide-border">
            {rows.map((u) => (
              <li key={u.userId} className="flex flex-col gap-2 px-4 py-3">
                <div className="flex items-baseline justify-between gap-2">
                  <Link
                    href={`/admin/users/${encodeURIComponent(u.userId)}/opponents`}
                    className="truncate text-body font-semibold text-accent-cyan hover:underline"
                  >
                    {u.email || u.userId}
                  </Link>
                  <span className="shrink-0 text-caption text-text-dim">
                    {timeSince(u.lastSeen)}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-text-muted">
                  <span>
                    <strong className="text-text">{u.gameCount}</strong> games
                  </span>
                  <span>
                    <span className="text-success">{u.wins}</span>
                    <span className="text-text-dim">–</span>
                    <span className="text-danger">{u.losses}</span>
                  </span>
                  <span>{pctLabel(u.winRate)} WR</span>
                  {u.mmr !== null ? <span>{u.mmr} MMR</span> : null}
                </div>
                <Link
                  href={`/admin/users/${encodeURIComponent(
                    u.userId,
                  )}/opponents/${encodeURIComponent(pulseId)}`}
                  className="text-caption text-accent-cyan hover:underline"
                >
                  View this user&apos;s games →
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
                <th className="px-4 py-3 text-right font-semibold">W–L</th>
                <th className="px-4 py-3 text-right font-semibold">Win&nbsp;%</th>
                <th className="px-4 py-3 text-right font-semibold">MMR</th>
                <th className="px-4 py-3 text-right font-semibold">Last seen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((u) => (
                <tr key={u.userId} className="hover:bg-bg-elevated/30">
                  <td className="px-4 py-2">
                    <Link
                      href={`/admin/users/${encodeURIComponent(
                        u.userId,
                      )}/opponents`}
                      className="text-accent-cyan hover:underline"
                    >
                      {u.email || u.userId}
                    </Link>
                    <div className="font-mono text-caption text-text-dim">
                      {u.userId}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-text">
                    {u.gameCount}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    <span className="text-success">{u.wins}</span>
                    <span className="text-text-dim">–</span>
                    <span className="text-danger">{u.losses}</span>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-text-muted">
                    {pctLabel(u.winRate)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-text-muted">
                    {u.mmr !== null ? u.mmr : "—"}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-text-muted">
                    {timeSince(u.lastSeen)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function BreakdownCard({
  title,
  subtitle,
  rows,
}: {
  title: string;
  subtitle: string;
  rows: GlobalBreakdownRow[];
}) {
  const max = rows.length > 0 ? rows[0].count : 0;
  return (
    <Card padded={false}>
      <Card.Header>
        <h3 className="text-caption font-semibold uppercase tracking-wider text-text">
          {title}
        </h3>
        <span className="text-caption text-text-dim">{subtitle}</span>
      </Card.Header>
      {rows.length === 0 ? (
        <div className="px-4 py-6 text-caption text-text-muted">
          No data yet.
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li key={row.key} className="px-4 py-2.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-body text-text" title={row.key}>
                  {row.key}
                </span>
                <span className="shrink-0 text-caption tabular-nums text-text-muted">
                  {compactNumber(row.count)} · {pctLabel(row.winRate)} WR
                </span>
              </div>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-bg-elevated">
                <div
                  className="h-full rounded-full bg-accent-cyan/70"
                  style={{
                    width: `${max > 0 ? Math.max(3, (row.count / max) * 100) : 0}%`,
                  }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function GamesSection({ pulseId }: { pulseId: string }) {
  const [before, setBefore] = useState<string | null>(null);
  const [pageHistory, setPageHistory] = useState<Array<string | null>>([null]);
  const [selected, setSelected] = useState<GlobalPlayerGameRow | null>(null);

  const query = new URLSearchParams();
  query.set("limit", String(PAGE_SIZE));
  if (before) query.set("before", before);
  const { data, error, isLoading } = useApi<GlobalPlayerGamesResp>(
    `/v1/admin/global/players/${encodeURIComponent(
      pulseId,
    )}/games?${query.toString()}`,
  );

  function nextPage() {
    if (data?.nextBefore) {
      setPageHistory((h) => [...h, data.nextBefore]);
      setBefore(data.nextBefore);
      setSelected(null);
    }
  }
  function prevPage() {
    if (pageHistory.length <= 1) return;
    const popped = pageHistory.slice(0, -1);
    setPageHistory(popped);
    setBefore(popped[popped.length - 1] ?? null);
    setSelected(null);
  }

  return (
    <div className="space-y-3">
      <h2 className="text-xl font-semibold">All games</h2>

      {isLoading && !data ? (
        <LoadingRows rows={8} />
      ) : error ? (
        <Card padded>
          <p className="text-danger">Failed to load games: {error.message}</p>
        </Card>
      ) : !data || data.items.length === 0 ? (
        <Card padded>
          <p className="text-text-muted">No games recorded against this player.</p>
        </Card>
      ) : (
        <div className="lg:grid lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)] lg:gap-4">
          {/* Games list — hidden on mobile once a game is selected. */}
          <div className={selected ? "hidden lg:block" : "block"}>
            <Card padded={false}>
              <ul className="divide-y divide-border">
                {data.items.map((g) => {
                  const active = selected?.gameId === g.gameId;
                  return (
                    <li key={`${g.userId}:${g.gameId}`}>
                      <button
                        type="button"
                        onClick={() => setSelected(g)}
                        className={[
                          "flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors",
                          active ? "bg-accent/10" : "hover:bg-bg-elevated/40",
                        ].join(" ")}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={[
                              "rounded-full px-2 py-0.5 text-caption font-semibold",
                              isWin(g.result)
                                ? "bg-success/15 text-success"
                                : "bg-danger/15 text-danger",
                            ].join(" ")}
                          >
                            {isWin(g.result) ? "Win" : "Loss"}
                          </span>
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

            <div className="mt-3 flex items-center justify-between gap-3">
              <button
                type="button"
                className="inline-flex items-center gap-2 hard-press rounded-full px-5 py-[0.55rem] font-display font-bold border-2 border-line bg-bg-surface text-text hover:bg-bg-elevated text-sm disabled:cursor-not-allowed disabled:opacity-50"
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
                className="inline-flex items-center gap-2 hard-press rounded-full px-5 py-[0.55rem] font-display font-bold border-2 border-line bg-bg-surface text-text hover:bg-bg-elevated text-sm disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!data.nextBefore}
                onClick={nextPage}
              >
                Next →
              </button>
            </div>
          </div>

          {/* Detail — hidden on mobile until a game is selected. */}
          <div className={selected ? "block" : "hidden lg:block"}>
            {selected ? (
              <AdminGameDetail
                userId={selected.userId}
                game={selected}
                onBack={() => setSelected(null)}
              />
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
