"use client";

import { useEffect, useState } from "react";

import { useApi } from "@/lib/clientApi";
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
      <header className="space-y-2">
        <h1 className="text-3xl font-bold">Global</h1>
        <p className="text-text-muted">
          Everything the platform tracks, aggregated across every user —
          merged player records plus the most common strategies, builds,
          and maps. The same real opponent faced by several users is
          collapsed into a single record.
        </p>
      </header>

      <SummarySection
        data={summary.data ?? null}
        error={summary.error?.message ?? null}
        isLoading={summary.isLoading}
      />

      <BreakdownsSection
        data={breakdowns.data ?? null}
        error={breakdowns.error?.message ?? null}
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
}: {
  data: GlobalSummaryResp | null;
  error: string | null;
  isLoading: boolean;
}) {
  if (error) {
    return (
      <Card padded>
        <p className="text-danger">Failed to load summary: {error}</p>
      </Card>
    );
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
}: {
  data: GlobalBreakdownsResp | null;
  error: string | null;
  isLoading: boolean;
}) {
  if (error) {
    return (
      <Card padded>
        <p className="text-danger">Failed to load trends: {error}</p>
      </Card>
    );
  }
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <BreakdownCard
        title="Opponent strategies"
        subtitle="most common across users"
        rows={data?.strategies ?? null}
        isLoading={isLoading}
      />
      <BreakdownCard
        title="Our builds"
        subtitle="most played across users"
        rows={data?.builds ?? null}
        isLoading={isLoading}
      />
      <BreakdownCard
        title="Maps"
        subtitle="most played across users"
        rows={data?.maps ?? null}
        isLoading={isLoading}
      />
    </div>
  );
}

function BreakdownCard({
  title,
  subtitle,
  rows,
  isLoading,
}: {
  title: string;
  subtitle: string;
  rows: GlobalBreakdownRow[] | null;
  isLoading: boolean;
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

function PlayersSection() {
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

  const { data, error, isLoading } = useApi<GlobalPlayersResp>(
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
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className="text-caption font-semibold uppercase tracking-wider text-text-dim">
              Search
            </span>
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="name or pulse id (e.g. 1-S2-1-265393)…"
              className="w-full rounded-lg border border-border bg-bg-surface px-3 py-2 font-mono text-sm text-text placeholder:text-text-dim focus:border-accent focus:outline-none"
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-caption font-semibold uppercase tracking-wider text-text-dim">
              Race
            </span>
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
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-caption font-semibold uppercase tracking-wider text-text-dim">
              Min games
            </span>
            <input
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
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-caption font-semibold uppercase tracking-wider text-text-dim">
              Sort by
            </span>
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
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-caption font-semibold uppercase tracking-wider text-text-dim">
              Order
            </span>
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
          </label>
        </div>
      </Card>

      {isLoading && !data ? (
        <LoadingRows rows={10} />
      ) : error ? (
        <Card padded>
          <p className="text-danger">Failed to load players: {error.message}</p>
        </Card>
      ) : !data || data.items.length === 0 ? (
        <Card padded>
          <p className="text-text-muted">
            {total === 0 && !search && race === "all" && !minGames
              ? "No players tracked yet."
              : "No players match these filters."}
          </p>
        </Card>
      ) : (
        <>
          <Card padded={false}>
            {/* Mobile: stacked list. Desktop: table. */}
            <div className="block md:hidden">
              <ul className="divide-y divide-border">
                {data.items.map((p) => (
                  <li key={p.pulseId} className="flex flex-col gap-2 px-4 py-3">
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
                    <tr key={p.pulseId} className="hover:bg-bg-elevated/30">
                      <td className="px-4 py-2">
                        <div className="text-text">
                          {p.displayNameSample || "—"}
                        </div>
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

          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              className="btn btn-secondary text-sm disabled:cursor-not-allowed disabled:opacity-50"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              ← Previous
            </button>
            <span className="text-caption text-text-dim">
              {rangeStart}–{rangeEnd} of {compactNumber(total)}
            </span>
            <button
              type="button"
              className="btn btn-secondary text-sm disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!data.hasMore}
              onClick={() => setPage((p) => p + 1)}
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
 * Pill showing how many distinct platform users track a player — the
 * signal that a record is a shared "known" opponent vs a one-off.
 */
function TrackedByBadge({ count }: { count: number }) {
  if (count <= 1) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-accent-cyan/40 bg-accent-cyan/10 px-2 py-0.5 text-[11px] font-medium text-accent-cyan">
      {count} users
    </span>
  );
}
