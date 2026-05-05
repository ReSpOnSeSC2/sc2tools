"use client";

import { useMemo, useState } from "react";
import { useApi } from "@/lib/clientApi";
import { useFilters } from "@/lib/filterContext";
import { pct1, wrColor } from "@/lib/format";
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
};

type OpponentListResp = {
  items?: OpponentListItem[];
  nextBefore?: string | null;
};

type DnaCell = {
  name: string;
  pulseId: string;
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  topStrategies: { name: string; share: number }[];
};

const MIN_GAMES_FOR_CARD = 3;

/**
 * Opponent DNA grid — at-a-glance card per recurring opponent showing
 * record, win-rate ribbon, top openings (from the stored counts), and a
 * click-through to a per-opponent timing fingerprint drilldown.
 *
 * Reads the same `/v1/opponents` list endpoint used by the Opponents
 * tab, then derives DNA cells client-side. The detail endpoint
 * (`/v1/opponents/:pulseId`) provides the matchup timings rendered by
 * `OpponentDnaTimingsDrilldown`.
 */
export function OpponentDnaGrid() {
  const { dbRev } = useFilters();
  const [open, setOpen] = useState<string | null>(null);
  const { data, isLoading, error } = useApi<OpponentListResp>(
    `/v1/opponents?limit=100#${dbRev}`,
  );

  const cells = useMemo<DnaCell[]>(() => {
    const items = data?.items;
    if (!Array.isArray(items)) return [];
    return items
      .map(itemToDnaCell)
      .filter((c): c is DnaCell => c !== null && c.total >= MIN_GAMES_FOR_CARD);
  }, [data]);

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
        <EmptyState title={`Need at least ${MIN_GAMES_FOR_CARD} games per opponent to build a DNA card`} />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cells.map((c) => (
          <button
            type="button"
            key={c.pulseId}
            onClick={() => setOpen(c.pulseId)}
            className={`card cursor-pointer p-4 text-left transition hover:bg-bg-elevated ${
              open === c.pulseId ? "ring-2 ring-accent" : ""
            }`}
          >
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="truncate text-sm font-semibold">{c.name}</h3>
              <span
                className="font-mono tabular-nums text-xs"
                style={{ color: wrColor(c.winRate, c.total) }}
              >
                {pct1(c.winRate)}
              </span>
            </div>
            <div className="mt-1 text-[11px] text-text-dim">
              {c.wins}W &ndash; {c.losses}L ({c.total} games)
            </div>
            {c.topStrategies.length > 0 ? (
              <div className="mt-3 space-y-1 text-[11px]">
                <div className="text-text-dim">Top openings</div>
                {c.topStrategies.slice(0, 3).map((s) => (
                  <div key={s.name} className="flex items-center gap-2">
                    <div className="h-1 flex-1 overflow-hidden rounded bg-bg-elevated">
                      <div
                        className="h-full bg-accent"
                        style={{ width: `${s.share * 100}%` }}
                      />
                    </div>
                    <span className="w-24 truncate text-text-muted" title={s.name}>
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
        ))}
      </div>
      {open ? (
        <OpponentDnaTimingsDrilldown
          pulseId={open}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
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
  return {
    pulseId: String(item.pulseId),
    name: item.displayNameSample || String(item.pulseId),
    total,
    wins,
    losses,
    winRate,
    topStrategies: openingsToShare(item.openings),
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
