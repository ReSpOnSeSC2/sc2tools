"use client";

import { useMemo, useState } from "react";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { useTrends } from "@/lib/snapshots/fetchTrends";
import {
  fmtTick,
  METRIC_LABELS,
  type MetricKey,
  type TrendsRow,
} from "@/components/snapshots/shared/snapshotTypes";

// /snapshots/trends — recurring weakness / strength surface across
// the user's last N games. Two columns: weaknesses (red dot) and
// strengths (green dot). Each card is one (tick range × metric)
// pattern with the conditional probability + occurrence count.

const MATCHUPS = ["PvP", "PvT", "PvZ", "TvP", "TvT", "TvZ", "ZvP", "ZvT", "ZvZ"];

export default function TrendsPage() {
  const [lastN, setLastN] = useState(20);
  const [matchup, setMatchup] = useState<string | undefined>(undefined);

  const query = useMemo(() => ({ lastN, matchup }), [lastN, matchup]);
  const { data, isLoading, error } = useTrends(query);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="text-h2 font-semibold text-text">Recurring patterns</h1>
        <p className="mt-1 text-body text-text-muted">
          Weaknesses and strengths that repeat across your recent games.
          Each pattern shows the (tick range, metric) bucket and the
          conditional outcome rate.
        </p>
      </header>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-caption text-text-muted">
          Last
          <input
            type="number"
            min={5}
            max={100}
            value={lastN}
            onChange={(e) => setLastN(Math.max(5, Math.min(100, Number(e.target.value) || 20)))}
            className="input w-20"
          />
          games
        </label>
        <select
          className="input w-44"
          value={matchup || ""}
          onChange={(e) => setMatchup(e.target.value || undefined)}
        >
          <option value="">All matchups</option>
          {MATCHUPS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      {isLoading ? (
        <Skeleton rows={6} />
      ) : error ? (
        <Card>
          <EmptyState
            title="Couldn't load your trends"
            sub={error?.message}
          />
        </Card>
      ) : !data || data.gameCount === 0 ? (
        <Card>
          <EmptyState
            title="No games to analyze yet"
            sub="Upload more replays via the desktop agent to get pattern detection."
          />
        </Card>
      ) : (
        <>
          <p className="mb-4 text-caption text-text-dim">
            Analyzing the last {data.gameCount} game{data.gameCount === 1 ? "" : "s"}.
          </p>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <Section title="Recurring weaknesses" tone="danger" rows={data.recurringWeaknesses} kind="weakness" />
            <Section title="Recurring strengths" tone="success" rows={data.strengths} kind="strength" />
          </div>
        </>
      )}
    </div>
  );
}

function Section({
  title,
  tone,
  rows,
  kind,
}: {
  title: string;
  tone: "danger" | "success";
  rows: TrendsRow[];
  kind: "weakness" | "strength";
}) {
  return (
    <Card title={title}>
      {rows.length === 0 ? (
        <p className="py-4 text-center text-caption text-text-dim">
          No recurring patterns matched the threshold yet.
        </p>
      ) : (
        <ul className="divide-y divide-border" role="list">
          {rows.map((r, i) => {
            const rate = kind === "weakness" ? r.lossesWhenBehind ?? 0 : r.winsWhenAhead ?? 0;
            return (
              <li key={i} className="py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-caption font-semibold text-text">
                    {METRIC_LABELS[r.metric as MetricKey] || r.metric}
                  </span>
                  <span className={`text-caption font-semibold ${tone === "danger" ? "text-danger" : "text-success"}`}>
                    {Math.round(rate * 100)}%{" "}
                    <span className="font-normal text-text-dim">
                      {kind === "weakness" ? "loss rate" : "win rate"}
                    </span>
                  </span>
                </div>
                <p className="mt-1 text-[12px] text-text-muted">
                  Between {fmtTick(r.tickRange[0])} and {fmtTick(r.tickRange[1])} — {r.occurrences} occurrence
                  {r.occurrences === 1 ? "" : "s"}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
