"use client";

import useSWR from "swr";
import { API_BASE } from "@/lib/clientApi";

type RetentionRow = { unit: string; value: number };

export type RetentionPolicy = {
  available: boolean;
  retention: RetentionRow[];
  /** A previous cluster's schedule while it or its backups still exist. */
  legacyRetention?: RetentionRow[];
  checkedAt: string | null;
};

// Exact month length (365.25 / 12), so 12 months ties 1 year and the tie
// goes to the larger unit.
const UNIT_DAYS: Record<string, number> = { days: 1, weeks: 7, months: 30.4375, years: 365.25 };
const UNIT_RANK: Record<string, number> = { days: 0, weeks: 1, months: 2, years: 3 };

function formatSchedule(rows: RetentionRow[]): string {
  return [...new Set(rows.map(({ value, unit }) => `${value} ${value === 1 ? unit.replace(/s$/, "") : unit}`))].join("; ");
}

function longest(rows: RetentionRow[]): RetentionRow | null {
  let best: RetentionRow | null = null;
  let bestDays = -1;
  for (const row of rows) {
    const days = (UNIT_DAYS[row.unit] ?? 0) * row.value;
    const largerUnitTie = best !== null && days === bestDays
      && (UNIT_RANK[row.unit] ?? -1) > (UNIT_RANK[best.unit] ?? -1);
    if (days > bestDays || largerUnitTie) {
      best = row;
      bestDays = days;
    }
  }
  return best;
}

export function BackupRetention() {
  const { data } = useSWR<RetentionPolicy>("/v1/site/data-retention", async (path: string) => {
    const response = await fetch(`${API_BASE}${path}`);
    if (!response.ok) throw new Error("retention_unavailable");
    return response.json();
  }, { revalidateOnFocus: false, shouldRetryOnError: false });
  const legacyRows = data?.legacyRetention ?? [];
  const max = longest(legacyRows);
  const legacy = max
    ? <p>A previous database cluster is still kept for rollback. It holds a copy of accounts as they were when we moved to the current database, including accounts deleted since. That copy remains until the cluster is deleted, and its backups expire under their own schedule, up to {formatSchedule([max])} ({formatSchedule(legacyRows)}).</p>
    : null;
  if (!data?.available || !data.retention.length) {
    return <><p>Current database backup retention window is unavailable. Copies expire under the configured backup schedule. Contact support for the current window.</p>{legacy}</>;
  }
  return <><p>Current database backup retention: {formatSchedule(data.retention)}. {legacy ? "Copies inside the current database's backups" : "Copies already inside service backups"} are not edited individually and expire under this schedule.</p>{legacy}</>;
}
