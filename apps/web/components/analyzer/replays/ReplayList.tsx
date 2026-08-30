"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  BarChart3,
  Eye,
  Gauge,
  LockKeyhole,
  Swords,
} from "lucide-react";
import { GameStreamLinks } from "@/components/analyzer/GameStreamLinks";
import { MacroBreakdownPanel } from "@/components/analyzer/macro/MacroBreakdownPanel";
import type { PanelHeaderMeta } from "@/components/analyzer/macro/MacroBreakdownPanel.types";
import { ReplayDownloadButton } from "@/components/analyzer/ReplayDownloadButton";
import { PublicReplayDownloadButton } from "@/components/public-profile/PublicReplayDownloadButton";
import { MapLabel } from "@/components/maps/MapArtwork";
import { Badge } from "@/components/ui/Badge";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { Icon } from "@/components/ui/Icon";
import { fmtDate, fmtMinutes, fmtMmr } from "@/lib/format";
import { coerceRace, raceIconName, raceTint } from "@/lib/race";
import type { ReplayLibraryItem } from "./types";

export interface ReplayListProps {
  items: ReplayLibraryItem[];
  owner: boolean;
  playerName: string;
  publicHandle?: string;
  emptyTitle?: string;
  emptyDescription?: string;
}

/**
 * Reusable replay presentation with an explicit access boundary: signed-in
 * owner rows use private analysis, while shared rows keep the list/download
 * public and send macro/analysis clicks through a Clerk-protected detail URL.
 */
export function ReplayList({
  items,
  owner,
  playerName,
  publicHandle,
  emptyTitle = "No replays match these filters",
  emptyDescription = "Try a wider date range or clear the replay search filters. Synced games appear here automatically.",
}: ReplayListProps) {
  const [macroGame, setMacroGame] = useState<ReplayLibraryItem | null>(null);

  if (items.length === 0) {
    return (
      <div className="px-4">
        <EmptyStatePanel
          size="lg"
          icon={<Swords className="h-6 w-6" aria-hidden />}
          title={emptyTitle}
          description={emptyDescription}
        />
      </div>
    );
  }

  const publicRoot = publicHandle
    ? `/players/${encodeURIComponent(publicHandle)}/replays`
    : null;

  return (
    <>
      <div className="overflow-hidden">
        <div className="hidden overflow-x-auto lg:block">
          <table className="w-full min-w-[1120px] text-left text-caption">
            <caption className="sr-only">Replay history for {playerName}</caption>
            <thead className="border-b-2 border-line bg-bg-elevated/70 text-micro uppercase tracking-wider text-text-muted">
              <tr>
                <th scope="col" className="w-24 px-4 py-3 font-semibold">Result</th>
                <th scope="col" className="w-40 px-3 py-3 font-semibold">Played</th>
                <th scope="col" className="min-w-52 px-3 py-3 font-semibold">Matchup</th>
                <th scope="col" className="min-w-40 px-3 py-3 font-semibold">Map</th>
                <th scope="col" className="min-w-56 px-3 py-3 font-semibold">Game plan</th>
                <th scope="col" className="w-36 px-3 py-3 font-semibold">Vitals</th>
                <th scope="col" className="w-28 px-3 py-3 font-semibold">Streams</th>
                <th scope="col" className="w-48 px-4 py-3 text-right font-semibold">Open</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {items.map((game) => (
                <DesktopReplayRow
                  key={game.gameId}
                  game={game}
                  owner={owner}
                  playerName={playerName}
                  publicRoot={publicRoot}
                  publicHandle={publicHandle}
                  onMacro={() => setMacroGame(game)}
                />
              ))}
            </tbody>
          </table>
        </div>

        <ul className="divide-y divide-border lg:hidden" role="list">
          {items.map((game) => (
            <MobileReplayCard
              key={game.gameId}
              game={game}
              owner={owner}
              playerName={playerName}
              publicRoot={publicRoot}
              publicHandle={publicHandle}
              onMacro={() => setMacroGame(game)}
            />
          ))}
        </ul>
      </div>

      {owner && macroGame ? (
        <MacroBreakdownPanel
          open
          onClose={() => setMacroGame(null)}
          gameId={macroGame.gameId}
          initialScore={macroGame.macroScore}
          headerMeta={headerMeta(macroGame, playerName)}
        />
      ) : null}
    </>
  );
}

