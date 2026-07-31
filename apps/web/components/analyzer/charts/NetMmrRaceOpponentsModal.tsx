"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Search,
  Users,
} from "lucide-react";
import { useApi } from "@/lib/clientApi";
import { pct1 } from "@/lib/format";
import { useFilters } from "@/lib/filterContext";
import {
  netMmrOpponentsPath,
  type NetMmrOpponentRow,
  type NetMmrOpponentsResponse,
  type NetMmrOpponentSort,
  type NetMmrRace,
  type NetMmrSortOrder,
} from "@/lib/netMmrOpponents";
import { EmptyState, Skeleton } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";

const PAGE_SIZE = 25;

const RACE_NAMES: Record<NetMmrRace, string> = {
  P: "Protoss",
  T: "Terran",
  Z: "Zerg",
  R: "Random",
  U: "Unknown race",
};

type Ranking =
  | "net-best"
  | "net-worst"
  | "gained"
  | "lost"
  | "pairs"
  | "win-rate"
  | "recent"
  | "name";

const RANKING_OPTIONS: ReadonlyArray<{
  value: Ranking;
  label: string;
  sort: NetMmrOpponentSort;
  order: NetMmrSortOrder;
}> = [
  { value: "net-best", label: "Best net MMR", sort: "net_mmr", order: "desc" },
  { value: "net-worst", label: "Worst net MMR", sort: "net_mmr", order: "asc" },
  { value: "gained", label: "Most MMR taken", sort: "mmr_won", order: "desc" },
  { value: "lost", label: "Most MMR lost", sort: "mmr_lost", order: "desc" },
  { value: "pairs", label: "Most pairs", sort: "pairs", order: "desc" },
  { value: "win-rate", label: "Highest win rate", sort: "win_rate", order: "desc" },
  { value: "recent", label: "Most recent", sort: "last_played", order: "desc" },
  { value: "name", label: "Opponent A–Z", sort: "name", order: "asc" },
];

const MIN_PAIR_OPTIONS = [1, 2, 3, 5, 10, 20] as const;

