"use client";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { AdminPagination } from "@/app/admin/components/AdminPagination";
import { Input } from "@/components/ui/Input";
import { RequestError } from "@/components/ui/RequestError";
import { AdminPageHeader } from "@/app/admin/components/AdminPageHeader";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { useApi, type ClientApiError } from "@/lib/clientApi";
import { Card } from "@/components/ui/Card";
import { Select } from "@/components/ui/Select";
import { compactNumber, timeSince } from "../components/format";
import {
  ForbiddenCard,
  LoadingRows,
  MetricStat,
} from "../components/AdminFragments";
import type {
  GlobalBreakdownRow,
  GlobalBreakdownsResp,
  GlobalPlayerSort,
  GlobalPlayersResp,
  GlobalSummaryResp,
} from "../components/adminTypes";

const PAGE_SIZE = 50;

const SORT_OPTIONS: ReadonlyArray<{ value: GlobalPlayerSort; label: string }> = [
  { value: "gameCount", label: "Games" },
  { value: "trackedByUsers", label: "Tracked by" },
  { value: "winRate", label: "Win rate" },
  { value: "wins", label: "Wins" },
  { value: "losses", label: "Losses" },
  { value: "lastSeen", label: "Last seen" },
  { value: "mmr", label: "MMR" },
];

function raceLabel(race: string): string {
  if (!race || race === "U") return "Unknown";
  return race;
}

function pctLabel(frac: number): string {
  if (!Number.isFinite(frac)) return "—";
  return `${Math.round(frac * 100)}%`;
}

/**
 * /admin/global — platform-wide tracking.
 *
 * Three stacked sections, each backed by its own admin endpoint:
 *   1. Summary counters (distinct players merged across users, raw
 *      opponent rows, users tracking, total games, shared SC2Pulse
 *      cache coverage).
 *   2. Global trend breakdowns — the most common opponent strategies,
 *      our builds, and maps across every user's games.
 *   3. A searchable, sortable global player browser: the same real
 *      opponent tracked by multiple users is merged into one row with a
 *      "tracked by N" count.
 */
export default function AdminGlobalPage() {
  const summary = useApi<GlobalSummaryResp>("/v1/admin/global/summary");
  const breakdowns = useApi<GlobalBreakdownsResp>("/v1/admin/global/breakdowns");

  if (summary.error?.status === 403 || breakdowns.error?.status === 403) {
    return <ForbiddenCard />;
  }

  return (
    <div className="space-y-6">
      <AdminPageHeader anchor="global-trends" title="Global players" description="Platform-wide players and aggregate activity." />
      <details className="text-caption text-text-muted"><summary>Learn more</summary><p className="text-text-muted">
          Everything the platform tracks, aggregated across every user —
          merged player records plus the most common strategies, builds,
          and maps. The same real opponent faced by several users is
          collapsed into a single record.
        </p></details>

      <SummarySection
        data={summary.data ?? null}
        error={summary.error ?? null}
        onRetry={() => summary.mutate()}
        isLoading={summary.isLoading}
      />

      <BreakdownsSection
        data={breakdowns.data ?? null}
        error={breakdowns.error ?? null}
        onRetry={() => breakdowns.mutate()}
        isLoading={breakdowns.isLoading}
      />

      <PlayersSection />
    </div>
  );
}

function SummarySection({
  data,
  error,
  isLoading,
  onRetry,
}: {
  data: GlobalSummaryResp | null;
  error: ClientApiError | null;
  isLoading: boolean;
  onRetry: () => unknown;
}) {
  if (error) {
    return <RequestError error={error} onRetry={onRetry} />;
  }
  if (isLoading && !data) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl bg-bg-elevated" />
        ))}
      </div>
    );
  }
  if (!data) return null;
  const resolvedPct =
    data.cache.total > 0
      ? Math.round((data.cache.resolved / data.cache.total) * 100)
      : 0;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <MetricStat
        label="Tracked players"
        value={compactNumber(data.trackedPlayers)}
        caption={`${compactNumber(data.opponentRows)} per-user rows`}
      />
      <MetricStat
        label="Users tracking"
        value={compactNumber(data.usersTracking)}
        caption="have ≥ 1 opponent"
      />
      <MetricStat
        label="Total games"
        value={compactNumber(data.totalGames)}
        caption="across all users"
      />
      <MetricStat
        label="Pulse resolved"
        value={compactNumber(data.cache.resolved)}
        caption={`${resolvedPct}% of ${compactNumber(data.cache.total)} cached`}
      />
      <MetricStat
        label="MMR cached"
        value={compactNumber(data.cache.mmrCached)}
        caption="shared across users"
      />
    </div>
  );
}

