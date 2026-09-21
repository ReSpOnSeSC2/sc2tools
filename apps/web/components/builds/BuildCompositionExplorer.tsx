"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Clock3, Layers3 } from "lucide-react";
import { PhaseCompositionTabs, type Phase, type PhaseCompositionRow } from "@/components/analyzer/PhaseCompositionTabs";
import { PhaseTrajectoryStrip } from "@/components/analyzer/PhaseTrajectoryStrip";
import { UnitCompositionTable, compositionTime, unitLabel, type UnitSummary } from "@/components/analyzer/UnitCompositionTable";
import { EmptyState } from "@/components/ui/Card";
import { useApi } from "@/lib/clientApi";
import type { BuildPhasePayload, CompositionGame } from "@/lib/serverApi";

const focus = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg";
const phases: Record<Phase, string> = { early: "Early", earlyMid: "Early/Mid", mid: "Mid", midLate: "Mid/Late", late: "Late" };
const filterLabels: Record<string, string> = {
  since: "From", until: "Until", race: "Your race", opp_race: "Opponent race", map: "Map",
  mmr_min: "Minimum MMR", mmr_max: "Maximum MMR", opp_strategy: "Opponent strategy", build: "Build",
  min_minutes: "Minimum minutes", max_minutes: "Maximum minutes", macro_min: "Minimum macro", macro_max: "Maximum macro",
  regions: "Regions", map_pool: "Map pool", game_size: "Game size", exclude_too_short: "Exclude short games", leak: "Leak filter",
};

export function compositionComparisonPath(apiPath: string, gameId: string) {
  const url = new URL(apiPath, "https://sc2tools.invalid");
  url.searchParams.set("compareGameId", gameId);
  return `${url.pathname}${url.search}${url.hash}`;
}

function dateLabel(date: string | null) {
  if (!date) return null;
  const parsed = new Date(date);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : null;
}

function gameLabel(game: CompositionGame, index: number) {
  return [dateLabel(game.date), game.opponentName ? `vs ${game.opponentName}` : game.oppRace ? `vs ${game.oppRace}` : null,
    game.map, game.result, compositionTime(game.durationSec), `#${index + 1}`].filter(Boolean).join(" · ");
}

/** The endpoint carries the dossier's filters, revision and perspective. Selecting
 * a game requests a server-calculated, leave-one-out baseline in that same scope. */