export function NetMmrRaceOpponentsModal({
  race,
  onClose,
}: {
  race: NetMmrRace | null;
  onClose: () => void;
}) {
  const { filters, dbRev } = useFilters();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search.trim(), 250);
  const [minimumPairs, setMinimumPairs] = useState(1);
  const [ranking, setRanking] = useState<Ranking>("net-best");
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    setSearch("");
    setMinimumPairs(1);
    setRanking("net-best");
    setOffset(0);
  }, [race]);

  const rankingConfig =
    RANKING_OPTIONS.find((option) => option.value === ranking)
    ?? RANKING_OPTIONS[0];
  const path = useMemo(() => {
    if (!race) return null;
    return netMmrOpponentsPath(
      filters,
      {
        opp_race: race,
        search: debouncedSearch || undefined,
        min_pairs: minimumPairs,
        sort: rankingConfig.sort,
        order: rankingConfig.order,
        limit: PAGE_SIZE,
        offset,
      },
      dbRev,
    );
  }, [
    dbRev,
    debouncedSearch,
    filters,
    minimumPairs,
    offset,
    race,
    rankingConfig.order,
    rankingConfig.sort,
  ]);

  const { data, isLoading, error } = useApi<NetMmrOpponentsResponse>(path);

  if (!race) return null;

  const items = data?.items ?? [];
  const totalOpponents = data?.totalOpponents ?? 0;
  const firstShown = totalOpponents > 0 ? offset + 1 : 0;
  const lastShown = Math.min(offset + items.length, totalOpponents);
  const hasPrevious = offset > 0;
  const hasNext = offset + PAGE_SIZE < totalOpponents;
  const raceName = RACE_NAMES[race];

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={`MMR by ${raceName} opponent`}
      description="Accepted replay-to-replay MMR pairs under the current Analyzer filters. Positive values are MMR you took; negative values are MMR you lost."
    >
      {data?.summary ? <ImpactSummary summary={data.summary} /> : null}

      <div className="mt-4 grid gap-2 rounded-xl border border-border bg-bg-elevated/35 p-3 sm:grid-cols-[minmax(12rem,1fr)_auto_auto]">
        <label className="relative block">
          <span className="sr-only">Search {raceName} opponents</span>
          <Search
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-dim"
          />
          <input
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setOffset(0);
            }}
            placeholder="Search opponent or ID…"
            aria-label={`Search ${raceName} opponents`}
            className="h-10 w-full rounded-lg border border-border bg-bg-surface pl-9 pr-3 text-sm text-text placeholder:text-text-dim focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </label>

        <label className="flex min-w-0 items-center gap-2 text-micro text-text-dim sm:block">
          <span className="whitespace-nowrap sm:sr-only">Minimum pairs</span>
          <select
            value={minimumPairs}
            onChange={(event) => {
              setMinimumPairs(Number(event.target.value));
              setOffset(0);
            }}
            aria-label="Minimum MMR pairs"
            className="h-10 min-w-0 flex-1 rounded-lg border border-border bg-bg-surface px-3 text-sm text-text focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent sm:w-36"
          >
            {MIN_PAIR_OPTIONS.map((count) => (
              <option key={count} value={count}>
                {count === 1 ? "Any sample" : `${count}+ pairs`}
              </option>
            ))}
          </select>
        </label>

        <label className="flex min-w-0 items-center gap-2 text-micro text-text-dim sm:block">
          <span className="whitespace-nowrap sm:sr-only">Sort opponents</span>
          <select
            value={ranking}
            onChange={(event) => {
              setRanking(event.target.value as Ranking);
              setOffset(0);
            }}
            aria-label="Sort opponents"
            className="h-10 min-w-0 flex-1 rounded-lg border border-border bg-bg-surface px-3 text-sm text-text focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent sm:w-44"
          >
            {RANKING_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-3 flex min-h-5 items-center justify-between gap-3 text-micro text-text-dim" aria-live="polite">
        <span>
          {isLoading && !data
            ? "Loading opponents…"
            : `${totalOpponents.toLocaleString()} opponent${totalOpponents === 1 ? "" : "s"}`}
        </span>
        {totalOpponents > PAGE_SIZE ? (
          <span className="tabular-nums">
            {firstShown.toLocaleString()}–{lastShown.toLocaleString()} shown
          </span>
        ) : null}
      </div>

      {error ? (
        <div role="alert" className="mt-3 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          Could not load opponent MMR impact — {error.message}
        </div>
      ) : isLoading && !data ? (
        <div className="mt-3"><Skeleton rows={7} /></div>
      ) : items.length === 0 ? (
        <EmptyState
          title="No opponents match these filters"
          sub="Try a broader search or lower the minimum pair count."
        />
      ) : (
        <OpponentImpactTable items={items} />
      )}

      {totalOpponents > PAGE_SIZE ? (
        <nav className="mt-4 flex items-center justify-between border-t border-border pt-3" aria-label="Opponent result pages">
          <button
            type="button"
            disabled={!hasPrevious}
            onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}
            className="inline-flex h-9 items-center gap-1 rounded-md border border-border px-3 text-caption font-medium text-text transition-colors hover:border-accent/60 hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronLeft aria-hidden className="h-4 w-4" /> Previous
          </button>
          <span className="text-micro tabular-nums text-text-dim">
            Page {Math.floor(offset / PAGE_SIZE) + 1} of {Math.ceil(totalOpponents / PAGE_SIZE)}
          </span>
          <button
            type="button"
            disabled={!hasNext}
            onClick={() => setOffset((value) => value + PAGE_SIZE)}
            className="inline-flex h-9 items-center gap-1 rounded-md border border-border px-3 text-caption font-medium text-text transition-colors hover:border-accent/60 hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next <ChevronRight aria-hidden className="h-4 w-4" />
          </button>
        </nav>
      ) : null}
    </Modal>
  );
}

function ImpactSummary({
  summary,
}: {
  summary: NonNullable<NetMmrOpponentsResponse["summary"]>;
}) {
  return (
    <section aria-label="Matchup opponent highlights" className="grid gap-2 sm:grid-cols-3">
      <HighlightCard
        icon={<ArrowUpRight aria-hidden className="h-4 w-4" />}
        eyebrow="You took the most from"
        opponent={summary.mostMmrGainedFrom}
        value={summary.mostMmrGainedFrom?.mmrWon ?? null}
        tone="gain"
      />
      <HighlightCard
        icon={<ArrowDownRight aria-hidden className="h-4 w-4" />}
        eyebrow="Took the most from you"
        opponent={summary.mostMmrLostTo}
        value={summary.mostMmrLostTo?.mmrLost ?? null}
        tone="loss"
      />
      <div className="rounded-xl border border-border bg-bg-elevated/45 p-3">
        <div className="flex items-center gap-1.5 text-micro font-semibold uppercase tracking-wider text-text-dim">
          <Users aria-hidden className="h-4 w-4" /> Filtered matchup
        </div>
        <div className="mt-2 flex items-end justify-between gap-3">
          <div>
            <p className="text-lg font-semibold tabular-nums text-text">
              {summary.opponents.toLocaleString()}
            </p>
            <p className="text-micro text-text-dim">
              opponent{summary.opponents === 1 ? "" : "s"} · {summary.pairs.toLocaleString()} pairs
            </p>
          </div>
          <SignedMmr value={summary.netMmr} className="text-base font-semibold" />
        </div>
      </div>
    </section>
  );
}

