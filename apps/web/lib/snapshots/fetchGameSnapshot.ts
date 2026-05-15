"use client";

import { useApi } from "@/lib/clientApi";
import type {
  CohortTooSmall,
  GameSnapshotResponse,
  SnapshotScope,
} from "@/components/snapshots/shared/snapshotTypes";

export interface GameSnapshotQuery {
  gameId: string;
  scope: SnapshotScope;
  mmrBucket?: number;
  mapId?: string;
}

function buildQuery(q: GameSnapshotQuery): string {
  const params = new URLSearchParams();
  params.set("scope", q.scope);
  if (typeof q.mmrBucket === "number") params.set("mmrBucket", String(q.mmrBucket));
  if (q.mapId) params.set("mapId", q.mapId);
  return params.toString();
}

export function useGameSnapshot(q: GameSnapshotQuery | null) {
  const path = q
    ? `/v1/snapshots/game/${encodeURIComponent(q.gameId)}?${buildQuery(q)}`
    : null;
  return useApi<GameSnapshotResponse | CohortTooSmall>(path);
}

export function isGameTooSmall(
  data: GameSnapshotResponse | CohortTooSmall | undefined,
): data is CohortTooSmall {
  return Boolean(data && (data as CohortTooSmall).tooSmall);
}
