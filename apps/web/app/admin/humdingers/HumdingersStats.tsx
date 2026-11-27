"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { RequestError } from "@/components/ui/RequestError";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/SegmentedControl";
import { useApi } from "@/lib/clientApi";
import { formatDate, formatNumber } from "@/lib/i18n/format";
import { AdminPageHeader } from "../components/AdminPageHeader";
import { ForbiddenCard, LoadingRows, MetricStat } from "../components/AdminFragments";

type Range = "7" | "30" | "90";
type DayRow = { day: string; loads: number; players: number; activeSeconds: number; longPlays: number; savers: number; maxChapter: number };
export type HumdingersStatsResp = {
  days: number;
  totals: { loads: number; playerDays: number; activeSeconds: number; longPlays: number; savers: number; maxChapter: number };
  daily: DayRow[];
};

const RANGES: ReadonlyArray<SegmentedOption<Range>> = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
];

/**
 * /admin/humdingers — anonymous daily totals for the Humdingers browser RPG
 * (ADR 0102): loads, daily players, active play time and progress. No names:
 * each player counts once a day through a hash that expires after 35 days.
 */
export function HumdingersStats() {
  const [range, setRange] = useState<Range>("30");
  const swr = useApi<HumdingersStatsResp>(`/v1/admin/humdingers/stats?days=${range}`, { keepPreviousData: true, revalidateOnFocus: false });
  if (swr.error?.status === 403 || swr.error?.status === 401) return <ForbiddenCard />;
  const data = swr.data;

  return (
    <div className="space-y-6">
      <AdminPageHeader anchor="humdingers-plays" title="Humdingers"
        description="Plays of the browser RPG at /play/humdingers. Anonymous daily totals: no names, and each player counts once a day."
        actions={<SegmentedControl label="Range" value={range} options={RANGES} onChange={setRange} />} />
      {swr.error ? <RequestError error={swr.error} onRetry={() => void swr.mutate()} /> : !data ? <LoadingRows rows={4} /> : (
        <>
          <Totals totals={data.totals} />
          {data.totals.loads === 0 ? (
            <Card padded><EmptyStatePanel title="No plays yet"
              description={`Nobody opened Humdingers in the last ${data.days} days. Plays appear here the same day.`} /></Card>
          ) : <DailyTable rows={data.daily.filter((row) => row.loads > 0 || row.activeSeconds > 0)} />}
        </>
      )}
    </div>
  );
}

function Totals({ totals }: { totals: HumdingersStatsResp["totals"] }) {
  const perPlayer = totals.playerDays ? Math.round(totals.activeSeconds / totals.playerDays) : 0;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <MetricStat label="Plays" value={formatNumber(totals.loads)} caption="Times the game was opened" />
      <MetricStat label="Daily players" value={formatNumber(totals.playerDays)} caption="Players each day, added up" />
      <MetricStat label="Play time" value={duration(totals.activeSeconds)} caption="Active play; idle time left out" />
      <MetricStat label="Per daily player" value={duration(perPlayer)} caption="Average play time" />
      <MetricStat label="Played over a minute" value={formatNumber(totals.longPlays)} caption={`${formatNumber(totals.savers)} daily players had a save`} />
      <MetricStat label="Furthest chapter" value={totals.maxChapter ? formatNumber(totals.maxChapter) : "None yet"} caption="From players' saves" />
    </div>
  );
}

function DailyTable({ rows }: { rows: DayRow[] }) {
  return (
    <Card padded className="overflow-x-auto">
      <table className="w-full min-w-[32rem] text-left text-caption">
        <caption className="sr-only">Humdingers plays by day</caption>
        <thead className="text-text-dim">
          <tr>
            <th scope="col" className="py-2 pr-3 font-semibold">Day (UTC)</th>
            <th scope="col" className="py-2 pr-3 text-right font-semibold">Plays</th>
            <th scope="col" className="py-2 pr-3 text-right font-semibold">Players</th>
            <th scope="col" className="py-2 pr-3 text-right font-semibold">Play time</th>
            <th scope="col" className="py-2 pr-3 text-right font-semibold">Had a save</th>
            <th scope="col" className="py-2 text-right font-semibold">Furthest chapter</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.day} className="border-t border-line">
              <th scope="row" className="py-2 pr-3 font-medium text-text">{formatDate(`${row.day}T00:00:00Z`, { timeZone: "UTC", month: "short", day: "numeric" })}</th>
              <td className="py-2 pr-3 text-right tabular-nums">{formatNumber(row.loads)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{formatNumber(row.players)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{duration(row.activeSeconds)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{formatNumber(row.savers)}</td>
              <td className="py-2 text-right tabular-nums">{row.maxChapter ? formatNumber(row.maxChapter) : "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/** "45 min" or "3 h 5 min"; under a minute rounds to "0 min". */
function duration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${formatNumber(minutes)} min`;
  return `${formatNumber(Math.floor(minutes / 60))} h ${formatNumber(minutes % 60)} min`;
}
