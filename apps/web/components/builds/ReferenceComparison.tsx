"use client";

import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { useApi } from "@/lib/clientApi";
import { humanizeBuildName } from "@/lib/build-events";
import { GHOST_SYNC_EVENT as GHOST_ARMED_EVENT } from "@/lib/ghostPracticeEvents";

type Side = "you" | "opponent";
type ComparisonRow = {
  name: string;
  occurrence: number;
  targetSec: number;
  actualSec: number | null;
  deltaSec: number | null;
  kind: "building" | "unit" | "upgrade" | "other";
  timing: "started" | "completed" | "recorded";
  status: "observed" | "event_mismatch" | "missing";
};
export type ReferenceComparisonResponse = {
  status: "ready" | "no_reference" | "source_replay" | "replay_pending";
  matchup: string;
  buildKey: string;
  reference?: { name: string; sourceGameId: string; revision: string };
  rows: ComparisonRow[];
};

export function ReferenceComparison({ gameId, side, buildKey }: {
  gameId: string;
  side?: Side;
  buildKey?: string;
}) {
  const headingId = useId();
  const [selectedSide, setSelectedSide] = useState<Side>("you");
  const perspective = side ?? selectedSide;
  const query = new URLSearchParams({ gameId, side: perspective });
  if (buildKey) query.set("buildKey", buildKey);
  const comparison = useApi<ReferenceComparisonResponse>(`/v1/me/ghost-builds/comparison?${query}`, { keepPreviousData: false });
  const { mutate } = comparison;
  useEffect(() => {
    const refresh = () => { void mutate(); };
    window.addEventListener(GHOST_ARMED_EVENT, refresh);
    return () => window.removeEventListener(GHOST_ARMED_EVENT, refresh);
  }, [mutate]);
  const data = comparison.isPreviousData ? undefined : comparison.data;

  return <section aria-labelledby={headingId} className="mt-4 rounded-lg border border-border bg-bg-surface p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 id={headingId} className="text-caption font-semibold text-text">Replay vs Ghost reference</h4>
      {side === undefined ? <div role="group" aria-label="Reference comparison perspective" className="flex gap-1">
        {(["you", "opponent"] as const).map((value) => <Button key={value} size="sm" variant={perspective === value ? "secondary" : "ghost"}
          aria-pressed={perspective === value} onClick={() => setSelectedSide(value)}>{value === "you" ? "Your build" : "Opponent build"}</Button>)}
      </div> : null}
    </div>
    <p className="mt-1 text-micro text-text-muted">Historical replay timings only, not live completion tracking. Repeated steps match in order; starts compare with starts and completions with completions.</p>
    {comparison.error ? <div role="status" className="mt-3 text-caption text-text-muted">
      <p>Could not compare this replay. Its timed build order may not be available yet.</p>
      <Button size="sm" variant="ghost" onClick={() => { void mutate(); }}>Retry comparison</Button>
    </div> : !data ? <p role="status" className="mt-3 text-caption text-text-muted">Loading reference comparison…</p>
      : data.status !== "ready" ? <p role="status" className="mt-3 text-caption text-text-muted">{emptyMessage(data.status)}</p>
        : <>
          <p className="mt-3 text-caption text-text"><span className="font-semibold">{data.reference?.name || "Saved reference"}</span> <span className="text-text-muted">· {data.matchup} · {perspective === "you" ? "your build" : "opponent build"}</span></p>
          <div className="mt-2 max-h-80 overflow-auto rounded border border-border">
            <table className="w-full text-left text-caption">
              <caption className="sr-only">Historical build timing comparison. Positive differences mean later in this replay.</caption>
              <thead className="sticky top-0 bg-bg-elevated text-micro text-text-muted"><tr>
                <th scope="col" className="px-3 py-2">Step</th><th scope="col" className="px-3 py-2 text-right">Reference</th>
                <th scope="col" className="px-3 py-2 text-right">Replay</th><th scope="col" className="px-3 py-2 text-right">Difference</th>
              </tr></thead>
              <tbody>{data.rows.map((row, index) => <tr key={`${row.name}-${row.occurrence}-${index}`} className="border-t border-border">
                <th scope="row" className="px-3 py-2 font-normal text-text"><span className="flex items-center gap-2">
                  <Icon name={row.name} kind={row.kind === "other" ? undefined : row.kind} size={20} decorative />
                  <span>{humanizeBuildName(row.name)}{row.occurrence > 1 ? ` #${row.occurrence}` : ""}<span className="block text-micro text-text-dim">{row.timing}</span></span>
                </span></th>
                <td className="px-3 py-2 text-right font-mono tabular-nums">{clock(row.targetSec)}</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">{row.actualSec === null ? "—" : clock(row.actualSec)}</td>
                <td className="px-3 py-2 text-right text-micro text-text-muted">{row.status === "missing" ? "Not in extracted opening" : row.status === "event_mismatch" ? "Different event timing" : difference(row.deltaSec)}</td>
              </tr>)}</tbody>
            </table>
          </div>
          <p className="mt-2 text-micro text-text-muted">+ means later; − means earlier. Missing extracted steps do not prove they were skipped. No build durations are subtracted.</p>
        </>}
  </section>;
}

function emptyMessage(status: ReferenceComparisonResponse["status"]): string {
  if (status === "source_replay") return "This is the reference replay itself. Compare another game using the same build and matchup.";
  if (status === "replay_pending") return "Comparison is available after the game ends and its replay is recorded.";
  return "No reference for this player’s build in this exact matchup. Star a replay from the same build to compare future games.";
}

function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function difference(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds === 0) return "On time";
  return `${seconds > 0 ? "+" : "−"}${Number(Math.abs(seconds).toFixed(1))}s ${seconds > 0 ? "later" : "earlier"}`;
}
