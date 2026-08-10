"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, FileQuestion } from "lucide-react";
import { useApi } from "@/lib/clientApi";
import { Card, Skeleton } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import type { GameVodLinksResponse } from "@/components/analyzer/GameStreamLinks";
import type { MacroBreakdownData } from "@/components/analyzer/macro/MacroBreakdownPanel.types";
import type { AutopsyGame } from "@/lib/lossAutopsy";
import { GameDetailShell } from "./GameDetailShell";
import { InteractiveTimeline } from "./InteractiveTimeline";
import { MapReplaySection } from "./MapReplaySection";
import { MechanicsPanel } from "./MechanicsPanel";
import { BuildOrderColumns } from "./BuildOrderColumns";
import { LossAutopsyCard } from "./LossAutopsyCard";
import { ArmGhostFromLogButton, GhostGradeCard } from "./GhostGradeCard";
import {
  isLossResult,
  type GameBuildOrderResponse,
  type GameSummary,
} from "./types";
import {
  opponentProfileHref,
  type OpponentNavigationContext,
} from "@/lib/opponentNavigation";

/**
 * GameDetailPage — the per-replay deep dive ("I just lost a weird
 * game, show me THAT game"). Client-fetches four endpoints the same
 * way sibling analyzer surfaces do (useApi/SWR + Clerk JWT):
 *
 *   - GET /v1/games/:id                  → slim metadata row (header)
 *   - GET /v1/games/:id/macro-breakdown  → stats_events, leaks, raw
 *   - GET /v1/games/:id/build-order      → parsed build logs, both sides
 *   - GET /v1/games/vod-links?gameId=:id → timestamped POV VOD links
 *
 * Every payload degrades independently: a 404 on the game row is a
 * branded empty state; a missing macro breakdown (pre-v0.5 agents)
 * still renders the header + build orders; missing stats_events
 * (pre-v0.5.11) keeps the mechanics/build panels and swaps the
 * timeline for an explanatory empty state. Never a blank page.
 */
