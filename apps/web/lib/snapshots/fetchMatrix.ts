"use client";

import { useApi } from "@/lib/clientApi";
import type {
  MatrixResponse,
  SnapshotScope,
} from "@/components/snapshots/shared/snapshotTypes";

export interface MatrixQuery {
  matchup: string;
  mmrBucket?: number;
  tick?: number;
  scope?: SnapshotScope;
}

function buildQuery(q: MatrixQuery): string {
  const params = new URLSearchParams();
  params.set("matchup", q.matchup);
  if (typeof q.mmrBucket === "number") params.set("mmrBucket", String(q.mmrBucket));
  if (typeof q.tick === "number") params.set("tick", String(q.tick));
  if (q.scope) params.set("scope", q.scope);
  return params.toString();
}

export function useMatrix(q: MatrixQuery | null) {
  const path = q ? `/v1/snapshots/matrix?${buildQuery(q)}` : null;
  return useApi<MatrixResponse>(path);
}
