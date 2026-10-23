"use client";

import { useChromeBreadcrumb } from "@/components/chrome/ChromeContext";
import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { OpponentLink } from "@/components/analyzer/OpponentLink";
import { MapArtwork } from "@/components/maps/MapArtwork";
import {
  GameStreamLinks,
  type GameStreamLink,
} from "@/components/analyzer/GameStreamLinks";
import { ReplayDownloadButton } from "@/components/analyzer/ReplayDownloadButton";
import { fmtGameDate, fmtMinutes, fmtMmr } from "@/lib/format";
import { ShareGameButton } from "./ShareGameButton";
import { AskForReviewButton } from "@/components/reviews/AskForReviewButton";
import { isReviewableGame } from "@/lib/reviews";
import { CorrectedBadge, PlannedBadge } from "@/components/build-checkin/PlannedBadge";
import { isLossResult, isWinResult, type GameSummary } from "./types";
import { matchupLabel } from "./gameTitle";
import {
  opponentProfileHref,
  type OpponentNavigationContext,
} from "@/lib/opponentNavigation";

/**
 * GameDetailShell — header + responsive layout for the per-game
 * deep-dive page. The header answers "which game is this?" at a
 * glance: result, matchup, map, date, duration, MMRs, and the two
 * strategy labels (my build vs the opponent's classified strategy),
 * plus a back link to the source opponent dossier (or dashboard fallback).
 * When a confirmed build check-in overrides the classifier, "My build"
 * shows the planned build with a "Planned" marker naming the replay's own
 * label; a corrected opponent build gets a "Corrected" marker the same way.
 *
 * Layout: children stack vertically; the page decides what goes in.
 */
