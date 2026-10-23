"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, FileQuestion } from "lucide-react";
import { useApi } from "@/lib/clientApi";
import { Card } from "@/components/ui/Card";
import { RequestError } from "@/components/ui/RequestError";
import { SectionBoundary } from "@/components/ui/SectionBoundary";
import { GameDetailSkeleton } from "./GameDetailSkeleton";
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
import { clampReplayTime } from "@/lib/replayLink";
import { patchEraForGame } from "@/lib/ladderPulse";
import {
  effectiveBuild,
  effectiveOpponentBuild,
  useGameBuildIntent,
  type CheckInSide,
} from "@/lib/buildIntent";
import { withoutNewBuildParam } from "@/lib/buildIntentLinks";
import { BuildCheckInCard } from "@/components/build-checkin/BuildCheckInCard";
import { useBuildCheckInRevision } from "@/components/build-checkin/BuildCheckInProvider";

/**
 * GameDetailPage — the per-replay deep dive ("I just lost a weird
 * game, show me THAT game"). Client-fetches four endpoints the same
 * way sibling analyzer surfaces do (useApi/SWR + Clerk JWT):
 *
 *   - GET /v1/games/:id                  → slim metadata row (header)
 *   - GET /v1/games/:id/macro-breakdown  → stats_events, leaks, raw
 *   - GET /v1/games/:id/build-order      → parsed build logs, both sides
 *   - GET /v1/games/vod-links?gameId=:id → timestamped POV VOD links
 *   - GET /v1/games/:id/build-intent     → build check-in (card + header label)
 *
 * Every payload degrades independently: a 404 on the game row is a
 * branded empty state; a missing macro breakdown (pre-v0.5 agents)
 * still renders the header + build orders; missing stats_events
 * (pre-v0.5.11) keeps the mechanics/build panels and swaps the
 * timeline for an explanatory empty state. Never a blank page.
 */
type GameDetailPageProps = {
  gameId: string;
  opponentContext?: OpponentNavigationContext | null;
  /** Initial game-clock position from a replay example link. */
  initialTimeSec?: number | null;
  /** `?newBuild=` deep link: open "Add new build" for that side once. */
  initialNewBuild?: CheckInSide | null;
};

export function GameDetailPage(props: GameDetailPageProps) {
  // A new replay or timestamp is a new navigation. Ordinary data refreshes
  // retain the user's cursor, while client-side links reset it immediately.
  // The one-shot `newBuild` link stays out of the key: dropping it from the
  // URL must not remount the page (and close the editor it opened).
  const initialTimeSec = clampReplayTime(props.initialTimeSec);
  return (
    <GameDetailContent
      key={JSON.stringify([props.gameId, initialTimeSec])}
      {...props}
      initialTimeSec={initialTimeSec}
    />
  );
}

