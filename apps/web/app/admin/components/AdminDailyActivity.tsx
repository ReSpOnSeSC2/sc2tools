"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { RequestError } from "@/components/ui/RequestError";
import type { ClientApiError } from "@/lib/clientApi";
import { formatNumber } from "@/lib/i18n/format";
import { ADMIN_DAILY_SERIES, dailyTotal } from "./adminDailyEvents";
import type { AdminDailyEvent } from "./adminTypes";

const DailyChart = dynamic(() => import("./AdminDailyChart"), { ssr: false, loading: () => <div className="h-64 motion-safe:animate-pulse rounded bg-bg-elevated" /> });

export function AdminDailyActivity({ days, error, onRetry }: {
  days: AdminDailyEvent[] | undefined; error: ClientApiError | undefined; onRetry: () => unknown;
}) {
  const [table, setTable] = useState(false);
  if (error) return <RequestError title="Daily activity unavailable" error={error} onRetry={onRetry} />;
  if (!days) return <div role="status" aria-label="Loading daily activity" className="h-64 motion-safe:animate-pulse rounded-xl bg-bg-elevated" />;
  const totals = ADMIN_DAILY_SERIES.map(({ key, label }) => formatNumber(dailyTotal(days, key)) + " " + label.toLowerCase());
  return <Card>
    <section aria-labelledby="admin-daily-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="admin-daily-heading" className="text-h3 font-semibold text-text">Last 30 days</h2>
        <Button variant="secondary" size="sm" aria-controls="admin-daily-data" onClick={() => setTable((value) => !value)}>
          {table ? "View as chart" : "View as table"}
        </Button>
      </div>
      <p className="sr-only">Last 30 days: {totals.join(", ")}.</p>
      <p className="text-caption text-text-muted">Dates in UTC. Today is partial.</p>
      <div id="admin-daily-data">
        {table ? <div className="overflow-x-auto">
          <table className="w-full text-left text-caption">
            <caption className="sr-only">Daily activity in UTC</caption>
            <thead><tr><th scope="col" className="px-2 py-2">Date (UTC)</th>
              {ADMIN_DAILY_SERIES.map(({ key, label }) => <th key={key} scope="col" className="px-2 py-2 text-right">{label}</th>)}
            </tr></thead>
            <tbody className="divide-y divide-border">{days.map((day) => <tr key={day.date}>
              <th scope="row" className="px-2 py-2 font-normal tabular-nums">{day.date}</th>
              {ADMIN_DAILY_SERIES.map(({ key }) => <td key={key} className="px-2 py-2 text-right tabular-nums">{formatNumber(day[key])}</td>)}
            </tr>)}</tbody>
          </table>
        </div> : <DailyChart days={days} />}
      </div>
    </section>
  </Card>;
}
