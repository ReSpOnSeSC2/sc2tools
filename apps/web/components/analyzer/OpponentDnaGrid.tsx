"use client";

import { useMemo, useState } from "react";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { pct1, wrColor } from "@/lib/format";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { OpponentDnaTimingsDrilldown } from "./OpponentDnaTimingsDrilldown";

type DnaCell = {
  name: string;
  pulseId: string;
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  topStrategies?: { name: string; share: number }[];
  predicted?: { name: string; weight: number }[];
};

/**
 * Opponent DNA grid — at-a-glance card per recurring opponent showing
 * record, win-rate ribbon, top strategies, and predicted-next.
 * Click a card to open the timings drilldown.
 */
export function OpponentDnaGrid() {
  const { filters, dbRev } = useFilters();
  const [open, setOpen] = useState<string | null>(null);
  const { data, isLoading } = useApi<DnaCell[]>(
    `/v1/opponents${filtersToQuery({ ...filters, dna: 1 })}#${dbRev}`,
  );

  const cells = useMemo(
    () => (data || []).filter((c) => (c.total || 0) >= 3),
    [data],
  );

  if (isLoading) return <Skeleton rows={6} />;
  if (cells.length === 0) {
    return (
      <Card>
        <EmptyState title="Need at least 3 games per opponent to build a DNA card" />
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
            <div className="flex items-baseline justify-between">
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
            {c.topStrategies && c.topStrategies.length > 0 && (
              <div className="mt-3 space-y-1 text-[11px]">
                <div className="text-text-dim">Top builds</div>
                {c.topStrategies.slice(0, 3).map((s) => (
                  <div key={s.name} className="flex items-center gap-2">
                    <div className="h-1 flex-1 overflow-hidden rounded bg-bg-elevated">
                      <div
                        className="h-full bg-accent"
                        style={{ width: `${s.share * 100}%` }}
                      />
                    </div>
                    <span className="w-24 truncate text-text-muted">{s.name}</span>
                    <span className="w-10 text-right tabular-nums text-text-dim">
                      {pct1(s.share)}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {c.predicted && c.predicted.length > 0 && (
              <div className="mt-3 text-[11px]">
                <div className="text-text-dim">Likely next</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {c.predicted.slice(0, 3).map((p) => (
                    <span
                      key={p.name}
                      className="rounded bg-accent/15 px-1.5 py-0.5 text-accent"
                      title={`${pct1(p.weight)} confidence`}
                    >
                      {p.name}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </button>
        ))}
      </div>
      {open && (
        <OpponentDnaTimingsDrilldown
          pulseId={open}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