function HighlightCard({
  icon,
  eyebrow,
  opponent,
  value,
  tone,
}: {
  icon: React.ReactNode;
  eyebrow: string;
  opponent: NetMmrOpponentRow | null;
  value: number | null;
  tone: "gain" | "loss";
}) {
  const isGain = tone === "gain";
  return (
    <div className="rounded-xl border border-border bg-bg-elevated/45 p-3">
      <div className={`flex items-center gap-1.5 text-micro font-semibold uppercase tracking-wider ${isGain ? "text-success" : "text-danger"}`}>
        {icon} {eyebrow}
      </div>
      {opponent && value != null ? (
        <div className="mt-2 flex items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-text" title={opponentName(opponent)}>
              {opponentName(opponent)}
            </p>
            <p className="text-micro tabular-nums text-text-dim">
              {opponent.pairs.toLocaleString()} pair{opponent.pairs === 1 ? "" : "s"}
            </p>
          </div>
          <span className={`whitespace-nowrap text-base font-semibold tabular-nums ${isGain ? "text-success" : "text-danger"}`}>
            {isGain ? "+" : "−"}{Math.abs(value).toLocaleString()}
          </span>
        </div>
      ) : (
        <p className="mt-2 text-caption text-text-dim">No accepted pairs</p>
      )}
    </div>
  );
}

function OpponentImpactTable({ items }: { items: NetMmrOpponentRow[] }) {
  return (
    <div className="mt-2 overflow-x-auto rounded-xl border border-border bg-bg-surface">
      <table
        aria-label="MMR impact by opponent"
        className="w-full min-w-[620px] text-sm"
      >
        <thead className="bg-bg-elevated/80 text-micro uppercase tracking-wider text-text-dim">
          <tr>
            <th scope="col" className="px-2 py-2 text-left font-semibold">Opponent</th>
            <th scope="col" className="px-2 py-2 text-right font-semibold">Record</th>
            <th scope="col" className="px-2 py-2 text-right font-semibold">Pairs</th>
            <th scope="col" className="px-2 py-2 text-right font-semibold" title="Gross MMR gained from wins">Taken</th>
            <th scope="col" className="px-2 py-2 text-right font-semibold" title="Gross MMR lost in defeats">Lost</th>
            <th scope="col" className="px-2 py-2 text-right font-semibold">Net</th>
          </tr>
        </thead>
        <tbody>
          {items.map((opponent, index) => (
            <tr
              key={opponent.pulseId || opponent.toonHandle || `${opponentName(opponent)}-${index}`}
              className="border-t border-border transition-colors hover:bg-accent/5"
            >
              <th scope="row" className="max-w-[12rem] px-2 py-2 text-left font-medium text-text">
                <span className="block truncate" title={opponentName(opponent)}>{opponentName(opponent)}</span>
                {opponent.pulseCharacterId || opponent.toonHandle ? (
                  <span className="block truncate text-micro font-normal text-text-dim">
                    {opponent.pulseCharacterId || opponent.toonHandle}
                  </span>
                ) : null}
              </th>
              <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-text-muted">
                <span className="text-success">{opponent.wins}W</span>
                <span className="text-text-dim">–</span>
                <span className="text-danger">{opponent.losses}L</span>
                <span className="ml-1 text-micro text-text-dim">({pct1(opponent.winRate)})</span>
              </td>
              <td className="px-2 py-2 text-right tabular-nums text-text-muted">{opponent.pairs.toLocaleString()}</td>
              <td className="px-2 py-2 text-right font-medium tabular-nums text-success">+{opponent.mmrWon.toLocaleString()}</td>
              <td className="px-2 py-2 text-right font-medium tabular-nums text-danger">−{opponent.mmrLost.toLocaleString()}</td>
              <td className="px-2 py-2 text-right"><SignedMmr value={opponent.netMmr} className="font-semibold" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SignedMmr({ value, className = "" }: { value: number; className?: string }) {
  const tone = value > 0 ? "text-success" : value < 0 ? "text-danger" : "text-text-muted";
  return (
    <span className={`whitespace-nowrap tabular-nums ${tone} ${className}`}>
      {value > 0 ? "+" : value < 0 ? "−" : ""}{Math.abs(value).toLocaleString()}
    </span>
  );
}

function opponentName(opponent: NetMmrOpponentRow): string {
  return (opponent.name || opponent.displayName || "").trim() || "Unknown opponent";
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timeout);
  }, [delayMs, value]);
  return debounced;
}
