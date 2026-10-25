"use client";

import { Card, Skeleton } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { QueryState } from "@/components/ui/QueryState";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { useApi } from "@/lib/clientApi";
import type { DossierAnalysis, TimingHistoryFilter } from "@/lib/dossierTypes";
import type { BuildPhasePayload, BuildTransitionsPayload } from "@/lib/serverApi";
import { GameSourceLabelProvider } from "./GameAnalysisLink";
import { OpponentKeyTimings } from "./OpponentKeyTimings";
import { PhaseTrajectoryStrip } from "./PhaseTrajectoryStrip";
import { PhaseCompositionTabs } from "./PhaseCompositionTabs";
import { BuildTransitionSankey } from "./BuildTransitionSankey";
import { PredictedStrategiesList, type Prediction } from "./PredictedStrategiesList";
import { DOSSIER_ERROR_COPY } from "./OpponentDossierStates";
import { dossierIsBusy, useDossierBusyRetry } from "./useDossierBusyRetry";

export type DossierAnalysisResponse = DossierAnalysis & { phases?: BuildPhasePayload; transitions?: BuildTransitionsPayload };

/** Mounted by DossierOnView. One owner-scoped request feeds all detail cards. */
export function DossierAnalysisSection({ path, scopeLabel, sourceFilters, predictions, selected, onSelect }: {
  path: string; scopeLabel: string; sourceFilters: string; predictions: Prediction[] | null;
  selected: TimingHistoryFilter | null; onSelect: (selection: TimingHistoryFilter | null) => void;
}) {
  const request = useApi<DossierAnalysisResponse>(path, { revalidateOnFocus: false, keepPreviousData: false, shouldRetryOnError: false });
  const retrying = useDossierBusyRetry(path, request.error, request.mutate);
  const { data } = request;
  const count = data?.analysisSampleSize;
  return <GameSourceLabelProvider label="Opponent analysis" filters={sourceFilters} replace><div className="min-w-0 space-y-5">
    <p className="text-caption text-text-muted">Analysis scope: {scopeLabel}.{count !== undefined ? ` ${count} analyzed games${data?.analysisCohortSize !== undefined ? ` from ${data.analysisCohortSize} matching metadata rows` : ""}.` : ""}{data?.gamesTruncated ? " Metadata covers the latest 1,000 meetings." : ""} <LazyHelpLink slug="opponent-dossier" anchor="reading-key-timings">Reading these timings</LazyHelpLink></p>
    <div className="grid min-w-0 gap-5 lg:grid-cols-2"><Card title="Likely strategies next"><p className="mb-3 text-caption text-text-muted">Recent matching meetings across all dates. Independent of the analysis date window and history selections.</p>{predictions ? <PredictedStrategiesList predictions={predictions} /> : <p role="status" className="text-caption text-text-muted">Updating tendencies…</p>}</Card>
      {data ? <OpponentKeyTimings analysis={data} selected={selected} onSelect={onSelect} /> : <Card title="Key timings"><QueryState q={request} skeleton={<Skeleton rows={4} />} errorCopy={DOSSIER_ERROR_COPY} renderError={error => dossierIsBusy(error) && retrying ? <div role="status"><p>Analyzing… retrying</p><Button variant="ghost" onClick={() => void request.mutate()}>Retry now</Button></div> : undefined} /></Card>}
    </div>
    {data && request.error ? <p role="status" className="text-caption text-warning">Couldn&apos;t refresh this analysis. <Button variant="ghost" onClick={() => void request.mutate()}>Retry analysis</Button></p> : null}
    {data?.phases ? <>
      <Card title="Your game phases"><PhaseTrajectoryStrip sampleSize={data.phases.sampleSize} crossings={data.phases.medianCrossings} finalPhaseDistribution={data.phases.finalPhaseDistribution} durationP95Sec={data.phases.durationP95Sec} /></Card>
      <Card title="Recorded compositions"><PhaseCompositionTabs sampleSize={data.phases.sampleSize} perPhase={data.phases.perPhase} byStrategy={data.phases.byStrategy} showTechRow /></Card>
    </> : null}
    {data?.transitions ? <Card title="Recorded transitions"><BuildTransitionSankey transitions={data.transitions} /></Card> : null}
  </div></GameSourceLabelProvider>;
}
