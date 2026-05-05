"use client";

import { useMemo, useState } from "react";
import { useApi } from "@/lib/clientApi";
import { useFilters } from "@/lib/filterContext";
import { fmtAgo, pct1, raceColour, wrColor } from "@/lib/format";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { OpponentDnaTimingsDrilldown } from "./OpponentDnaTimingsDrilldown";

type OpponentListItem = {
  pulseId: string;
  displayNameSample?: string;
  race?: string;
  gameCount?: number;
  wins?: number;
  losses?: number;
  openings?: Record<string, number>;
  lastSeen?: string | null;
  mmr?: number;
};

type OpponentListResp = {
  items?: OpponentListItem[];
  nextBefore?: string | null;
};

type DnaCell = {
  name: string;
  pulseId: string;
  race: string;
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  topStrategies: { name: string; share: number }[];
  /** 0..1 — how concentrated their openings are (1 = single opener). */
  predictability: number;
  /** Number of distinct openings observed. */
  uniqueOpenings: number;
  lastSeen?: string | null;
  mmr?: number;
};

type MatchupFilter = "Any" | "P" | "T" | "Z" | "R";
type SortKey = "games" | "winRate" | "predictability" | "recent" | "name";

const MIN_GAMES_FOR_CARD = 3;

const MATCHUP_OPTIONS: ReadonlyArray<{ key: MatchupFilter; label: string }> = [
  { key: "Any", label: "All" },
  { key: "P", label: "vs Protoss" },
  { key: "T", label: "vs Terran" },
  { key: "Z", label: "vs Zerg" },
  { key: "R", label: "vs Random" },
];

const SORT_OPTIONS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: "games", label: "Games" },
  { key: "winRate", label: "Win rate" },
  { key: "predictability", label: "Predictability" },
  { key: "recent", label: "Most recent" },
  { key: "name", label: "Name" },
];

/**
 * Opponent DNA grid — at-a-glance card per recurring opponent showing
 * record, win-rate ribbon, top openings, a "predictability" chip
 * (entropy-based), and a click-through to the per-opponent timing
 * fingerprint drilldown. Reads /v1/opponents and derives DNA cells
 * client-side; matchup filtering / sorting all happens locally so the
 * SPA stays responsive while the user explores.
 */
