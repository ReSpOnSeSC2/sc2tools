"use client";

import { useApi } from "@/lib/clientApi";
import type { NeighborsResponse } from "@/components/snapshots/shared/snapshotTypes";

export interface NeighborsQuery {
  gameId: string;
  anchorTick: number;
  divergenceTick?: number;
  k?: number;
}

function buildQuery(q: NeighborsQuery): string {
  const params = new URLSearchParams();
  params.set("anchorTick", String(q.anchorTick));
  if (typeof q.divergenceTick === "number") {
    params.set("divergenceTick", String(q.divergenceTick));
  }
  if (typeof q.k === "number") params.set("k", String(q.k));
  return params.toString();
}

export function useNeighbors(q: NeighborsQuery | null) {
  const path = q
    ? `/v1/snapshots/neighbors/${encodeURIComponent(q.gameId)}?${buildQuery(q)}`
    : null;
  return useApi<NeighborsResponse>(path);
}