export function BuildCompositionExplorer({ payload, apiPath, onOpenGames }: {
  payload: BuildPhasePayload;
  apiPath: string;
  onOpenGames: (gameIds: string[], label: string) => void;
}) {
  const id = useId();
  const [mode, setMode] = useState<"clock" | "phase">("clock");
  const [time, setTime] = useState(() => payload.checkpoints?.find((point) => point.timeSec === 360 && point.unitSummary.observedGames > 0)?.timeSec
    ?? payload.checkpoints?.find((point) => point.unitSummary.observedGames > 0)?.timeSec ?? 360);
  const [selection, setSelection] = useState("");
  const selectionGames = payload.comparisonGames ?? [];
  const selectedId = selectionGames.some((game) => game.gameId === selection) ? selection : "";
  const comparison = useApi<BuildPhasePayload>(selectedId ? compositionComparisonPath(apiPath, selectedId) : null,
    { keepPreviousData: false, revalidateOnFocus: true }, { timeoutMs: 45000 });
  const refreshComparison = comparison.mutate;
  const previousPayload = useRef(payload);
  useEffect(() => {
    if (previousPayload.current === payload) return;
    previousPayload.current = payload;
    if (selectedId) void refreshComparison();
  }, [payload, selectedId, refreshComparison]);
  const response = selectedId && comparison.data && !comparison.error ? comparison.data : payload;
  const games = response.comparisonGames ?? selectionGames;
  const cleanSummary = (summary: UnitSummary): UnitSummary => ({ ...summary,
    comparison: selectedId && !comparison.error && summary.comparison?.gameId === selectedId ? summary.comparison : undefined });
  const checkpoints = response.checkpoints ?? payload.checkpoints ?? [];
  const checkpoint = checkpoints.find((point) => point.timeSec === time) ?? checkpoints[0];
  const perPhase = Object.fromEntries(Object.entries(response.perPhase).map(([phase, row]) => [phase,
    { ...row, unitSummary: row.unitSummary ? cleanSummary(row.unitSummary) : undefined }])) as Record<Phase, PhaseCompositionRow>;
  const hasComparison = Boolean(checkpoint?.unitSummary.comparison?.gameId === selectedId && selectedId)
    || Object.values(perPhase).some((phase) => phase.unitSummary?.comparison?.gameId === selectedId && selectedId);
  const filters = [...new URL(apiPath, "https://sc2tools.invalid").searchParams.entries()].filter(([key]) => filterLabels[key]);
  const dated = games.map((game) => game.date).filter((date): date is string => !!date && Number.isFinite(new Date(date).getTime())).sort();
  const matchups = new Map<string, number>();
  games.forEach((game) => {
    const matchup = game.myRace && game.oppRace ? `${game.myRace} vs ${game.oppRace}` : "Race unavailable";
    matchups.set(matchup, (matchups.get(matchup) ?? 0) + 1);
  });

  return <div className="min-w-0 space-y-5" data-testid="build-composition-explorer">
    <div className="space-y-2">
      <p className="text-caption leading-relaxed text-text-muted">See the army this build usually fields, then compare a game or open a replay at the measured moment.</p>
      <div className="flex flex-wrap gap-2 text-micro text-text-muted">
        <span className="rounded-full border border-border bg-bg-elevated px-2.5 py-1">{games.length} sampled game{games.length === 1 ? "" : "s"}</span>
        <span className="rounded-full border border-border bg-bg-elevated px-2.5 py-1">{response.perspective === "opponent" ? "Opponent units" : "Your units"}</span>
        {dated.length ? <span className="rounded-full border border-border bg-bg-elevated px-2.5 py-1">{dateLabel(dated[0])}{dateLabel(dated[0]) !== dateLabel(dated[dated.length - 1]) ? ` – ${dateLabel(dated[dated.length - 1])}` : ""}</span> : null}
      </div>
      {response.sampleTruncated ? <p className="text-micro leading-relaxed text-text-muted">Analysis is limited to the latest {response.sampleLimit ?? games.length} matching games. Older matches are not included.</p> : null}
      <details className="group text-caption text-text-muted">
        <summary className={`flex min-h-11 cursor-pointer list-none items-center gap-2 rounded ${focus}`}>Selection &amp; matchups{filters.length ? ` · ${filters.length} active filter${filters.length === 1 ? "" : "s"}` : ""}<ChevronDown className="h-3.5 w-3.5 group-open:rotate-180" aria-hidden /></summary>
        <div className="space-y-2 rounded-lg border border-border bg-bg-elevated/50 p-3 text-micro leading-relaxed">
          <p>This build’s matched games, using the current page filters. {dated.length < games.length ? `${games.length - dated.length} games have no recorded date. ` : ""}Dates describe this sample, not when the data was processed.</p>
          <p>{filters.length ? filters.map(([key, value]) => `${filterLabels[key]}: ${value}`).join(" · ") : "No additional page filters."}</p>
          <p>{[...matchups].map(([name, count]) => `${name}: ${count}`).join(" · ") || "No matched games available."}</p>
        </div>
      </details>
    </div>

    <div className="grid min-w-0 gap-4 rounded-lg border border-border bg-bg-elevated/40 p-3 sm:p-4">
      <div className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-bg p-1" role="group" aria-label="Composition view">
        {([{ key: "clock", label: "At game time", Icon: Clock3 }, { key: "phase", label: "By phase", Icon: Layers3 }] as const).map((item) => <button key={item.key} type="button" aria-pressed={mode === item.key} onClick={() => setMode(item.key)} className={`flex min-h-11 items-center justify-center gap-2 rounded-md px-2 text-caption font-medium transition-colors ${focus} ${mode === item.key ? "bg-bg-surface text-text shadow-sm ring-1 ring-border" : "text-text-muted hover:text-text"}`}><item.Icon className="h-4 w-4 shrink-0" aria-hidden />{item.label}</button>)}
      </div>
      <label htmlFor={`${id}-compare`} className="min-w-0 space-y-2 text-caption font-medium text-text">
        <span className="block">Compare a game <span className="font-normal text-text-muted">(optional)</span></span>
        <select id={`${id}-compare`} value={selectedId} disabled={!selectionGames.length} onChange={(event) => setSelection(event.target.value)} className={`min-h-11 w-full min-w-0 max-w-full rounded-md border border-border bg-bg-surface px-3 text-caption font-normal text-text ${focus}`}>
          <option value="">Build overview</option>
          {selectionGames.map((game, index) => <option key={game.gameId} value={game.gameId}>{gameLabel(game, index)}</option>)}
        </select>
      </label>
      {selectedId && (comparison.isLoading || (!comparison.data && !comparison.error)) ? <p role="status" className="text-caption text-text-muted">Calculating this game’s comparison…</p> : null}
      {selectedId && comparison.isValidating && comparison.data && !comparison.isLoading ? <p role="status" className="text-caption text-text-muted">Refreshing comparison. Showing its previous sample until the updated analysis arrives.</p> : null}
      {selectedId && !comparison.isLoading && (comparison.error || (comparison.data && !hasComparison)) ? <div role="status" className="flex flex-wrap items-center justify-between gap-2 text-caption text-text-muted"><span>Comparison unavailable. The build overview remains available.</span><button type="button" onClick={() => { void comparison.mutate(); }} className={`min-h-11 rounded-md border border-border px-3 font-medium text-text ${focus}`}>Retry comparison</button></div> : null}
    </div>

    {mode === "clock" ? <div className="space-y-4">
      <div className="space-y-2">
        <div className="grid grid-cols-5 gap-1.5" role="group" aria-label="Game time checkpoint">
          {checkpoints.map((point) => <button key={point.timeSec} type="button" aria-pressed={point.timeSec === checkpoint?.timeSec} onClick={() => setTime(point.timeSec)} className={`min-h-11 rounded-md border px-1 py-2 text-caption font-semibold tabular-nums ${focus} ${point.timeSec === checkpoint?.timeSec ? "border-accent bg-accent/10 text-text" : "border-border text-text-muted hover:bg-bg-elevated"}`}>{compositionTime(point.timeSec)}</button>)}
        </div>
        {checkpoint ? <p className="text-micro leading-relaxed text-text-muted"><strong className="font-medium text-text">{checkpoint.reachedGames} reached {compositionTime(checkpoint.timeSec)}</strong> · {checkpoint.endedGames} ended earlier. Uses each game’s latest sample at or before this time, within 30 seconds.</p> : null}
      </div>
      {checkpoint ? <UnitCompositionTable key={`clock-${checkpoint.timeSec}`} summary={cleanSummary(checkpoint.unitSummary)} onOpenGames={(ids, token) => onOpenGames(ids, `${compositionTime(checkpoint.timeSec)} · Games with ${unitLabel(token)}`)} /> : <EmptyState title="No time checkpoints available" />}
    </div> : response.flags?.includes("opp_signals_sparse") ? <EmptyState title="Opponent phases unavailable" sub="Most games lack the tracker data needed to identify opponent phases. Time checkpoints can still show recorded unit counts." /> : <div className="space-y-4">
      <p className="text-micro leading-relaxed text-text-muted">Phases follow each game’s economy and technology, so their clock times differ. Use game time to compare armies at the same point on the clock.</p>
      <PhaseCompositionTabs sampleSize={response.sampleSize} perPhase={perPhase} preferredPhase="mid"
        onUnitClick={(ids, { phase, token }) => onOpenGames(ids, `${phases[phase]} · Games with ${unitLabel(token)}`)}
        onSignatureClick={(ids, context) => { if (context) onOpenGames(ids, `${phases[context.phase]} · ${context.signature.units.map((unit) => unitLabel(unit.token)).join(" · ") || "Other"}`); }} />
      <details className="group rounded-lg border border-border px-3 text-caption text-text-muted"><summary className={`flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded ${focus}`}>Phase progression<ChevronDown className="h-3.5 w-3.5 group-open:rotate-180" aria-hidden /></summary><div className="pb-3"><PhaseTrajectoryStrip sampleSize={response.sampleSize} crossings={response.medianCrossings} finalPhaseDistribution={response.finalPhaseDistribution} durationP95Sec={response.durationP95Sec} /></div></details>
    </div>}
  </div>;
}