function GameDetailContent({
  gameId,
  opponentContext,
  initialTimeSec,
  initialNewBuild = null,
}: GameDetailPageProps) {
  const router = useRouter();
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
  // Same request as the check-in card (SWR shares it): a confirmed check-in
  // changes the header's build label without refetching the build order.
  const { revision: checkinRevision } = useBuildCheckInRevision(false);
  const intentReq = useGameBuildIntent(gameId || null, checkinRevision);

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

  if (gameReq.error && !game) {
    return <div className="space-y-4"><RequestError title="Couldn't load this game" error={gameReq.error} onRetry={() => gameReq.mutate()} />
      <Link href={opponentProfileHref(opponentContext)}>Back to dashboard</Link></div>;
  }
  if (!game) return <GameDetailSkeleton />;

  const macroStatus = macroReq.data ? "ready" : macroReq.error
    ? macroReq.error.status === 404 || macroReq.error.code === "macro_not_computed" ? "notComputed" : "error"
    : "loading";
  const buildStatus = buildReq.data ? "ready" : buildReq.error
    ? buildReq.error.status === 404 || buildReq.error.code === "build_not_computed" ? "notComputed" : "error"
    : "loading";

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
  const checkinBuild = intentReq.data
    ? effectiveBuild(intentReq.data, game.myBuild)
    : null;
  // Older APIs omit the opponent axis; the slim row's flags cover them.
  const checkinOpponent =
    intentReq.data && intentReq.data.opponent !== undefined
      ? effectiveOpponentBuild(intentReq.data.opponent, game.opponent?.strategy)
      : null;
  // Once the editor opened, a refresh or a copied link mustn't reopen it.
  const dropNewBuildParam = () => {
    const { pathname, search, hash } = window.location;
    router.replace(withoutNewBuildParam(pathname, search, hash), { scroll: false });
  };

  return (
    <GameDetailShell
      game={game}
      opponentContext={opponentContext}
      streamLinks={streamLinks}
      buildLabel={checkinBuild ? checkinBuild.label : undefined}
      planned={checkinBuild ? checkinBuild.planned : undefined}
      oppStrategyLabel={checkinOpponent ? checkinOpponent.label : undefined}
      oppCorrected={checkinOpponent ? checkinOpponent.corrected : undefined}
    >
      <BuildCheckInCard
        gameId={gameId}
        onChanged={() => void gameReq.mutate()}
        initialNewBuild={initialNewBuild}
        onNewBuildOpened={initialNewBuild ? dropNewBuildParam : undefined}
      />

      <SectionBoundary key={`the timeline:${game.gameId}`} label="the timeline" title="The timeline hit a problem"><InteractiveTimeline
        loading={macroStatus === "loading"} error={macroStatus === "error" ? macroReq.error : undefined} onRetry={() => macroReq.mutate()}
        statsEvents={breakdown?.stats_events}
        oppStatsEvents={breakdown?.opp_stats_events}
        gameLengthSec={game.durationSec ?? breakdown?.game_length_sec ?? null}
        scrubTime={scrubTime ?? clampReplayTime(initialTimeSec, game.durationSec ?? breakdown?.game_length_sec)}
        onScrub={setScrubTime}
        myName={myName}
        oppName={oppName}
      /></SectionBoundary>

      {/* Vespene-style map replay — directly under the timeline.
          Renders a one-line hint for games synced before the agent
          computed playback data. */}
      <SectionBoundary key={`the replay player:${game.gameId}`} label="the replay player" title="The replay player hit a problem"><MapReplaySection
        gameId={game.gameId}
        initialTimeSec={initialTimeSec}
        myName={myName}
        oppName={oppName}
        myRace={ghostMyRace}
        oppRace={ghostOpponentRace}
        patchEra={patchEraForGame(game)}
      /></SectionBoundary>

      <SectionBoundary key={`mechanics:${game.gameId}`} label="mechanics" title="Mechanics hit a problem"><div className="grid gap-6 md:grid-cols-2">
        <MechanicsPanel
          breakdown={breakdown}
          game={game}
          loading={macroStatus === "loading"}
          error={macroStatus === "error" ? macroReq.error : undefined} onRetry={() => macroReq.mutate()}
          onSeek={setScrubTime}
        />
        {loss && autopsyGame ? (
          <LossAutopsyCard game={autopsyGame} onSeek={setScrubTime} loading={macroStatus === "loading"} error={macroStatus === "error" ? macroReq.error : undefined} onRetry={() => macroReq.mutate()} />
        ) : (
          <Card title="Result">
            <p className="text-caption text-text-muted">
              {game.result === "Victory" || game.result === "Win"
                ? "You won this one — the loss autopsy only runs on defeats. Scrub the timeline to see where the game swung your way."
                : "The loss autopsy only runs on defeats."}
            </p>
          </Card>
        )}
      </div></SectionBoundary>

      {/* Ghost Build loop closer — grades this game's executed build
          against the armed practice target. Renders nothing unless a
          target is armed on this device AND a my-side log exists. */}
      <SectionBoundary key={`the Ghost Build grade:${game.gameId}`} label="the Ghost Build grade" title="The Ghost Build grade hit a problem"><GhostGradeCard
        gameId={game.gameId}
        buildLog={buildLogLines}
        myRace={ghostMyRace}
        opponentRace={ghostOpponentRace}
      /></SectionBoundary>

      <SectionBoundary key={`build orders:${game.gameId}`} label="build orders" title="Build orders hit a problem"><BuildOrderColumns
        error={buildStatus === "error" ? buildReq.error : undefined} onRetry={() => buildReq.mutate()}
        myEvents={buildReq.data?.events}
        oppEvents={buildReq.data?.opp_events}
        myLabel={checkinBuild?.label ?? buildReq.data?.my_build ?? game.myBuild}
        oppLabel={
          checkinOpponent?.label ?? buildReq.data?.opp_strategy ?? game.opponent?.strategy
        }
        myStatus={buildStatus === "notComputed" ? "not_extracted" : buildReq.data?.my_status}
        oppStatus={buildStatus === "notComputed" ? "not_extracted" : buildReq.data?.opp_status}
        loading={buildStatus === "loading"}
        myAction={
          buildLogLines && buildLogLines.length > 0 ? (
            <ArmGhostFromLogButton
              gameId={game.gameId}
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
      /></SectionBoundary>
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