interface RowProps {
  game: ReplayLibraryItem;
  owner: boolean;
  playerName: string;
  publicRoot: string | null;
  publicHandle?: string;
  onMacro: () => void;
}

function DesktopReplayRow({ game, owner, playerName, publicRoot, publicHandle, onMacro }: RowProps) {
  const analysisHref = owner
    ? `/app/game/${encodeURIComponent(game.gameId)}`
    : `${publicRoot}/${encodeURIComponent(game.gameId)}`;
  return (
    <tr className="group bg-bg-surface transition-colors hover:bg-bg-elevated/55">
      <td className={["border-l-4 px-4 py-3", resultRail(game.result)].join(" ")}>
        <ResultBadge result={game.result} />
      </td>
      <td className="px-3 py-3 align-middle text-text-muted"><ReplayDate value={game.date} /></td>
      <td className="px-3 py-3 align-middle"><Matchup game={game} playerName={playerName} /></td>
      <td className="px-3 py-3 align-middle">
        {game.map ? (
          <MapLabel name={game.map} size="xs" preview className="max-w-48" />
        ) : (
          <span className="text-text-dim">Unknown map</span>
        )}
      </td>
      <td className="px-3 py-3 align-middle"><GamePlan game={game} owner={owner} /></td>
      <td className="px-3 py-3 align-middle"><Vitals game={game} /></td>
      <td className="px-3 py-3 align-middle">
        {game.streams?.length ? (
          <GameStreamLinks links={game.streams} compact sharedPlayerName={owner ? undefined : playerName} />
        ) : (
          <span className="text-text-dim" aria-label="No matching stream recording">—</span>
        )}
      </td>
      <td className="px-4 py-3 align-middle">
        <div className="flex items-center justify-end gap-1.5">
          {owner ? (
            <button
              type="button"
              onClick={onMacro}
              className={actionClass}
              aria-label={`Open macro breakdown for ${opponentLabel(game)}`}
            >
              <Gauge className="h-4 w-4" aria-hidden /> Macro
            </button>
          ) : (
            <Link href={`${analysisHref}#macro-breakdown`} className={actionClass} aria-label={`Sign in to open macro breakdown for ${replayContext(game)}`}>
              <Gauge className="h-4 w-4" aria-hidden /> Macro
              <LockKeyhole className="h-3 w-3 text-text-dim" aria-hidden />
            </Link>
          )}
          <Link href={analysisHref} className={actionClass} aria-label={`${owner ? "Open" : "Sign in to open"} replay analysis for ${replayContext(game)}`}>
            <BarChart3 className="h-4 w-4" aria-hidden /> Analysis
            {!owner ? <LockKeyhole className="h-3 w-3 text-text-dim" aria-hidden /> : null}
          </Link>
          {owner ? (
            <ReplayDownloadButton
              gameId={game.gameId}
              available={game.replayAvailable}
              filename={game.replayFilename}
              sizeBytes={game.replaySizeBytes}
              contextLabel={replayContext(game)}
            />
          ) : publicHandle ? (
            <PublicReplayDownloadButton
              handle={publicHandle}
              gameId={game.gameId}
              available={game.replayAvailable}
              sizeBytes={game.replaySizeBytes}
              contextLabel={replayContext(game)}
            />
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function MobileReplayCard({ game, owner, playerName, publicRoot, publicHandle, onMacro }: RowProps) {
  const analysisHref = owner
    ? `/app/game/${encodeURIComponent(game.gameId)}`
    : `${publicRoot}/${encodeURIComponent(game.gameId)}`;
  return (
    <li className={["relative border-l-4 px-4 py-4", resultRail(game.result)].join(" ")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <ResultBadge result={game.result} />
            <ReplayDate value={game.date} />
            <span className="font-mono text-micro tabular-nums text-text-dim">
              {game.durationSec ? fmtMinutes(game.durationSec) : "—"}
            </span>
          </div>
          <Matchup game={game} playerName={playerName} />
        </div>
        <Link
          href={analysisHref}
          aria-label={`${owner ? "Open" : "Sign in to open"} replay analysis for ${replayContext(game)}`}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full border-2 border-line bg-bg-elevated text-text transition-colors hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <ArrowUpRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 rounded-lg border border-border bg-bg-elevated/35 p-3 sm:grid-cols-2">
        <div className="space-y-2">
          {game.map ? <MapLabel name={game.map} size="xs" preview /> : null}
          <GamePlan game={game} owner={owner} />
        </div>
        <Vitals game={game} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {game.streams?.length ? <GameStreamLinks links={game.streams} sharedPlayerName={owner ? undefined : playerName} /> : null}
        <span className="min-w-2 flex-1" />
        {owner ? (
          <button type="button" onClick={onMacro} className={mobileActionClass} aria-label={`Open macro breakdown for ${replayContext(game)}`}>
            <Gauge className="h-4 w-4" aria-hidden /> Macro breakdown
          </button>
        ) : (
          <Link href={`${analysisHref}#macro-breakdown`} className={mobileActionClass} aria-label={`Sign in to open macro breakdown for ${replayContext(game)}`}>
            <Gauge className="h-4 w-4" aria-hidden /> Macro
            <LockKeyhole className="h-3 w-3 text-text-dim" aria-hidden />
          </Link>
        )}
        <Link href={analysisHref} className={mobileActionClass} aria-label={`${owner ? "Open" : "Sign in to open"} replay analysis for ${replayContext(game)}`}>
          <Eye className="h-4 w-4" aria-hidden /> Analysis
          {!owner ? <LockKeyhole className="h-3 w-3 text-text-dim" aria-hidden /> : null}
        </Link>
        {owner ? (
          <div className="w-full sm:w-auto">
            <ReplayDownloadButton
              gameId={game.gameId}
              available={game.replayAvailable}
              filename={game.replayFilename}
              sizeBytes={game.replaySizeBytes}
              mobile
              contextLabel={replayContext(game)}
            />
          </div>
        ) : publicHandle ? (
          <div className="w-full sm:w-auto">
            <PublicReplayDownloadButton
              handle={publicHandle}
              gameId={game.gameId}
              available={game.replayAvailable}
              sizeBytes={game.replaySizeBytes}
              mobile
              contextLabel={replayContext(game)}
            />
          </div>
        ) : null}
      </div>
    </li>
  );
}

function Matchup({ game, playerName }: { game: ReplayLibraryItem; playerName: string }) {
  const format = replayFormatLabel(game);
  const opponent = opponentLabel(game);
  return (
    <div className="min-w-0 space-y-1">
      <PlayerLine name={playerName} race={game.myRace} muted />
      <PlayerLine
        name={format ? `Primary opponent: ${opponent}` : opponent}
        race={game.opponent?.race}
      />
      {format ? (
        <span className="inline-flex rounded-full border border-border bg-bg-elevated px-2 py-0.5 text-micro font-semibold text-text-muted">
          {format}
        </span>
      ) : null}
    </div>
  );
}

function PlayerLine({ name, race, muted = false }: { name: string; race?: string | null; muted?: boolean }) {
  const normalized = race ? coerceRace(race) : null;
  const tint = normalized ? raceTint(normalized) : null;
  return (
    <div
      className="flex min-w-0 items-center gap-2"
      aria-label={`${name}, ${normalized || "unknown race"}`}
    >
      {normalized ? (
        <span className={["grid h-6 w-6 shrink-0 place-items-center rounded-md border", tint?.bg, tint?.border].filter(Boolean).join(" ")}>
          <Icon name={raceIconName(normalized)} kind="race" size={14} decorative />
        </span>
      ) : (
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-border text-[10px] text-text-dim">?</span>
      )}
      <span className={["truncate", muted ? "text-text-muted" : "font-semibold text-text"].join(" ")} title={name}>
        {name}
      </span>
    </div>
  );
}

function GamePlan({ game, owner }: { game: ReplayLibraryItem; owner: boolean }) {
  return (
    <dl className="min-w-0 space-y-1">
      <div className="flex min-w-0 gap-2">
        <dt className="w-12 shrink-0 text-micro uppercase tracking-wide text-text-dim">{owner ? "You" : "Player"}</dt>
        <dd className="truncate text-text" title={game.myBuild || undefined}>{game.myBuild || "Unclassified"}</dd>
      </div>
      <div className="flex min-w-0 gap-2">
        <dt className="w-12 shrink-0 text-micro uppercase tracking-wide text-text-dim">Opp</dt>
        <dd className="truncate text-text-muted" title={game.opponent?.strategy || undefined}>
          {game.opponent?.strategy || "Unknown strategy"}
        </dd>
      </div>
    </dl>
  );
}

function Vitals({ game }: { game: ReplayLibraryItem }) {
  return (
    <dl className="grid grid-cols-3 gap-2 lg:grid-cols-1">
      <Vital label="Length" value={game.durationSec ? fmtMinutes(game.durationSec) : "—"} />
      <Vital label="MMR" value={game.myMmr != null ? fmtMmr(game.myMmr) : "—"} />
      <Vital
        label="Macro"
        value={game.macroScore != null ? `${Math.round(game.macroScore)}` : "—"}
        tone={macroTone(game.macroScore)}
      />
    </dl>
  );
}

function Vital({ label, value, tone = "text-text" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col lg:flex-row lg:items-baseline lg:justify-between lg:gap-2">
      <dt className="text-[10px] uppercase tracking-wide text-text-dim">{label}</dt>
      <dd className={`font-mono text-caption font-semibold tabular-nums ${tone}`}>{value}</dd>
    </div>
  );
}

function ReplayDate({ value }: { value?: string | null }) {
  if (!value) return <span className="text-text-dim">Date unavailable</span>;
  return (
    <time suppressHydrationWarning dateTime={value} title={fullDate(value)} className="whitespace-nowrap text-text-muted">
      {fmtDate(value)}
    </time>
  );
}

type DisplayResult = "Win" | "Loss" | "Draw" | "Unknown";

function ResultBadge({ result }: { result?: string | null }) {
  const normalized = normalizeResult(result);
  return (
    <Badge variant={normalized === "Win" ? "success" : normalized === "Loss" ? "danger" : "neutral"} size="sm">
      {normalized}
    </Badge>
  );
}

function normalizeResult(result?: string | null): DisplayResult {
  const normalized = result?.trim().toLowerCase();
  if (normalized === "win" || normalized === "victory") return "Win";
  if (normalized === "loss" || normalized === "defeat") return "Loss";
  if (normalized === "draw" || normalized === "tie") return "Draw";
  return "Unknown";
}

function resultRail(result?: string | null): string {
  const normalized = normalizeResult(result);
  return normalized === "Win" ? "border-l-success" : normalized === "Loss" ? "border-l-danger" : "border-l-text-dim";
}

function macroTone(score?: number | null): string {
  if (score == null) return "text-text-dim";
  if (score >= 80) return "text-success";
  if (score >= 60) return "text-warning";
  return "text-danger";
}

function opponentLabel(game: ReplayLibraryItem): string {
  return game.opponent?.displayName?.trim() || "Unknown opponent";
}

function replayFormatLabel(game: ReplayLibraryItem): string | null {
  const players = game.playerCount ? ` · ${game.playerCount} players` : "";
  if (game.matchFormat === "team") return `Team game${players}`;
  if (game.matchFormat === "ffa") return `Free-for-all${players}`;
  if (game.matchFormat === "other") return `Custom format${players}`;
  return null;
}

function replayContext(game: ReplayLibraryItem): string {
  const opponent = opponentLabel(game);
  return game.map ? `${opponent} on ${game.map}` : opponent;
}

function fullDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function headerMeta(game: ReplayLibraryItem, playerName: string): PanelHeaderMeta {
  return {
    playerName,
    myRace: game.myRace,
    opponentName: game.opponent?.displayName,
    opponentRace: game.opponent?.race,
    map: game.map,
    result: game.result,
    dateIso: game.date,
  };
}

const actionClass = "inline-flex min-h-8 items-center gap-1.5 rounded-md border border-border bg-bg-elevated/60 px-2.5 text-micro font-semibold text-text-muted transition-colors hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const mobileActionClass = "inline-flex min-h-[44px] items-center gap-2 rounded-lg border-2 border-line bg-bg-surface px-3 text-caption font-semibold text-text transition-colors hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
