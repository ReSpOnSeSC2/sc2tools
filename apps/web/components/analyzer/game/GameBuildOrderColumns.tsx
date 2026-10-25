"use client";

import { useApi } from "@/lib/clientApi";
import type { DossierAnalysis } from "@/lib/dossierTypes";
import type { OwnTimingContext } from "@/lib/buildTimingComparison";
import { BuildOrderColumns, type BuildOrderColumnsProps } from "./BuildOrderColumns";

/** One owner-scoped dossier SWR resource for every row. The same key can reuse
 * an already visited dossier; failed or previous responses supply no baseline. */
export function GameBuildOrderColumns({ timingContext, ...props }: BuildOrderColumnsProps & { timingContext?: OwnTimingContext }) {
  const canCompare = !props.loading && !props.error && props.myStatus !== "not_extracted" && props.myStatus !== "empty" && Array.isArray(props.myEvents) && props.myEvents.length > 0;
  const result = useApi<DossierAnalysis>(canCompare ? timingContext?.path ?? null : null, { keepPreviousData: false, dedupingInterval: 60_000, revalidateOnFocus: false, shouldRetryOnError: false });
  return <BuildOrderColumns {...props} myTimingBaseline={canCompare && timingContext && !result.error && !result.isPreviousData && result.data ? { data: result.data, matchup: timingContext.matchup } : undefined} />;
}