export function GameDetailPage({
  gameId,
  opponentContext,
}: {
  gameId: string;
  opponentContext?: OpponentNavigationContext | null;
}) {
  const enc = encodeURIComponent(gameId);
  const gameReq = useApi<GameSummary>(gameId ? `/v1/games/${enc}` : null, {
    revalidateOnFocus: false,
  });
  const macroReq = useApi<MacroBreakdownData>(
    gameId ? `/v1/games/${enc}/macro-breakdown` : null,
    { revalidateOnFocus: false },
  );
  const buildReq = useApi<GameBuildOrderResponse>(
    gameId ? `/v1/games/${enc}/build-order` : null,
    { revalidateOnFocus: false },
  );
  const vodLinksReq = useApi<GameVodLinksResponse>(
    gameId ? `/v1/games/vod-links?gameId=${enc}` : null,
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );

  // Timeline scrub cursor — shared so the loss-autopsy timestamps and
  // the mechanics panel's supply-block chips can jump the chart.
  const [scrubTime, setScrubTime] = useState<number | null>(null);

  const game = gameReq.data ?? null;
  // The macro endpoint 404s with `macro_not_computed` when the agent
  // never uploaded a breakdown — that's a degrade, not an error page.
  const breakdown = macroReq.data ?? null;

  // Raw `[m:ss] Name` lines rebuilt from the parsed build-order events —
  // lossAutopsy's late-expansion rule parses this exact shape.
  const buildLogLines = useMemo(() => {
    const events = buildReq.data?.events;
    if (!Array.isArray(events)) return null;
    return events.map((ev) => `[${ev.time_display ?? clock(ev.time)}] ${ev.name}`);
  }, [buildReq.data?.events]);

  const autopsyGame = useMemo<AutopsyGame | null>(() => {
    if (!game) return null;
    return {
      id: game.gameId,
      date: game.date ?? null,
      result: game.result ?? null,
      map: game.map ?? null,
      game_length: game.durationSec ?? null,
      macro_score: game.macroScore ?? null,
      macroBreakdown: breakdown,
      buildLog: buildLogLines,
    };
  }, [game, breakdown, buildLogLines]);

  if (!gameId || (gameReq.error && gameReq.error.status === 404)) {
    return (
      <GameNotFound
        title="Game not found"
        opponentContext={opponentContext}
        description="This game isn't in your synced history — it may not have uploaded yet, or the link points at someone else's replay."
      />
    );
  }

  if (gameReq.error) {
    return (
      <GameNotFound
        title="Couldn't load this game"
        description={gameReq.error.message}
        opponentContext={opponentContext}
      />
    );
  }

  if (gameReq.isLoading || !game) {
    return (
      <div className="space-y-6" aria-busy="true" aria-label="Loading game">
        <div className="h-4 w-40 animate-pulse rounded bg-bg-elevated" />
        <div className="h-8 w-72 animate-pulse rounded bg-bg-elevated" />
        <div className="h-64 animate-pulse rounded-xl border-2 border-line bg-bg-surface shadow-hard" />
        <Skeleton rows={4} />
      </div>
    );
  }

  const loss = isLossResult(game.result);
  const myName = breakdown?.player_stats?.me?.name ?? null;
  const oppName =
    game.opponent?.displayName ?? breakdown?.player_stats?.opponent?.name ?? null;
  // The build-order endpoint is replay-derived and therefore authoritative
  // for both concrete races. The slim summary is an older/fallback projection
  // that can be stale or incomplete, so use it only when the build response
  // does not carry a race.
  const ghostMyRace = buildReq.data?.my_race ?? game.myRace;
  const ghostOpponentRace =
    buildReq.data?.opp_race ?? game.opponent?.race;
  const linksByGameId = vodLinksReq.data?.linksByGameId;
  const primaryStreamLinks = linksByGameId?.[game.gameId];
  const fallbackStreamLinks = linksByGameId?.[gameId];
  const streamLinks = Array.isArray(primaryStreamLinks)
    ? primaryStreamLinks
    : Array.isArray(fallbackStreamLinks)
      ? fallbackStreamLinks
      : undefined;

  return (
    <GameDetailShell
      game={game}
      opponentContext={opponentContext}
      streamLinks={streamLinks}
    >
      <InteractiveTimeline
        statsEvents={breakdown?.stats_events}
        oppStatsEvents={breakdown?.opp_stats_events}
        gameLengthSec={game.durationSec ?? breakdown?.game_length_sec ?? null}
        scrubTime={scrubTime}
        onScrub={setScrubTime}
        myName={myName}
        oppName={oppName}
      />

      {/* Vespene-style map replay — directly under the timeline.
          Renders a one-line hint for games synced before the agent
          computed playback data. */}
      <MapReplaySection gameId={game.gameId} />

      <div className="grid gap-6 md:grid-cols-2">
        <MechanicsPanel
          breakdown={breakdown}
          game={game}
          loading={macroReq.isLoading}
          onSeek={setScrubTime}
        />
        {loss && autopsyGame ? (
          <LossAutopsyCard game={autopsyGame} onSeek={setScrubTime} />
        ) : (
          <Card title="Result">
            <p className="text-caption text-text-muted">
              {game.result === "Victory" || game.result === "Win"
                ? "You won this one — the loss autopsy only runs on defeats. Scrub the timeline to see where the game swung your way."
                : "The loss autopsy only runs on defeats."}
            </p>
          </Card>
        )}
      </div>

      {/* Ghost Build loop closer — grades this game's executed build
          against the armed practice target. Renders nothing unless a
          target is armed on this device AND a my-side log exists. */}
      <GhostGradeCard
        buildLog={buildLogLines}
        myRace={ghostMyRace}
        opponentRace={ghostOpponentRace}
      />

      <BuildOrderColumns
        myEvents={buildReq.data?.events}
        oppEvents={buildReq.data?.opp_events}
        myLabel={buildReq.data?.my_build ?? game.myBuild}
        oppLabel={buildReq.data?.opp_strategy ?? game.opponent?.strategy}
        myStatus={buildReq.data?.my_status}
        oppStatus={buildReq.data?.opp_status}
        loading={buildReq.isLoading}
        myAction={
          buildLogLines && buildLogLines.length > 0 ? (
            <ArmGhostFromLogButton
              name={
                buildReq.data?.my_build
                ?? game.myBuild
                ?? (game.map ? `Build from ${game.map}` : "My build")
              }
              lines={buildLogLines}
              myRace={ghostMyRace}
              opponentRace={ghostOpponentRace}
            />
          ) : null
        }
      />
    </GameDetailShell>
  );
}

function GameNotFound({
  title,
  description,
  opponentContext,
}: {
  title: string;
  description: string;
  opponentContext?: OpponentNavigationContext | null;
}) {
  const opponentName =
    (opponentContext?.displayName || "").trim() || "opponent";
  return (
    <Card>
      <EmptyStatePanel
        size="lg"
        icon={<FileQuestion className="h-6 w-6" aria-hidden />}
        title={title}
        description={description}
        action={
          <Link
            href={opponentProfileHref(opponentContext)}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-border bg-bg-elevated px-4 text-body font-semibold text-text transition-colors hover:border-border-strong hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            {opponentContext
              ? `Back to ${opponentName}`
              : "Back to dashboard"}
          </Link>
        }
      />
    </Card>
  );
}

function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
