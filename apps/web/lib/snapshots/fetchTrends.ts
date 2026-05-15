"use client";

import { useApi } from "@/lib/clientApi";
import type { TrendsResponse } from "@/components/snapshots/shared/snapshotTypes";

export interface TrendsQuery {
  lastN?: number;
  matchup?: string;
  mmrBucket?: number;
}

function buildQuery(q: TrendsQuery): string {
  const params = new URLSearchParams();
  if (typeof q.lastN === "number") params.set("lastN", String(q.lastN));
  if (q.matchup) params.set("matchup", q.matchup);
  if (typeof q.mmrBucket === "number") params.set("mmrBucket", String(q.mmrBucket));
  return params.toString();
}

export function useTrends(q: TrendsQuery | null) {
  const qs = q ? buildQuery(q) : "";
  return useApi<TrendsResponse>(q ? `/v1/snapshots/trends?${qs}` : null);
}
