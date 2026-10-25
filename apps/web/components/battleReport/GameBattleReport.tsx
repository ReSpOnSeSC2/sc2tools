"use client";

import { useMemo } from "react";
import type { GameBuildOrderResponse, GameSummary } from "@/components/analyzer/game/types";
import type { MacroBreakdownData } from "@/components/analyzer/macro/MacroBreakdownPanel.types";
import type { MapPlayback } from "@/lib/mapReplay";
import { effectiveBuild, effectiveOpponentBuild, type GameIntentState } from "@/lib/buildIntent";
import { BattleReportSection } from "./BattleReportSection";

type Intent = Pick<GameIntentState, "gameId" | "status" | "applied" | "build" | "detected" | "opponent">;
type Orders = Pick<GameBuildOrderResponse, "events" | "opp_events" | "my_race" | "opp_race">;
export function GameBattleReport({ game, breakdown, buildOrders, intent, myName, playback, segmented, pending, onSeek }: {
  game: GameSummary; breakdown?: MacroBreakdownData | null; buildOrders?: Orders; intent?: Intent;
  myName?: string | null; playback?: MapPlayback | null; segmented?: boolean; pending?: boolean; onSeek: (time: number) => void;
}) {
  const input = useMemo(() => {
    const checkin = intent?.gameId === game.gameId ? intent : undefined;
    const mine = checkin ? effectiveBuild(checkin, game.myBuild) : null;
    const theirs = checkin?.opponent !== undefined ? effectiveOpponentBuild(checkin.opponent, game.opponent?.strategy) : null;
    const reportGame: GameSummary = { ...game, myRace: buildOrders?.my_race ?? game.myRace,
      opponent: { ...game.opponent, race: buildOrders?.opp_race ?? game.opponent?.race, strategy: theirs?.label ?? game.opponent?.strategy },
      ...(mine ? { myBuild: mine.label, buildPlanned: !!mine.planned, detectedBuild: checkin?.detected?.name ?? game.detectedBuild } : {}),
      ...(theirs ? { oppStrategyPlanned: !!theirs.corrected, detectedOppStrategy: checkin?.opponent?.detected?.name ?? game.detectedOppStrategy } : {}),
    };
    return { game: reportGame, myName, plannedBuild: mine?.planned ? mine.label : null, breakdown, playback, buildEvents: buildOrders?.events, oppBuildEvents: buildOrders?.opp_events };
  }, [game, breakdown, buildOrders, intent, myName, playback]);
  return <BattleReportSection input={input} segmented={segmented} pending={pending} onSeek={onSeek} />;
}
