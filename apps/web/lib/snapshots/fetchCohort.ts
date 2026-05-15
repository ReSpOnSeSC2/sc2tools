"use client";

import { useApi } from "@/lib/clientApi";
import type {
  BuildsListResponse,
  CohortResponse,
  CohortTooSmall,
  SnapshotScope,
} from "@/components/snapshots/shared/snapshotTypes";

export interface CohortQuery {
  build?: string;
  matchup?: string;
  oppOpening?: string;
  mmrBucket?: number;
  mapId?: string;
  scope: SnapshotScope;
}

function buildQuery(q: CohortQuery): string {
  const params = new URLSearchParams();
  if (q.build) params.set("build", q.build);
  if (q.matchup) params.set("matchup", q.matchup);
  if (q.oppOpening) params.set("oppOpening", q.oppOpening);
  if (typeof q.mmrBucket === "number") params.set("mmrBucket", String(q.mmrBucket));
  if (q.mapId) params.set("mapId", q.mapId);
  params.set("scope", q.scope);
  return params.toString();
}

export function useCohort(q: CohortQuery | null) {
  const path = q ? `/v1/snapshots/cohort?${buildQuery(q)}` : null;
  return useApi<CohortResponse | CohortTooSmall>(path);
}

export function useBuilds(matchup?: string) {
  const path = matchup
    ? `/v1/snapshots/builds?matchup=${encodeURIComponent(matchup)}`
    : "/v1/snapshots/builds";
  return useApi<BuildsListResponse>(path);
}

export function isTooSmall(
  data: CohortResponse | CohortTooSmall | undefined,
): data is CohortTooSmall {
  return Boolean(data && (data as CohortTooSmall).tooSmall);
}
