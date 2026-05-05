"use client";

import { useMemo } from "react";
import { Card, EmptyState } from "@/components/ui/Card";
import { pct1, wrColor } from "@/lib/format";
import type { BuildDetailRow } from "./types";

/** "Vs opponent strategy" / "Vs map" panels share this layout. */
export function BreakdownCard({
  title,
  rows,
  emptySub,
}: {
  title: string;
  rows: BuildDetailRow[];
  emptySub: string;
}) {
  const enriched = useMemo(() => withWinRates(rows).slice(0, 12), [rows]);
  return (
    <Card title={title}>
      {enriched.length === 0 ? (
        <EmptyState sub={emptySub} />
      ) : (
        <ul className="space-y-2">
          {enriched.map((r) => (
            <li key={r.name} className="space-y-1">
              <div className="flex items-baseline justify-between gap-3 text-caption">
                <span className="truncate text-text">{r.name || "Unknown"}</span>
                <span className="tabular-nums text-text-muted">
                  {r.wins}–{r.losses}
                  <span className="px-1 text-text-dim">·</span>
                  <span style={{ color: wrColor(r.winRate ?? 0, r.total) }}>
                    {pct1(r.winRate ?? 0)}
                  </span>
                </span>
              </div>
              <WrBarLite wins={r.wins} losses={r.losses} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** "Top matchups on this build" — grid layout to surface more rows. */
export function TopOpponentsCard({
  rows,
  accentClass,
}: {
  rows: BuildDetailRow[];
  accentClass: string;
}) {
  const enriched = useMemo(() => withWinRates(rows).slice(0, 9), [rows]);
  return (
    <Card title="Top matchups on this build">
      {enriched.length === 0 ? (
        <EmptyState sub="Win-rate by opposing race appears once games tagged with this build accumulate." />
      ) : (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {enriched.map((o) => (
            <li
              key={o.name}
              className="flex items-center justify-between gap-3 rounded-lg border border-border bg-bg-elevated px-3 py-2"
            >
              <span
                className={[
                  "truncate text-caption font-medium",
                  accentClass,
                ].join(" ")}
              >
                {o.name || "Unknown"}
              </span>
              <span className="whitespace-nowrap font-mono text-caption text-text-muted">
                {o.wins}–{o.losses}
                <span className="px-1 text-text-dim">·</span>
                <span style={{ color: wrColor(o.winRate ?? 0, o.total) }}>
                  {pct1(o.winRate ?? 0)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function withWinRates(rows: BuildDetailRow[]): BuildDetailRow[] {
  return rows.map((r) => ({
    ...r,
    winRate: r.total ? r.wins / r.total : 0,
  }));
}

function WrBarLite({ wins, losses }: { wins: number; losses: number }) {
  const total = wins + losses;
  const wp = total > 0 ? (wins / total) * 100 : 0;
  return (
    <div className="h-1 w-full overflow-hidden rounded bg-bg-elevated">
      <div className="h-full bg-success" style={{ width: `${wp}%` }} />
    </div>
  );
}
