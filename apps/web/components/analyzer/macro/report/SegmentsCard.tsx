"use client";

import { useMemo, useState } from "react";
import { Card, EmptyState } from "@/components/ui/Card";
import { scoreToneTextClass } from "@/lib/macro";
import { wrColor } from "@/lib/format";
import type { MacroReportData, ReportDrill, SegmentRow } from "./types";

/**
 * "Where macro collapses" — average macro score and win rate sliced by
 * matchup, game length, or build. The weakest sufficiently-played
 * segment is flagged so patterns like "my macro holds in PvT but
 * falls apart past 14 minutes" are one glance away.
 *
 * Every row clicks through to the games behind it — matchup and build
 * via opp_race / build, game length via the global min_minutes /
 * max_minutes bounds. The length rows carry their own edges from the
 * API rather than hardcoding them here, so the drill can never drift
 * away from the buckets the bars were computed with.
 */

type SegmentKind = "matchup" | "duration" | "build";

const KINDS: Array<{ id: SegmentKind; label: string }> = [
  { id: "matchup", label: "Matchup" },
  { id: "duration", label: "Game length" },
  { id: "build", label: "Build" },
];

/** Minimum games before a segment can be called the weak spot. */
const WEAK_SPOT_MIN_GAMES = 5;

function drillFor(kind: SegmentKind, row: SegmentRow): ReportDrill | null {
  if (kind === "matchup") {
    if (row.key === "Unknown") return null;
    return {
      title: `Your games ${row.label}`,
      params: { opp_race: row.key },
    };
  }
  if (kind === "build") {
    return {
      title: `Games on “${row.label}”`,
      params: { build: row.key },
    };
  }
  // Game length. A row with neither edge is unbounded on both sides,
  // which is every game — not a drill worth offering.
  const params: Record<string, string | number> = {};
  if (typeof row.minMinutes === "number") params.min_minutes = row.minMinutes;
  if (typeof row.maxMinutes === "number") params.max_minutes = row.maxMinutes;
  if (Object.keys(params).length === 0) return null;
  return { title: `Games lasting ${row.label}`, params };
}

export function SegmentsCard({
  report,
  onDrill,
}: {
  report: MacroReportData;
  onDrill: (drill: ReportDrill) => void;
}) {
  const [kind, setKind] = useState<SegmentKind>("matchup");
  const rows = report.segments[kind];

  const weakKey = useMemo(() => {
    let weakest: SegmentRow | null = null;
    for (const r of rows) {
      if (r.games < WEAK_SPOT_MIN_GAMES || r.avgScore == null) continue;
      if (weakest?.avgScore == null || r.avgScore < weakest.avgScore) {
        weakest = r;
      }
    }
    // Only flag when there's an actual spread to talk about.
    if (!weakest || report.avgScore == null || weakest.avgScore == null) {
      return null;
    }
    return report.avgScore - weakest.avgScore >= 3 ? weakest.key : null;
  }, [rows, report.avgScore]);

  return (
    <Card
      title="Where macro collapses"
      right={
        <div className="flex gap-1 rounded-lg border border-border bg-bg-elevated/50 p-0.5">
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              onClick={() => setKind(k.id)}
              className={`rounded-md px-2 py-1 text-micro font-medium transition-colors ${
                kind === k.id
                  ? "bg-bg-surface text-text shadow-sm"
                  : "text-text-dim hover:text-text-muted"
              }`}
            >
              {k.label}
            </button>
          ))}
        </div>
      }
    >
      {rows.length === 0 || rows.every((r) => r.games === 0) ? (
        <EmptyState
          title="Nothing to segment"
          sub="This slice has no scored games under the current filters."
        />
      ) : (
        <ul className="space-y-1">
          {rows.map((row) => {
            if (row.games === 0) return null;
            const drill = drillFor(kind, row);
            const inner = (
              <>
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate font-medium text-text">
                    {row.label}
                  </span>
                  {row.key === weakKey ? (
                    <span className="shrink-0 rounded border border-warning/40 bg-warning/10 px-1.5 py-px text-micro font-medium text-warning">
                      weak spot
                    </span>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-baseline gap-4 tabular-nums">
                  <span className="text-caption text-text-dim">
                    {row.games.toLocaleString()} games
                  </span>
                  <span
                    className="w-12 text-right text-sm font-semibold"
                    style={{ color: wrColor(row.winRate, row.games) }}
                  >
                    {row.winRate == null
                      ? "—"
                      : `${Math.round(row.winRate * 100)}%`}
                  </span>
                  <span
                    className={`w-12 text-right text-sm font-bold ${scoreToneTextClass(row.avgScore)}`}
                  >
                    {row.avgScore ?? "—"}
                  </span>
                </div>
              </>
            );
            const rowClass =
              "flex w-full items-center justify-between gap-3 rounded-lg border border-border bg-bg-elevated/40 px-3 py-2";
            return (
              <li key={row.key}>
                {drill ? (
                  <button
                    type="button"
                    onClick={() => onDrill(drill)}
                    className={`${rowClass} text-left transition-colors hover:border-border-strong hover:bg-bg-elevated`}
                  >
                    {inner}
                  </button>
                ) : (
                  <div className={rowClass}>{inner}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-2.5 text-micro text-text-dim">
        Right column = avg macro score · middle = win rate. Your overall
        average is {report.avgScore ?? "—"}.
      </p>
    </Card>
  );
}
