"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/Icon";
import { MapArtwork } from "@/components/maps/MapArtwork";
import {
  GameStreamLinks,
  type GameStreamLink,
} from "@/components/analyzer/GameStreamLinks";
import { fmtDate, fmtMinutes, fmtMmr, raceColour } from "@/lib/format";
import { ShareGameButton } from "./ShareGameButton";
import { isLossResult, isWinResult, type GameSummary } from "./types";
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
 *
 * Layout: children stack vertically; the page decides what goes in.
 */
export function GameDetailShell({
  game,
  children,
  opponentContext,
  streamLinks,
}: {
  game: GameSummary;
  children: ReactNode;
  opponentContext?: OpponentNavigationContext | null;
  streamLinks?: GameStreamLink[] | null;
}) {
  const matchup = matchupLabel(game.myRace, game.opponent?.race);
  const oppName = (game.opponent?.displayName || "").trim() || "Opponent";
  const backName =
    (opponentContext?.displayName || "").trim() ||
    (game.opponent?.displayName || "").trim() ||
    "opponent";
  const backHref = opponentProfileHref(opponentContext);
  const backLabel = opponentContext
    ? `Back to ${backName}`
    : "Back to dashboard";
  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <Link
          href={backHref}
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded text-caption font-medium text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {backLabel}
        </Link>

        <div className="group/map relative overflow-hidden rounded-xl border border-border bg-bg-elevated shadow-lg">
          <MapArtwork
            mapName={game.map}
            size="hero"
            eager
            className="pointer-events-none absolute inset-0 border-0 opacity-45"
          />
          <span
            aria-hidden
            className="absolute inset-0 bg-gradient-to-r from-bg-elevated via-bg-elevated/90 to-bg-elevated/55"
          />
          <span
            aria-hidden
            className="absolute inset-0 bg-gradient-to-t from-bg-elevated/80 via-transparent to-bg-elevated/20"
          />

          <div className="relative space-y-3 p-4 sm:p-5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <ResultBadge result={game.result} />
              <h1 className="font-display text-h2 font-bold text-text">
                {matchup ? `${matchup} ` : ""}
                {game.map ? (
                  <>
                    on <span className="text-accent-cyan">{game.map}</span>
                  </>
                ) : (
                  "Game details"
                )}
              </h1>
              <ShareGameButton game={game} className="ml-auto" />
            </div>

            <dl className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-caption text-text-muted">
              <MetaItem label="Played">{fmtDate(game.date)}</MetaItem>
              <MetaItem label="Length">
                {game.durationSec ? fmtMinutes(game.durationSec) : "—"}
              </MetaItem>
              <MetaItem label="MMR">
                <span className="tabular-nums">
                  {fmtMmr(game.myMmr)}{" "}
                  <span className="text-text-dim">vs</span>{" "}
                  {fmtMmr(game.opponent?.mmr)}
                </span>
              </MetaItem>
              <MetaItem label="Opponent">
                <span className="inline-flex items-center gap-1">
                  {game.opponent?.race ? (
                    <RaceChip race={game.opponent.race} />
                  ) : null}
                  <span className="max-w-[18ch] truncate" title={oppName}>
                    {oppName}
                  </span>
                </span>
              </MetaItem>
            </dl>

            {streamLinks && streamLinks.length > 0 ? (
              <GameStreamLinks links={streamLinks} />
            ) : null}

            <div className="flex flex-wrap items-center gap-2 text-caption">
              <span className="text-text-dim">My build</span>
              <Badge size="sm" variant="accent">
                {game.myBuild || "Unclassified"}
              </Badge>
              <span className="text-text-dim">·</span>
              <span className="text-text-dim">Opponent strategy</span>
              <Badge size="sm" variant="neutral">
                {game.opponent?.strategy || "Unknown"}
              </Badge>
            </div>
          </div>
        </div>
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

function RaceChip({ race }: { race: string }) {
  const full = canonicalRaceName(race);
  const colour = raceColour(race);
  return (
    <span className="inline-flex items-center" style={{ color: colour }}>
      {full ? (
        <Icon name={full} kind="race" size={14} fallback="" decorative />
      ) : null}
    </span>
  );
}

function canonicalRaceName(input?: string | null): string | null {
  const head = (input || "").trim().charAt(0).toUpperCase();
  switch (head) {
    case "T":
      return "Terran";
    case "P":
      return "Protoss";
    case "Z":
      return "Zerg";
    case "R":
      return "Random";
    default:
      return null;
  }
}

/** "PvZ"-style matchup label from race names/codes; null when unknown. */
function matchupLabel(
  myRace?: string | null,
  oppRace?: string | null,
): string | null {
  const mine = (myRace || "").trim().charAt(0).toUpperCase();
  const theirs = (oppRace || "").trim().charAt(0).toUpperCase();
  if (!/[TPZR]/.test(mine) || !/[TPZR]/.test(theirs)) return null;
  return `${mine}v${theirs}`;
}
