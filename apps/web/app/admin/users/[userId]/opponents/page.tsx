"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { useApi } from "@/lib/clientApi";
import { Card } from "@/components/ui/Card";
import { Select } from "@/components/ui/Select";
import { compactNumber, timeSince } from "../../../components/format";
import { ForbiddenCard, LoadingRows } from "../../../components/AdminFragments";
import type {
  OpponentSort,
  OpponentsListResp,
} from "../../../components/adminTypes";

const PAGE_SIZE = 50;

const SORT_OPTIONS: ReadonlyArray<{ value: OpponentSort; label: string }> = [
  { value: "gameCount", label: "Games" },
  { value: "winRate", label: "Win rate" },
  { value: "wins", label: "Wins" },
  { value: "losses", label: "Losses" },
  { value: "lastSeen", label: "Last seen" },
  { value: "firstSeen", label: "First seen" },
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
 * /admin/users/[userId]/opponents — the full opponent history for one
 * user. The per-user detail page only shows the top 5; this is the
 * "see everything" browser with search, race + min-games filters, and
 * sortable columns. Pagination is offset-based (the sort column is
 * caller-selectable, so a single-key cursor wouldn't hold).
 */
export default function AdminUserOpponentsPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const { userId } = use(params);
  const router = useRouter();

  function opponentHref(pulseId: string): string {
    return `/admin/users/${encodeURIComponent(userId)}/opponents/${encodeURIComponent(pulseId)}`;
  }

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [race, setRace] = useState("all");
  const [minGames, setMinGames] = useState("");
  const [sort, setSort] = useState<OpponentSort>("gameCount");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(0);
  // Retain the last-known race set so the dropdown doesn't flicker
  // empty while SWR revalidates on a filter change.
  const [knownRaces, setKnownRaces] = useState<string[]>([]);

  // Debounce the search box so each keystroke doesn't fire an
  // aggregation; resets to page 1 once the term settles.
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
  const path = `/v1/admin/users/${encodeURIComponent(
    userId,
  )}/opponents?${query.toString()}`;

  const { data, error, isLoading } = useApi<OpponentsListResp>(path);

  useEffect(() => {
    if (data?.races) setKnownRaces(data.races);
  }, [data?.races]);

  if (error && error.status === 403) return <ForbiddenCard />;

  const total = data?.total ?? 0;
  const onPage = data?.items.length ?? 0;
  const rangeStart = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const rangeEnd = page * PAGE_SIZE + onPage;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <Link
          href={`/admin/users/${encodeURIComponent(userId)}`}
          className="text-caption text-text-dim hover:text-text"
        >
          ← User detail
        </Link>
        <h1 className="text-3xl font-bold">Opponents</h1>
        <p className="break-all font-mono text-caption text-text-dim">
          {userId}
        </p>
        <p className="text-text-muted">
          Full opponent history. Search by name or pulse id, filter by
          race / minimum games, and sort by any column.
        </p>
      </header>

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
                setSort(e.target.value as OpponentSort);
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

      {isLoading ? (
        <LoadingRows rows={10} />
      ) : error ? (
        <Card padded>
          <p className="text-danger">
            Failed to load opponents: {error.message}
          </p>
        </Card>
      ) : !data || data.items.length === 0 ? (
        <Card padded>
          <p className="text-text-muted">
            {total === 0 && !search && race === "all" && !minGames
              ? "No opponents recorded yet."
              : "No opponents match these filters."}
          </p>
        </Card>
      ) : (
        <>
          <Card padded={false}>
            {/* Mobile: stacked list. Desktop: table. */}
            <div className="block md:hidden">
              <ul className="divide-y divide-border">
                {data.items.map((o) => (
                  <li key={o.pulseId}>
                    <Link
                      href={opponentHref(o.pulseId)}
                      className="flex flex-col gap-2 px-4 py-3 hover:bg-bg-elevated/40"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-body font-semibold text-text">
                          {o.displayNameSample || "—"}
                        </span>
                        <span className="shrink-0 text-caption text-text-dim">
                          {timeSince(o.lastSeen)}
                        </span>
                      </div>
                      <span className="truncate font-mono text-caption text-text-dim">
                        {o.pulseId}
                      </span>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-text-muted">
                        <span>{raceLabel(o.race)}</span>
                        <span>
                          <strong className="text-text">{o.gameCount}</strong>{" "}
                          games
                        </span>
                        <span>
                          <span className="text-success">{o.wins}</span>
                          <span className="text-text-dim">–</span>
                          <span className="text-danger">{o.losses}</span>
                        </span>
                        <span>{pctLabel(o.winRate)} WR</span>
                        {o.mmr !== null ? <span>{o.mmr} MMR</span> : null}
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
                    <th className="px-4 py-3 font-semibold">Opponent</th>
                    <th className="px-4 py-3 font-semibold">Race</th>
                    <th className="px-4 py-3 text-right font-semibold">
                      Games
                    </th>
                    <th className="px-4 py-3 text-right font-semibold">W–L</th>
                    <th className="px-4 py-3 text-right font-semibold">
                      Win&nbsp;%
                    </th>
                    <th className="px-4 py-3 text-right font-semibold">MMR</th>
                    <th className="px-4 py-3 text-right font-semibold">
                      Last seen
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.items.map((o) => (
                    <tr
                      key={o.pulseId}
                      role="link"
                      tabIndex={0}
                      onClick={() => router.push(opponentHref(o.pulseId))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          router.push(opponentHref(o.pulseId));
                        }
                      }}
                      className="cursor-pointer transition-colors hover:bg-bg-elevated/30 focus-visible:bg-bg-elevated/40 focus-visible:outline-none"
                    >
                      <td className="px-4 py-2">
                        <div className="text-text">
                          {o.displayNameSample || "—"}
                        </div>
                        <div className="font-mono text-caption text-text-dim">
                          {o.pulseId}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-text-muted">
                        {raceLabel(o.race)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-text">
                        {o.gameCount}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        <span className="text-success">{o.wins}</span>
                        <span className="text-text-dim">–</span>
                        <span className="text-danger">{o.losses}</span>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-text-muted">
                        {pctLabel(o.winRate)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-text-muted">
                        {o.mmr !== null ? o.mmr : "—"}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-text-muted">
                        {timeSince(o.lastSeen)}
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
              className="inline-flex items-center gap-2 rounded-lg px-4 py-[0.55rem] font-semibold transition-colors border border-border bg-bg-elevated text-text hover:bg-bg-subtle text-sm disabled:cursor-not-allowed disabled:opacity-50"
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
