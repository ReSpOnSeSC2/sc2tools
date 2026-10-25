"use client";

import { useMemo } from "react";
import { useGameClock } from "./useGameClock";
import { GameClockControls } from "./GameClockControls";
import { GameClockLink } from "./GameClockLink";
import type { StatsEvent } from "@/components/analyzer/macro/MacroBreakdownPanel.types";
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
import type { AutopsyGame } from "@/lib/lossAutopsy";
import { GameNavigation } from "./GameNavigation";
import { GameDetailShell } from "./GameDetailShell";
import { GameExportMenu } from "./GameExportMenu";
import dynamic from "next/dynamic";
import { GameWorkspaceNav } from "./GameWorkspaceNav";
import { RecomputeAnalysisAction, useRecomputeAvailability } from "./RecomputeAnalysisAction";
import { useMacroRecompute } from "@/components/analyzer/macro/useMacroRecompute";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { MapReplaySection } from "./MapReplaySection";
import { MechanicsPanel } from "./MechanicsPanel";
const BuildOrderColumns = dynamic(() => import("./BuildOrderColumns").then((value) => value.BuildOrderColumns), { loading: () => <div role="status" aria-label="Loading build orders" className="h-64 animate-pulse rounded-lg bg-bg-elevated" /> });
const BuildWorkspaceActions = dynamic(() => import("./BuildWorkspaceActions").then(value => value.BuildWorkspaceActions));
const GameMacroSection = dynamic(() => import("./GameMacroSection").then((value) => value.GameMacroSection), { loading: () => <div role="status" aria-label="Loading macro breakdown" className="h-64 animate-pulse rounded-lg bg-bg-elevated" /> });
import { LossAutopsyCard } from "./LossAutopsyCard";
import { GameStoryPanel } from "./GameStoryPanel";
import type { GameStoryInput } from "@/lib/gameStory";
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
  source?: import("@/lib/gameNavigation").GameSource | null;
  gameId: string;
  opponentContext?: OpponentNavigationContext | null;
  /** Initial game-clock position from a replay example link. */
  initialTimeSec?: number | null;
  /** `?newBuild=` deep link: open "Add new build" for that side once. */
  initialNewBuild?: CheckInSide | null;
};

export function GameDetailPage(props: GameDetailPageProps) {
  // Only a different replay remounts. Timestamp navigation seeks the mounted
  // player, while ordinary data refreshes retain the user's clock.
  // The one-shot `newBuild` link stays out of the key: dropping it from the
  // URL must not remount the page (and close the editor it opened).
  const initialTimeSec = clampReplayTime(props.initialTimeSec);
  return (
    <GameDetailContent
      key={props.gameId}
      {...props}
      initialTimeSec={initialTimeSec}
    />
  );
}

