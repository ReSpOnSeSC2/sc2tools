"use client";

import useSWR from "swr";
import { API_BASE } from "@/lib/clientApi";

export type RetentionPolicy = { available: boolean; retention: { unit: string; value: number }[]; checkedAt: string | null };

export function BackupRetention() {
  const { data } = useSWR<RetentionPolicy>("/v1/site/data-retention", async (path: string) => {
    const response = await fetch(`${API_BASE}${path}`);
    if (!response.ok) throw new Error("retention_unavailable");
    return response.json();
  }, { revalidateOnFocus: false, shouldRetryOnError: false });
  if (!data?.available || !data.retention.length) return <p>Current database backup retention window is unavailable. Copies expire under the configured backup schedule. Contact support for the current window.</p>;
  return <p>Current database backup retention: {[...new Set(data.retention.map(({ value, unit }) => `${value} ${value === 1 ? unit.replace(/s$/, "") : unit}`))].join("; ")}. Copies already inside service backups are not edited individually and expire under this schedule.</p>;
}
