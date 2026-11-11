"use client";

import { useMemo } from "react";
import { isPublicReplayReference } from "@/lib/replayRouteAccess";
import { useApi, type ClientApiError } from "@/lib/clientApi";
import type { GameBuildOrderResponse, GameSummary } from "@/components/analyzer/game/types";
import type { MacroBreakdownData } from "@/components/analyzer/macro/MacroBreakdownPanel.types";
import { buildSeries, type SeriesPoint } from "@/components/analyzer/macro/activeArmyLayout";
import { patchEraForGame } from "@/lib/ladderPulse";
import { compareBuildSteps, compareMechanics, type CompareBuildStep, type CompareMechanics } from "@/lib/gameCompare";

export type ResourceState = "loading" | "ready" | "missing" | "error";

export interface CompareSide {
  id: string | null;
  game: GameSummary | null;
  gameState: ResourceState;
  gameError: ClientApiError | undefined;
  retryGame: () => void;
  /** Timeline and mechanics come from the macro breakdown. */
  macroState: ResourceState;
  macroError: ClientApiError | undefined;
  retryMacro: () => void;
  buildState: ResourceState;
  buildError: ClientApiError | undefined;
  retryBuild: () => void;
  series: SeriesPoint[];
  steps: CompareBuildStep[];
  mechanics: CompareMechanics;
  gameLength: number | null;
}

function stateOf(request: { data?: unknown; error?: ClientApiError }, missingCodes: readonly string[]): ResourceState {
  if (request.data) return "ready";
  if (!request.error) return "loading";
  return request.error.status === 404 || (request.error.code !== undefined && missingCodes.includes(request.error.code)) ? "missing" : "error";
}

/**
 * One side of a comparison: three authenticated reads of the owner's game,
 * each with its own loading / missing / error state, plus the derived series, build
 * steps and mechanics. A missing breakdown hides only this side's
 * timeline and mechanics; a missing build order only its diff column.
 */
export function useCompareSide(id: string | null): CompareSide {
  const path = id && isPublicReplayReference(id) ? "/v1/compare-games/" + id : null;
  const options = { revalidateOnFocus: false } as const;
  const gameReq = useApi<GameSummary>(path ? path + "/game" : null, options);
  const macroReq = useApi<MacroBreakdownData>(path ? path + "/macro-breakdown" : null, options);
  const buildReq = useApi<GameBuildOrderResponse>(path ? path + "/build-order" : null, options);
  const game = gameReq.data ?? null;
  const breakdown = macroReq.data ?? null;
  const series = useMemo(
    () => (breakdown?.stats_events?.length ? buildSeries(breakdown.stats_events, breakdown.unit_timeline, "my", undefined, game ? patchEraForGame(game) : null) : []),
    [breakdown, game],
  );
  const steps = useMemo(() => compareBuildSteps(buildReq.data?.events), [buildReq.data]);
  const mechanics = useMemo(() => compareMechanics(breakdown, game), [breakdown, game]);
  const lastSample = series.length ? series[series.length - 1].t : null;
  return {
    id,
    game,
    gameState: id ? stateOf(gameReq, []) : "missing",
    gameError: gameReq.error,
    retryGame: () => void gameReq.mutate(),
    macroState: id ? stateOf(macroReq, ["macro_not_computed"]) : "missing",
    macroError: macroReq.error,
    retryMacro: () => void macroReq.mutate(),
    buildState: id ? (buildReq.data?.my_status === "not_extracted" || buildReq.data?.my_status === "empty" ? "missing" : stateOf(buildReq, ["build_not_computed"])) : "missing",
    buildError: buildReq.error,
    retryBuild: () => void buildReq.mutate(),
    series,
    steps,
    mechanics,
    gameLength: game?.durationSec ?? breakdown?.game_length_sec ?? lastSample,
  };
}