export function OpponentDnaGrid() {
  const { dbRev } = useFilters();
  const [open, setOpen] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [matchup, setMatchup] = useState<MatchupFilter>("Any");
  const [sortKey, setSortKey] = useState<SortKey>("games");
  const [minGames, setMinGames] = useState<number>(MIN_GAMES_FOR_CARD);

  const { data, isLoading, error } = useApi<OpponentListResp>(
    `/v1/opponents?limit=100#${dbRev}`,
  );

  const cells = useMemo<DnaCell[]>(() => {
    const items = data?.items;
    if (!Array.isArray(items)) return [];
    return items
      .map(itemToDnaCell)
      .filter((c): c is DnaCell => c !== null && c.total >= minGames);
  }, [data, minGames]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return cells
      .filter((c) => {
        if (matchup !== "Any") {
          const r = (c.race || "").charAt(0).toUpperCase();
          if (r !== matchup) return false;
        }
        if (q && !c.name.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => compareDna(a, b, sortKey));
  }, [cells, matchup, sortKey, search]);

  if (isLoading) return <Skeleton rows={6} />;
  if (error) {
    return (
      <Card>
        <EmptyState title="Couldn't load opponents" sub={error.message} />
      </Card>
    );
  }
  if (cells.length === 0) {
    return (
      <Card>
        <EmptyState
          title={`Need at least ${MIN_GAMES_FOR_CARD} games per opponent to build a DNA card`}
          sub="Once a recurring opponent appears, you'll get a full fingerprint here."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <DnaToolbar
        search={search}
        onSearch={setSearch}
        matchup={matchup}
        onMatchup={setMatchup}
        sortKey={sortKey}
        onSort={setSortKey}
        minGames={minGames}
        onMinGames={setMinGames}
        total={cells.length}
        shown={visible.length}
      />

      {visible.length === 0 ? (
        <Card>
          <EmptyState title="No opponents match these filters" />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((c) => (
            <DnaCard
              key={c.pulseId}
              cell={c}
              active={open === c.pulseId}
              onOpen={() => setOpen(c.pulseId)}
            />
          ))}
        </div>
      )}

      {open ? (
        <OpponentDnaTimingsDrilldown
          pulseId={open}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}

function DnaToolbar({
  search,
  onSearch,
  matchup,
  onMatchup,
  sortKey,
  onSort,
  minGames,
  onMinGames,
  total,
  shown,
}: {
  search: string;
  onSearch: (v: string) => void;
  matchup: MatchupFilter;
  onMatchup: (v: MatchupFilter) => void;
  sortKey: SortKey;
  onSort: (v: SortKey) => void;
  minGames: number;
  onMinGames: (v: number) => void;
  total: number;
  shown: number;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
      <input
        className="input w-full sm:w-56"
        placeholder="search opponent…"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
      />
      <div className="inline-flex w-full overflow-x-auto rounded border border-border sm:w-auto">
        {MATCHUP_OPTIONS.map((m) => (
          <button
            key={m.key}
            type="button"
            onClick={() => onMatchup(m.key)}
            className={`flex-1 whitespace-nowrap px-3 py-1.5 text-xs sm:flex-none sm:px-2 sm:py-1 ${
              matchup === m.key
                ? "bg-accent/20 text-accent"
                : "text-text-muted hover:bg-bg-elevated"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-text-muted">
          Sort
          <select
            className="input"
            value={sortKey}
            onChange={(e) => onSort(e.target.value as SortKey)}
          >
            {SORT_OPTIONS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-text-muted">
          Min games
          <input
            type="number"
            min={1}
            max={50}
            value={minGames}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) onMinGames(Math.max(1, Math.min(50, n)));
            }}
            className="input w-16"
          />
        </label>
        <span className="ml-auto text-xs text-text-dim sm:ml-0">
          {shown} of {total}
        </span>
      </div>
    </div>
  );
}

function DnaCard({
  cell,
  active,
  onOpen,
}: {
  cell: DnaCell;
  active: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`card cursor-pointer p-4 text-left transition hover:bg-bg-elevated ${
        active ? "ring-2 ring-accent" : ""
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="flex min-w-0 items-center gap-2 truncate text-sm font-semibold">
          <span
            aria-hidden
            className="h-2 w-2 flex-none rounded-full"
            style={{ background: raceColour(cell.race) }}
          />
          <span className="truncate">{cell.name}</span>
        </h3>
        <span
          className="font-mono tabular-nums text-xs"
          style={{ color: wrColor(cell.winRate, cell.total) }}
        >
          {pct1(cell.winRate)}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-text-dim">
        <span>
          {cell.wins}W &ndash; {cell.losses}L ({cell.total} games)
        </span>
        {cell.lastSeen ? <span>· {fmtAgo(cell.lastSeen)}</span> : null}
        {cell.mmr ? <span>· {Math.round(cell.mmr)} MMR</span> : null}
      </div>
      <PredictabilityChip
        predictability={cell.predictability}
        uniqueOpenings={cell.uniqueOpenings}
      />
      {cell.topStrategies.length > 0 ? (
        <div className="mt-3 space-y-1 text-[11px]">
          <div className="text-text-dim">Top openings</div>
          {cell.topStrategies.slice(0, 3).map((s) => (
            <div key={s.name} className="flex items-center gap-2">
              <div className="h-1 flex-1 overflow-hidden rounded bg-bg-elevated">
                <div
                  className="h-full bg-accent"
                  style={{ width: `${s.share * 100}%` }}
                />
              </div>
              <span
                className="w-24 truncate text-text-muted"
                title={s.name}
              >
                {s.name}
              </span>
              <span className="w-10 text-right tabular-nums text-text-dim">
                {pct1(s.share)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </button>
  );
}

function PredictabilityChip({
  predictability,
  uniqueOpenings,
}: {
  predictability: number;
  uniqueOpenings: number;
}) {
  if (uniqueOpenings === 0) return null;
  const { label, color, bg } = predictabilityBadge(predictability);
  return (
    <div className="mt-2 inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px]"
      style={{ background: bg, color }}
      title={`${uniqueOpenings} distinct openings observed`}
    >
      <span className="font-semibold uppercase tracking-wider">{label}</span>
      <span className="font-mono tabular-nums">{pct1(predictability)}</span>
    </div>
  );
}

function predictabilityBadge(p: number) {
  if (p >= 0.75)
    return { label: "1-trick", color: "#7ed957", bg: "rgba(126, 217, 87, 0.15)" };
  if (p >= 0.55)
    return { label: "Predictable", color: "#e6b450", bg: "rgba(230, 180, 80, 0.15)" };
  if (p >= 0.35)
    return { label: "Mixed", color: "#9aa3b2", bg: "rgba(154, 163, 178, 0.15)" };
  return { label: "Wild", color: "#ff8a3d", bg: "rgba(255, 138, 61, 0.15)" };
}

function compareDna(a: DnaCell, b: DnaCell, key: SortKey): number {
  switch (key) {
    case "games":
      return b.total - a.total || (b.lastSeen || "").localeCompare(a.lastSeen || "");
    case "winRate":
      return b.winRate - a.winRate;
    case "predictability":
      return b.predictability - a.predictability;
    case "recent":
      return (b.lastSeen || "").localeCompare(a.lastSeen || "");
    case "name":
      return a.name.localeCompare(b.name);
    default:
      return 0;
  }
}

function itemToDnaCell(item: OpponentListItem | null | undefined): DnaCell | null {
  if (!item || !item.pulseId) return null;
  const wins = Number.isFinite(item.wins) ? Number(item.wins) : 0;
  const losses = Number.isFinite(item.losses) ? Number(item.losses) : 0;
  const total =
    Number.isFinite(item.gameCount) && Number(item.gameCount) > 0
      ? Number(item.gameCount)
      : wins + losses;
  const decided = wins + losses;
  const winRate = decided ? wins / decided : 0;
  const top = openingsToShare(item.openings);
  return {
    pulseId: String(item.pulseId),
    name: item.displayNameSample || String(item.pulseId),
    race: item.race || "",
    total,
    wins,
    losses,
    winRate,
    topStrategies: top,
    predictability: predictabilityFromShares(top),
    uniqueOpenings: top.length,
    lastSeen: item.lastSeen || null,
    mmr: typeof item.mmr === "number" ? item.mmr : undefined,
  };
}

function openingsToShare(
  openings: Record<string, number> | undefined,
): { name: string; share: number }[] {
  if (!openings || typeof openings !== "object") return [];
  const entries = Object.entries(openings).filter(
    ([, v]) => Number.isFinite(v) && Number(v) > 0,
  );
  if (entries.length === 0) return [];
  const total = entries.reduce((acc, [, v]) => acc + Number(v), 0);
  if (!total) return [];
  return entries
    .map(([name, count]) => ({ name, share: Number(count) / total }))
    .sort((a, b) => b.share - a.share);
}

/**
 * Predictability = 1 - normalised Shannon entropy of the opening
 * distribution. 1 = single opener every game; 0 = uniform across all
 * unique openings observed. With one unique opening the score is 1.
 */
function predictabilityFromShares(
  shares: { share: number }[],
): number {
  const k = shares.length;
  if (k <= 1) return k === 1 ? 1 : 0;
  let h = 0;
  for (const s of shares) {
    const p = s.share;
    if (p > 0) h -= p * Math.log2(p);
  }
  const norm = h / Math.log2(k);
  return Math.max(0, Math.min(1, 1 - norm));
}
