"use client";
import { useId, useMemo } from "react";
import { AlertCircle } from "lucide-react";
import { useApi } from "@/lib/clientApi";
import type { MapReplayController } from "@/lib/useMapReplay";
import { computeEffectiveRace, computePenaltyRows, computeWins, formatGameClock, getRaceDetail, isMissingChartSamples, scoreToneTextClass, selectLeaks } from "@/lib/macro";
import { MapReplaySection } from "@/components/analyzer/game/MapReplaySection";
import { MacroChartSection } from "./MacroChartSection";
import { MacroLeaksList } from "./MacroLeaksList";
import { MacroPenaltyBars } from "./MacroPenaltyBars";
import { MacroKpiRow } from "./MacroKpiRow";
import { readGameApm, type ApmCurveResponse } from "@/lib/apm";
import { patchEraForGame } from "@/lib/ladderPulse";
import type { LeakItem, MacroBreakdownData, PanelHeaderMeta } from "./MacroBreakdownPanel.types";

export function MacroBreakdownBody({
  data,
  gameId,
  initialScore,
  highlightedKey,
  onHighlight,
  headerMeta,
  replayController,
  onRecompute,
  recomputing,
  includeReplay = true,
  inspectionTime,
  onSeek,
}: {
  data: MacroBreakdownData;
  gameId: string;
  initialScore?: number | null;
  highlightedKey: string | null;
  onHighlight: (key: string | null, leak: LeakItem | null) => void;
  headerMeta?: PanelHeaderMeta;
  replayController?: MapReplayController;
  onRecompute: () => void;
  recomputing: boolean;
  includeReplay?: boolean;
  inspectionTime?: number | null;
  onSeek?: (time: number) => void;
}) {
  const headingId = useId();
  const score =
    typeof data.macro_score === "number"
      ? data.macro_score
      : (initialScore ?? null);
  const raw = useMemo(() => data.raw || {}, [data.raw]);
  const effectiveRace = computeEffectiveRace(data.race, raw);
  const detail = getRaceDetail(effectiveRace);
  const leaks = useMemo(() => selectLeaks(data), [data]);
  const wins = useMemo(() => computeWins(raw, detail), [raw, detail]);
  const penaltyRows = useMemo(
    () => computePenaltyRows(raw, detail),
    [raw, detail],
  );
  const headlineColour = scoreToneTextClass(score);
  const samplesMissing = isMissingChartSamples(data);
  // One read of the APM curve feeds both the timeline's APM view and the
  // APM tile; pre-v2 curves (misattributed, commands only) read as null.
  const apmReq = useApi<ApmCurveResponse>(
    `/v1/games/${encodeURIComponent(gameId)}/apm-curve`,
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );
  const gameApm = useMemo(() => readGameApm(apmReq.data), [apmReq.data]);
  // The calling row's version decides the era that prices units; a row
  // without one falls back to patchEraForGame's date rule.
  const patchEra = patchEraForGame({
    gameVersion: headerMeta?.gameVersion,
    gameBuild: headerMeta?.gameBuild,
    date: headerMeta?.dateIso,
  });

  return (
    <div className="space-y-5 sm:space-y-6">
      <section
        aria-label="Match timeline"
        // Edge to edge on phones (the chart uses the full screen width);
        // a card on larger screens.
        className="-mx-4 sm:mx-0 sm:rounded-lg sm:border sm:border-border sm:bg-bg-elevated/40 sm:p-4"
      >
        {samplesMissing ? (
          <div className="px-4 sm:px-0">
            <ChartSamplesMissingHint />
          </div>
        ) : (
          <MacroChartSection
            inspectionTime={inspectionTime}
            onSeek={onSeek}
            samples={data.stats_events || []}
            oppSamples={data.opp_stats_events || []}
            unitTimeline={data.unit_timeline}
            casualtyEvents={data.casualty_events}
            onRecompute={onRecompute}
            recomputing={recomputing}
            myProductionBuildings={data.production_buildings}
            oppProductionBuildings={data.opp_production_buildings}
            gameLengthSec={data.game_length_sec}
            leaks={leaks}
            supplyBlockWindows={raw.supply_block_windows}
            oppSupplyBlockWindows={raw.opp_supply_block_windows}
            highlightedKey={highlightedKey}
            myName={headerMeta?.playerName ?? null}
            oppName={headerMeta?.opponentName ?? null}
            myRace={headerMeta?.myRace ?? data.race ?? null}
            oppRace={headerMeta?.opponentRace ?? null}
            gameId={gameId}
            apm={gameApm}
            patchEra={patchEra}
          />
        )}
      </section>

      {includeReplay ? <MapReplaySection
        gameId={gameId}
        compact
        controller={replayController}
        myRace={headerMeta?.myRace ?? data.race ?? null}
        patchEra={patchEra}
      /> : null}

      <Headline score={score} colourClass={headlineColour} />

      <MacroKpiRow raw={raw} apm={gameApm} apmLoading={apmReq.isLoading} />

      <section
        aria-labelledby={`${headingId}-penalty`}
        className="space-y-3 rounded-lg border border-border bg-bg-elevated/40 p-4"
      >
        <h3
          id={`${headingId}-penalty`}
          className="text-caption font-semibold uppercase tracking-wider text-text-muted"
        >
          Where the score went
        </h3>
        <MacroPenaltyBars
          rows={penaltyRows}
          caption="Each bar shows how much that discipline shaved off the headline. Empty bars mean the penalty was zero."
        />
        {detail &&
        raw[detail.actualKey] != null &&
        raw[detail.expectedKey] != null ? (
          <RaceDisciplineCallout
            title={detail.title}
            actual={Number(raw[detail.actualKey] || 0)}
            expected={Number(raw[detail.expectedKey] || 0)}
            unitPlural={detail.unitPlural}
          />
        ) : null}
        {typeof raw.creep_tumors_total === "number" ? (
          <CreepTumorCallout
            total={raw.creep_tumors_total}
            queen={Number(raw.creep_tumors_queen || 0)}
            spread={Number(raw.creep_tumors_spread || 0)}
            lost={Number(raw.creep_tumors_lost || 0)}
            firstSec={
              typeof raw.first_tumor_sec === "number"
                ? raw.first_tumor_sec
                : null
            }
          />
        ) : null}
      </section>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <section
          aria-labelledby={`${headingId}-leaks`}
          className="space-y-2 rounded-lg border border-border bg-bg-elevated/40 p-4"
        >
          <h3
            id={`${headingId}-leaks`}
            className="text-caption font-semibold uppercase tracking-wider text-danger"
          >
            Where you lost economy
          </h3>
          <MacroLeaksList
            leaks={leaks}
            highlightedKey={highlightedKey}
            onSelect={onHighlight}
          />
        </section>

        {wins.length > 0 ? (
          <section
            aria-labelledby={`${headingId}-wins`}
            className="space-y-2 rounded-lg border border-border bg-bg-elevated/40 p-4"
          >
            <h3
              id={`${headingId}-wins`}
              className="text-caption font-semibold uppercase tracking-wider text-success"
            >
              What you did well
            </h3>
            <ul className="list-disc space-y-1 pl-5 text-caption text-text">
              {wins.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

    </div>
  );
}

function Headline({
  score,
  colourClass,
}: {
  score: number | null;
  colourClass: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-3">
      <span className="text-caption uppercase tracking-wider text-text-dim">
        Macro Score
      </span>
      <span
        className={`text-display-lg font-bold tabular-nums ${colourClass}`}
        aria-label={
          typeof score === "number"
            ? `Score ${score} of 100`
            : "Score not computed"
        }
      >
        {typeof score === "number" ? score : "—"}
        <span className="ml-1 text-body-lg font-normal text-text-dim">
          / 100
        </span>
      </span>
    </div>
  );
}

function RaceDisciplineCallout({
  title,
  actual,
  expected,
  unitPlural,
}: {
  title: string;
  actual: number;
  expected: number;
  unitPlural: string;
}) {
  const pct = Math.round((100 * actual) / Math.max(1, expected));
  return (
    <div className="rounded-md bg-bg-subtle p-3">
      <div className="text-micro uppercase tracking-wider text-text-dim">
        {title}
      </div>
      <div className="mt-1 text-caption text-accent">
        {actual} of ~{expected} expected ({pct}% {unitPlural})
      </div>
    </div>
  );
}

/**
 * Zerg creep tracking summary. Rendered only when the breakdown carries
 * the creep fields (engine 1.5.6+) — older payloads omit them and the
 * box stays hidden rather than claiming "0 tumors" it never measured.
 */
function CreepTumorCallout({
  total,
  queen,
  spread,
  lost,
  firstSec,
}: {
  total: number;
  queen: number;
  spread: number;
  lost: number;
  firstSec: number | null;
}) {
  return (
    <div className="rounded-md bg-bg-subtle p-3">
      <div className="text-micro uppercase tracking-wider text-text-dim">
        Creep spread
      </div>
      <div className="mt-1 text-caption text-accent">
        {total === 0 ? (
          "No creep tumors planted"
        ) : (
          <>
            {total} tumor{total === 1 ? "" : "s"} planted ({queen} queen /{" "}
            {spread} spread)
            {firstSec !== null ? ` · first at ${formatGameClock(firstSec)}` : ""}
            {lost > 0 ? ` · ${lost} lost` : ""}
          </>
        )}
      </div>
    </div>
  );
}

function ChartSamplesMissingHint() {
  return (
    <div className="rounded-md border border-border bg-bg-subtle p-3 text-caption text-text-muted">
      <div className="inline-flex items-center gap-2 font-semibold text-accent-cyan">
        <AlertCircle className="h-4 w-4" aria-hidden />
        Per-second samples not available
      </div>
      <p className="mt-1">
        This game's stored breakdown is the slim variant — the time-series
        chart needs the full sample stream from your SC2 agent. Click
        Recompute to ask the agent to re-parse the replay.
      </p>
    </div>
  );
}