function BreakdownsSection({
  data,
  error,
  isLoading,
  onRetry,
}: {
  data: GlobalBreakdownsResp | null;
  error: ClientApiError | null;
  isLoading: boolean;
  onRetry: () => unknown;
}) {
  if (error) {
    return <RequestError error={error} onRetry={onRetry} />;
  }
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <BreakdownCard
        title="Opponent strategies"
        subtitle="most common across users"
        rows={data?.strategies ?? null}
        isLoading={isLoading}
        onRetry={onRetry}
      />
      <BreakdownCard
        title="Our builds"
        subtitle="most played across users"
        rows={data?.builds ?? null}
        isLoading={isLoading}
        onRetry={onRetry}
      />
      <BreakdownCard
        title="Maps"
        subtitle="most played across users"
        rows={data?.maps ?? null}
        isLoading={isLoading}
        onRetry={onRetry}
      />
    </div>
  );
}

function BreakdownCard({
  title,
  subtitle,
  rows,
  isLoading,
  onRetry,
}: {
  title: string;
  subtitle: string;
  rows: GlobalBreakdownRow[] | null;
  isLoading: boolean;
  onRetry: () => unknown;
}) {
  const max = rows && rows.length > 0 ? rows[0].count : 0;
  return (
    <Card padded={false}>
      <Card.Header>
        <h3 className="text-caption font-semibold uppercase tracking-wider text-text">
          {title}
        </h3>
        <span className="text-caption text-text-dim">{subtitle}</span>
      </Card.Header>
      {isLoading && !rows ? (
        <ul className="space-y-2 p-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <li key={i} className="h-6 animate-pulse rounded bg-bg-elevated" />
          ))}
        </ul>
      ) : !rows || rows.length === 0 ? (
        <EmptyStatePanel size="sm" title="No data yet" action={<Button variant="secondary" onClick={onRetry}>Refresh</Button>} />
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
              {/* Frequency bar, normalised against the top row. */}
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

function playerHref(pulseId: string): string {
  return `/admin/global/players/${encodeURIComponent(pulseId)}`;
}

function PlayersSection() {
  const router = useRouter();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [race, setRace] = useState("all");
  const [minGames, setMinGames] = useState("");
  const [sort, setSort] = useState<GlobalPlayerSort>("gameCount");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(0);
  const [knownRaces, setKnownRaces] = useState<string[]>([]);

  // Debounce search so each keystroke doesn't fire an aggregation.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const query = new URLSearchParams();
  query.set("limit", String(PAGE_SIZE));
  query.set("page", String(page));
  if (search) query.set("search", search);
  if (race !== "all") query.set("race", race);
  const minGamesNum = Number.parseInt(minGames, 10);
  if (Number.isFinite(minGamesNum) && minGamesNum > 0) {
    query.set("minGames", String(minGamesNum));
  }
  query.set("sort", sort);
  query.set("order", order);

  const { data, error, isLoading, isValidating, mutate } = useApi<GlobalPlayersResp>(
    `/v1/admin/global/players?${query.toString()}`,
  );

  useEffect(() => {
    if (data?.races) setKnownRaces(data.races);
  }, [data?.races]);

  if (error && error.status === 403) return <ForbiddenCard />;

  const total = data?.total ?? 0;
  const onPage = data?.items.length ?? 0;
  const rangeStart = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const rangeEnd = page * PAGE_SIZE + onPage;

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Players</h2>

      <Card padded>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Search">

            <Input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="name or pulse id (e.g. 1-S2-1-265393)…"
              className="w-full rounded-lg border border-border bg-bg-surface px-3 py-2 font-mono text-sm text-text placeholder:text-text-dim focus:border-accent focus:outline-none"
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
            />
          </Field>

          <Field label="Race">

            <Select
              selectSize="md"
              value={race}
              onChange={(e) => {
                setRace(e.target.value);
                setPage(0);
              }}
            >
              <option value="all">All races</option>
              {knownRaces.map((r) => (
                <option key={r} value={r}>
                  {raceLabel(r)}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Min games">

            <Input
              type="number"
              min={0}
              inputMode="numeric"
              value={minGames}
              onChange={(e) => {
                setMinGames(e.target.value);
                setPage(0);
              }}
              placeholder="0"
              className="h-10 w-full rounded-lg border border-border bg-bg-elevated px-3 text-body text-text placeholder:text-text-dim focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
          </Field>

          <Field label="Sort by">

            <Select
              selectSize="md"
              value={sort}
              onChange={(e) => {
                setSort(e.target.value as GlobalPlayerSort);
                setPage(0);
              }}
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Order">

            <button
              type="button"
              onClick={() => {
                setOrder((o) => (o === "desc" ? "asc" : "desc"));
                setPage(0);
              }}
              className="h-10 rounded-lg border border-border bg-bg-elevated px-3 text-body text-text transition-colors hover:bg-bg-surface"
            >
              {order === "desc" ? "Highest first ↓" : "Lowest first ↑"}
            </button>
          </Field>
        </div>
      </Card>

      {error ? (
        <RequestError error={error} onRetry={() => mutate()} />
      ) : isLoading && !data ? (
        <LoadingRows rows={10} />
      ) : !data || data.items.length === 0 ? (
        <Card padded>
          <EmptyStatePanel title={total === 0 && !search && race === "all" && !minGames ? "No players tracked yet" : "No players match these filters"} action={<Button variant="secondary" onClick={() => { if (search || race !== "all" || minGames) { setSearchInput(""); setSearch(""); setRace("all"); setMinGames(""); setPage(0); } else void mutate(); }}>{search || race !== "all" || minGames ? "Clear filters" : "Refresh"}</Button>} />
        </Card>
      ) : (
        <>
          <Card padded={false}>
            {/* Mobile: stacked list. Desktop: table. */}
            <div className="block md:hidden">
              <ul className="divide-y divide-border">
                {data.items.map((p) => (
                  <li key={p.pulseId}>
                    <Link
                      href={playerHref(p.pulseId)}
                      className="flex flex-col gap-2 px-4 py-3 transition-colors hover:bg-bg-elevated/40"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-body font-semibold text-text">
                          {p.displayNameSample || "—"}
                        </span>
                        <span className="shrink-0 text-caption text-text-dim">
                          {timeSince(p.lastSeen)}
                        </span>
                      </div>
                      <span className="truncate font-mono text-caption text-text-dim">
                        {p.pulseId}
                      </span>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-text-muted">
                        <span>{raceLabel(p.race)}</span>
                        <span>
                          <strong className="text-text">{p.gameCount}</strong> games
                        </span>
                        <span>
                          <span className="text-success">{p.wins}</span>
                          <span className="text-text-dim">–</span>
                          <span className="text-danger">{p.losses}</span>
                        </span>
                        <span>{pctLabel(p.winRate)} WR</span>
                        {p.mmr !== null ? <span>{p.mmr} MMR</span> : null}
                        <TrackedByBadge count={p.trackedByUsers} />
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
                    <th className="px-4 py-3 font-semibold">Player</th>
                    <th className="px-4 py-3 font-semibold">Race</th>
                    <th className="px-4 py-3 text-right font-semibold">Games</th>
                    <th className="px-4 py-3 text-right font-semibold">W–L</th>
                    <th className="px-4 py-3 text-right font-semibold">Win&nbsp;%</th>
                    <th className="px-4 py-3 text-right font-semibold">MMR</th>
                    <th className="px-4 py-3 text-right font-semibold">Tracked by</th>
                    <th className="px-4 py-3 text-right font-semibold">Last seen</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.items.map((p) => (
                    <tr
                      key={p.pulseId}
                      onClick={() => router.push(playerHref(p.pulseId))}
                      className="cursor-pointer hover:bg-bg-elevated/30"
                    >
                      <td className="px-4 py-2">
                        <Link
                          href={playerHref(p.pulseId)}
                          className="text-text hover:text-accent-cyan hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {p.displayNameSample || "—"}
                        </Link>
                        <div className="font-mono text-caption text-text-dim">
                          {p.pulseId}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-text-muted">
                        {raceLabel(p.race)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-text">
                        {p.gameCount}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        <span className="text-success">{p.wins}</span>
                        <span className="text-text-dim">–</span>
                        <span className="text-danger">{p.losses}</span>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-text-muted">
                        {pctLabel(p.winRate)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-text-muted">
                        {p.mmr !== null ? p.mmr : "—"}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-text">
                        {p.trackedByUsers}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-text-muted">
                        {timeSince(p.lastSeen)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <AdminPagination hasPrev={!(page === 0)} hasNext={!(!data.hasMore)} onPrev={() => setPage((p) => Math.max(0, p - 1))} onNext={() => setPage((p) => p + 1)} label={`${rangeStart}–${rangeEnd} of ${total.toLocaleString()}`} loading={isValidating} itemCount={data?.items.length ?? 0} />
        </>
      )}
    </div>
  );
}

/**
 * Pill showing how many distinct platform users track a player — the
 * signal that a record is a shared "known" opponent vs a one-off.
 */
function TrackedByBadge({ count }: { count: number }) {
  if (count <= 1) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-accent-cyan/40 bg-accent-cyan/10 px-2 py-0.5 text-micro font-medium text-accent-cyan">
      {count} users
    </span>
  );
}