function GameDetailContent({
  source,
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
  const macroReq = useMacroRecompute(gameId || null);
  const recomputeDisabledReason = useRecomputeAvailability(gameId || null);
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

  // Every timestamp seeks the mounted player; playback also drives the page.
  const clock = useGameClock(gameId, initialTimeSec, gameReq.data?.durationSec ?? macroReq.data?.game_length_sec);
  const setScrubTime = clock.seek;

  const game = gameReq.data ?? null;
  // The macro endpoint 404s with `macro_not_computed` when the agent
  // never uploaded a breakdown — that's a degrade, not an error page.
  const breakdown = macroReq.data ?? null;

  const banked = useMemo(() => {
    const rows = (samples?: StatsEvent[]) => (samples ?? []).filter((sample) => [sample.time, sample.minerals_current, sample.vespene_current].every((value) => typeof value === "number" && Number.isFinite(value))).map((sample) => [sample.time, sample.minerals_current!, sample.vespene_current!] as const);
    const me = rows(breakdown?.stats_events); const opp = rows(breakdown?.opp_stats_events);
    return me.length || opp.length ? { me, opp } : undefined;
  }, [breakdown?.stats_events, breakdown?.opp_stats_events]);
  const upgrades = useMemo(() => {
    if (!buildReq.data) return undefined;
    const rows = (events: GameBuildOrderResponse["events"] | undefined) => (events ?? []).flatMap((event) => event.category === "upgrade" && typeof event.complete_time === "number" && Number.isFinite(event.complete_time) && event.complete_time >= 0 ? [{ time: event.complete_time, name: event.display || event.name }] : []);
    return { me: rows(buildReq.data.events), opp: rows(buildReq.data.opp_events) };
  }, [buildReq.data]);

  // Raw `[m:ss] Name` lines rebuilt from the parsed build-order events —
  // lossAutopsy's late-expansion rule parses this exact shape.
  const buildLogLines = useMemo(() => {
    const events = buildReq.data?.events;
    if (!Array.isArray(events)) return null;
    return events.map((ev) => `[${ev.time_display ?? logClock(ev.time)}] ${ev.name}`);
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

  const storyInput = useMemo<GameStoryInput>(() => {
    const windows = breakdown?.raw?.supply_block_windows?.filter(window => Number.isFinite(window.start) && window.start >= 0 && Number.isFinite(window.end) && window.end >= window.start);
    const counted = windows?.reduce((sum, window) => sum + (typeof window.blocked_sec === "number" && Number.isFinite(window.blocked_sec) && window.blocked_sec >= 0 ? window.blocked_sec : window.end - window.start), 0);
    const rawBlocked = breakdown?.raw?.supply_blocked_seconds;
    return {
      gameId, result: game?.result,
      statsEvents: breakdown?.stats_events, oppStatsEvents: breakdown?.opp_stats_events,
      casualtyEvents: breakdown?.casualty_events, buildEvents: buildReq.data?.events,
      patchEra: game ? patchEraForGame(game) : null,
      supplyBlockedSeconds: counted && counted > 0 ? Math.round(counted) : typeof rawBlocked === "number" && Number.isFinite(rawBlocked) && rawBlocked >= 0 ? Math.round(rawBlocked) : null,
      supplyBlockWindows: windows,
      leaks: breakdown?.all_leaks?.length ? breakdown.all_leaks : breakdown?.top_3_leaks,
    };
  }, [gameId, game, breakdown, buildReq.data?.events]);

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
    ? macroReq.error.status === 404 && macroReq.error.code === "macro_not_computed" ? "notComputed" : "error"
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
  const recomputeAction = macroStatus === "ready" || macroStatus === "notComputed" ? <RecomputeAnalysisAction onRecompute={() => void macroReq.recompute()} busy={macroReq.recomputing} message={macroReq.recomputeMsg} disabledReason={recomputeDisabledReason} /> : undefined;
  // Once the editor opened, a refresh or a copied link mustn't reopen it.
  const dropNewBuildParam = () => {
    const { pathname, search, hash } = window.location;
    router.replace(withoutNewBuildParam(pathname, search, hash), { scroll: false });
  };

  return (
    <GameDetailShell
      source={source}
      game={game}
      exportAction={<GameExportMenu game={game} buildOrders={buildReq.data} macroBreakdown={breakdown} pending={buildStatus === "loading" || macroStatus === "loading"} />}
      opponentContext={opponentContext}
      streamLinks={streamLinks}
      buildLabel={checkinBuild ? checkinBuild.label : undefined}
      planned={checkinBuild ? checkinBuild.planned : undefined}
      oppStrategyLabel={checkinOpponent ? checkinOpponent.label : undefined}
      oppCorrected={checkinOpponent ? checkinOpponent.corrected : undefined}
    >
      <GameNavigation game={game} source={source} opponentContext={opponentContext} buildLabel={checkinBuild ? checkinBuild.label : game.myBuild} />
      <GameWorkspaceNav />
      <BuildCheckInCard
        gameId={gameId}
        onChanged={() => void gameReq.mutate()}
        initialNewBuild={initialNewBuild}
        onNewBuildOpened={initialNewBuild ? dropNewBuildParam : undefined}
      />

      <SectionBoundary key={`mechanics:${game.gameId}`} label="mechanics" title="Mechanics hit a problem"><GameStoryPanel input={storyInput} onSeek={setScrubTime} mechanics={<MechanicsPanel
          breakdown={breakdown}
          game={game}
          loading={macroStatus === "loading"}
          error={macroStatus === "error" ? macroReq.error : undefined} onRetry={() => macroReq.mutate()}
          onSeek={setScrubTime}
          recomputeAction={recomputeAction} seekTarget="replay" currentTime={clock.t}
        />} lossAutopsy={loss && autopsyGame ? (
          <LossAutopsyCard game={autopsyGame} seekTarget="replay" recomputeAction={recomputeAction} onSeek={setScrubTime} loading={macroStatus === "loading"} error={macroStatus === "error" ? macroReq.error : undefined} onRetry={() => macroReq.mutate()} />
        ) : undefined} /></SectionBoundary>

      <section ref={clock.stageRef} tabIndex={-1} id="replay" className="space-y-3 scroll-mt-[var(--game-section-offset,8rem)]" aria-labelledby="game-replay-heading">
        <h2 id="game-replay-heading" className="font-display text-h3 font-bold">Map replay <LazyHelpLink slug="game-page" anchor="replay-controls">Help</LazyHelpLink></h2>
        <GameClockControls time={clock.t} duration={game.durationSec ?? breakdown?.game_length_sec} onSeek={(time) => clock.seek(time, { reveal: false })} getHref={clock.linkAtCurrentTime} />
      {/* Vespene-style map replay — directly under the timeline.
          Renders a one-line hint for games synced before the agent
          computed playback data. */}
      <SectionBoundary key={`the replay player:${game.gameId}`} label="the replay player" title="The replay player hit a problem"><MapReplaySection
        gameId={game.gameId}
        initialTimeSec={initialTimeSec}
        seekRequest={clock.seekRequest} onPlaybackTimeChange={clock.onPlaybackTimeChange} onPlaybackStateChange={clock.onPlaybackStateChange} onStageSeek={clock.onStageSeek} banked={banked} upgrades={upgrades} clockLink={<GameClockLink time={clock.t} getHref={clock.linkAtCurrentTime} />}
        buildName={checkinBuild?.label ?? game.myBuild}
        myName={myName}
        oppName={oppName}
        myRace={ghostMyRace}
        oppRace={ghostOpponentRace}
        patchEra={patchEraForGame(game)}
      /></SectionBoundary>

      </section>
      <section id="macro" className="scroll-mt-[var(--game-section-offset,8rem)]" aria-label="Macro breakdown">
        <SectionBoundary key={`macro:${game.gameId}`} label="the macro breakdown" title="The macro breakdown hit a problem"><GameMacroSection inspectionTime={clock.t} onSeek={setScrubTime} gameId={game.gameId} data={breakdown} loading={macroStatus === "loading"} error={macroStatus === "error" ? macroReq.error : undefined} onRetry={() => macroReq.mutate()} action={recomputeAction} onRecompute={() => void macroReq.recompute()} recomputing={macroReq.recomputing} headerMeta={{ playerName: myName, opponentName: oppName, myRace: ghostMyRace, opponentRace: ghostOpponentRace, dateIso: game.date, gameVersion: game.gameVersion, gameBuild: game.gameBuild }} /></SectionBoundary>
      </section>
      <section id="builds" className="space-y-3 scroll-mt-[var(--game-section-offset,8rem)]" aria-labelledby="game-builds-heading">
        <h2 id="game-builds-heading" className="font-display text-h3 font-bold">Builds <LazyHelpLink slug="game-page" anchor="build-orders">Help</LazyHelpLink></h2>
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
        workspace={{
          myMeta: { title: checkinBuild?.label ?? buildReq.data?.my_build ?? game.myBuild ?? "My build", matchup: `${ghostMyRace || "Unknown"} vs ${ghostOpponentRace || "Unknown"}`, author: myName, sourceUrl: `/app/game/${encodeURIComponent(game.gameId)}#builds` },
          oppMeta: { title: checkinOpponent?.label ?? buildReq.data?.opp_strategy ?? game.opponent?.strategy ?? "Opponent build", matchup: `${ghostOpponentRace || "Unknown"} vs ${ghostMyRace || "Unknown"}`, author: oppName, sourceUrl: `/app/game/${encodeURIComponent(game.gameId)}#builds` },
          myStats: breakdown?.stats_events, oppStats: breakdown?.opp_stats_events,
          mySaveAction: <BuildWorkspaceActions events={buildReq.data?.events || []} name={checkinBuild?.label ?? game.myBuild ?? "My build"} race={ghostMyRace} vsRace={ghostOpponentRace} gameId={game.gameId} ghost={false} />,
          oppAction: <BuildWorkspaceActions events={buildReq.data?.opp_events || []} name={checkinOpponent?.label ?? game.opponent?.strategy ?? "Opponent build"} race={ghostOpponentRace} vsRace={ghostMyRace} gameId={game.gameId} opponent />,
        }}
        onSeek={clock.seek} currentTime={clock.t}
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
              className="min-h-11 w-full justify-start"
              gameId={game.gameId}
              name={
                checkinBuild?.label ?? buildReq.data?.my_build
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
      </section>
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

function logClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
