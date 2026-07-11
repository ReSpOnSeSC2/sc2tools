"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/Icon";
import { fmtDate, fmtMinutes, fmtMmr, raceColour } from "@/lib/format";
import { isLossResult, isWinResult, type GameSummary } from "./types";

/**
 * GameDetailShell — header + responsive layout for the per-game
 * deep-dive page. The header answers "which game is this?" at a
 * glance: result, matchup, map, date, duration, MMRs, and the two
 * strategy labels (my build vs the opponent's classified strategy),
 * plus a back link to the analyzer dashboard.
 *
 * Layout: children stack vertically; the page decides what goes in.
 */
export function GameDetailShell({
  game,
  children,
}: {
  game: GameSummary;
  children: ReactNode;
}) {
  const matchup = matchupLabel(game.myRace, game.opponent?.race);
  const oppName = (game.opponent?.displayName || "").trim() || "Opponent";
  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <Link
          href="/app"
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded text-caption font-medium text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to dashboard
        </Link>

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
