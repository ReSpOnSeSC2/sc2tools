"use client";

import useSWR from "swr";
import { API_BASE } from "@/lib/clientApi";

type RetentionRow = { unit: string; value: number };

export type RetentionPolicy = {
  available: boolean;
  retention: RetentionRow[];
  /** A previous cluster's schedule while its backups still exist. */
  legacyRetention?: RetentionRow[];
  checkedAt: string | null;
};

function formatSchedule(rows: RetentionRow[]): string {
  return [...new Set(rows.map(({ value, unit }) => `${value} ${value === 1 ? unit.replace(/s$/, "") : unit}`))].join("; ");
}

export function BackupRetention() {
  const { data } = useSWR<RetentionPolicy>("/v1/site/data-retention", async (path: string) => {
    const response = await fetch(`${API_BASE}${path}`);
    if (!response.ok) throw new Error("retention_unavailable");
    return response.json();
  }, { revalidateOnFocus: false, shouldRetryOnError: false });
  const legacy = data?.legacyRetention?.length
    ? <p>Backups from the previous database cluster are also kept and expire under their own schedule: {formatSchedule(data.legacyRetention)}.</p>
    : null;
  if (!data?.available || !data.retention.length) {
    return <><p>Current database backup retention window is unavailable. Copies expire under the configured backup schedule. Contact support for the current window.</p>{legacy}</>;
  }
  return <><p>Current database backup retention: {formatSchedule(data.retention)}. Copies already inside service backups are not edited individually and expire under this schedule.</p>{legacy}</>;
}