export function GameDetailShell({
  game,
  children,
  opponentContext,
  streamLinks,
  buildLabel,
  planned,
  oppStrategyLabel,
  oppCorrected,
}: {
  game: GameSummary;
  children: ReactNode;
  opponentContext?: OpponentNavigationContext | null;
  streamLinks?: GameStreamLink[] | null;
  /** Effective build label from the live check-in state; the slim row's otherwise. */
  buildLabel?: string | null;
  /** Check-in override marker; undefined falls back to the slim row's flag. */
  planned?: { detected: string | null } | null;
  /** Effective opponent strategy from the check-in state; the slim row's otherwise. */
  oppStrategyLabel?: string | null;
  /** Opponent-build correction marker; undefined falls back to the slim row's flag. */
  oppCorrected?: { detected: string | null } | null;
}) {
  const matchup = matchupLabel(game.myRace, game.opponent?.race);
  const namedOpponent = (game.opponent?.displayName || "").trim();
  const oppName = namedOpponent || "Opponent";
  const title = matchup && namedOpponent
    ? `${matchup} vs ${namedOpponent}${game.map ? ` on ${game.map}` : ""}`
    : `${matchup ? `${matchup} ` : ""}${game.map ? `on ${game.map}` : "Game details"}`;
  const backName =
    (opponentContext?.displayName || "").trim() ||
    (game.opponent?.displayName || "").trim() ||
    "opponent";
  const backHref = opponentProfileHref(opponentContext);
  const backLabel = opponentContext
    ? `Back to ${backName}`
    : "Back to Today";
  const inChrome = useChromeBreadcrumb({ backHref, backLabel, trail: opponentContext ? [{ label: "Opponents", href: "/app/opponents" }, { label: backName, href: backHref }, { label: `${matchup || "Replay"} on ${game.map || "Unknown map"}` }] : [{ label: "Today", href: "/app" }, { label: `${matchup || "Replay"} on ${game.map || "Unknown map"}` }] });
  const replayAvailable =
    game.replayAvailable === true || Boolean(game.replayFile?.storedAt);
  const replaySizeBytes =
    game.replaySizeBytes ?? game.replayFile?.sizeBytes ?? null;
  const myBuild = buildLabel !== undefined ? buildLabel : game.myBuild;
  const plannedMarker =
    planned !== undefined
      ? planned
      : game.buildPlanned
        ? { detected: game.detectedBuild ?? null }
        : null;
  const oppStrategy =
    oppStrategyLabel !== undefined ? oppStrategyLabel : game.opponent?.strategy;
  const correctedMarker =
    oppCorrected !== undefined
      ? oppCorrected
      : game.oppStrategyPlanned
        ? { detected: game.detectedOppStrategy ?? null }
        : null;
  return (
    <div className="space-y-6" data-game-workspace>
      <header id="overview" className="space-y-3 scroll-mt-[var(--game-section-offset,8rem)]">
        <Link
          href={backHref}
          className={`${inChrome ? "md:hidden " : ""}inline-flex min-h-[44px] items-center gap-1.5 rounded text-caption font-medium text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {backLabel}
        </Link>

        <Card variant="feature" padded={false} className="group/map relative">
          <MapArtwork
            mapName={game.map}
            size="hero"
            eager
            className="pointer-events-none absolute inset-0 border-0 opacity-45"
          />
          <span
            aria-hidden
            className="absolute inset-0 bg-gradient-to-r from-bg-surface via-bg-surface/90 to-bg-surface/55"
          />
          <span
            aria-hidden
            className="absolute inset-0 bg-gradient-to-t from-bg-surface/80 via-transparent to-bg-surface/20"
          />

          <div className="relative space-y-3 p-4 sm:p-5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <ResultBadge result={game.result} />
              <h1 className="min-w-0 break-words font-display text-h2 font-bold text-text">{title}</h1>
            </div>

            <dl className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-caption text-text-muted">
              <MetaItem label="Played"><time dateTime={game.date || undefined} title={game.date && Number.isFinite(Date.parse(game.date)) ? new Date(game.date).toLocaleString() : undefined}>{fmtGameDate(game.date)}</time></MetaItem>
              {game.durationSec ? <MetaItem label="Length">{fmtMinutes(game.durationSec)}</MetaItem> : null}
              {game.myMmr != null || game.opponent?.mmr != null ? <MetaItem label="MMR">
                <span className="tabular-nums">
                  {fmtMmr(game.myMmr)}{" "}
                  <span className="text-text-dim">vs</span>{" "}
                  {fmtMmr(game.opponent?.mmr)}
                </span>
              </MetaItem> : null}
              {namedOpponent || game.opponent?.race ? <MetaItem label="Opponent">
                <OpponentLink pulseId={game.opponent?.pulseId} name={oppName} race={game.opponent?.race} />
              </MetaItem> : null}
            </dl>

            <div
              role="toolbar"
              aria-label="Game actions"
              className="flex min-h-9 w-full flex-wrap items-center justify-end gap-2"
            >
              <ShareGameButton game={game} />
              <ReplayDownloadButton
                gameId={game.gameId}
                available={replayAvailable}
                filename={game.replayFilename}
                sizeBytes={replaySizeBytes}
                showLabel
                size="sm"
                variant="secondary"
              />
              {isReviewableGame(game) ? (
                <AskForReviewButton
                  gameId={game.gameId}
                  durationSec={game.durationSec}
                  matchup={matchup}
                />
              ) : null}
              {streamLinks && streamLinks.length > 0 ? <GameStreamLinks links={streamLinks} variant="toolbar" /> : null}
            </div>

            <div className="flex flex-wrap items-center gap-2 text-caption">
              <span className="text-text-dim">My build</span>
              <Badge size="sm" variant="accent">
                {myBuild || "Unclassified"}
              </Badge>
              {plannedMarker ? (
                <PlannedBadge detected={plannedMarker.detected} />
              ) : null}
              <span className="text-text-dim">·</span>
              <span className="text-text-dim">Opponent strategy</span>
              <Badge size="sm" variant="neutral">
                {oppStrategy || "Unknown"}
              </Badge>
              {correctedMarker ? (
                <CorrectedBadge detected={correctedMarker.detected} />
              ) : null}
            </div>
          </div>
        </Card>
      </header>

      <div className="space-y-6">{children}</div>
    </div>
  );
}

function MetaItem({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <dt className="text-micro uppercase tracking-wider text-text-dim">
        {label}
      </dt>
      <dd className="text-text">{children}</dd>
    </div>
  );
}

function ResultBadge({ result }: { result?: string | null }) {
  if (!result) return null;
  const variant = isWinResult(result)
    ? "success"
    : isLossResult(result)
      ? "danger"
      : "neutral";
  return <Badge variant={variant}>{result}</Badge>;
}
