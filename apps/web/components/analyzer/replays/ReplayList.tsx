"use client";

import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import {
  ArrowUpRight,
  BarChart3,
  Eye,
  Gauge,
  LockKeyhole,
  Swords,
} from "lucide-react";
import { GameStreamLinks } from "@/components/analyzer/GameStreamLinks";
import { ReplayDownloadButton } from "@/components/analyzer/ReplayDownloadButton";
import { PublicReplayDownloadButton } from "@/components/public-profile/PublicReplayDownloadButton";
import { sharedAnalysisHref } from "@/components/public-profile/archiveQuery";
import { MapLabel } from "@/components/maps/MapArtwork";
import { Badge } from "@/components/ui/Badge";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { AskForReviewButton } from "@/components/reviews/AskForReviewButton";
import { PlannedBadge } from "@/components/build-checkin/PlannedBadge";
import { Icon } from "@/components/ui/Icon";
import { fmtDate, fmtDateCompact, fmtMinutes, fmtMmr, macroScoreTone } from "@/lib/format";
import { coerceRace, raceIconName, raceTint } from "@/lib/race";
import { isReviewableGame } from "@/lib/reviews";
import type { ReplayLibraryItem } from "./types";

export interface ReplayListProps {
  items: ReplayLibraryItem[];
  owner: boolean;
  playerName: string;
  publicHandle?: string;
  listQuery?: string;
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
  listQuery,
  emptyTitle = "No replays match these filters",
  emptyDescription = "Try a wider date range or clear the replay search filters. Synced games appear here automatically.",
}: ReplayListProps) {
  const { isLoaded, isSignedIn } = useAuth();
  const publicLocked = isLoaded && !isSignedIn;

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
        <div className="hidden overflow-x-auto xl:block">
          <table className="w-full min-w-[1040px] text-left text-caption">
            <caption className="sr-only">Replay history for {playerName}</caption>
            <thead className="border-b-2 border-line bg-bg-elevated/70 text-micro uppercase tracking-wider text-text-muted">
              <tr>
                <th scope="col" className="w-24 px-4 py-3 font-semibold">Result</th>
                <th scope="col" className="w-40 px-3 py-3 font-semibold">Played</th>
                <th scope="col" className="min-w-52 px-3 py-3 font-semibold">Matchup</th>
                <th scope="col" className="min-w-40 px-3 py-3 font-semibold">Map</th>
                <th scope="col" className="min-w-56 px-3 py-3 font-semibold">Game plan</th>
                <th scope="col" className="w-36 px-3 py-3 font-semibold">Vitals</th>
                <th scope="col" className={`${owner ? "w-48" : "w-40"} px-4 py-3 text-right font-semibold`}>Open</th>
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
                  publicLocked={publicLocked}
                  listQuery={listQuery}
                />
              ))}
            </tbody>
          </table>
        </div>

        <ul className="divide-y divide-border lg:grid lg:grid-cols-2 xl:hidden" role="list">
          {items.map((game) => (
            <MobileReplayCard
              key={game.gameId}
              game={game}
              owner={owner}
              playerName={playerName}
              publicRoot={publicRoot}
              publicHandle={publicHandle}
              publicLocked={publicLocked}
              listQuery={listQuery}
            />
          ))}
        </ul>
      </div>

    </>
  );
}

interface RowProps {
  game: ReplayLibraryItem;
  owner: boolean;
  playerName: string;
  publicRoot: string | null;
  publicHandle?: string;
  publicLocked: boolean;
  listQuery?: string;
}

function DesktopReplayRow({ game, owner, playerName, publicRoot, publicHandle, publicLocked, listQuery }: RowProps) {
  const analysisHref = owner
    ? `/app/game/${encodeURIComponent(game.gameId)}`
    : sharedAnalysisHref(publicRoot || "", game.gameId, listQuery);
  return (
    <tr className="group bg-bg-surface transition-colors hover:bg-bg-elevated/55">
      <td className={["border-l-4 px-4 py-3", resultRail(game.result)].join(" ")}>
        <ResultBadge result={game.result} />
      </td>
      <td className="px-3 py-3 align-middle text-text-muted"><ReplayDate value={game.date} /></td>
      <td className="px-3 py-3 align-middle"><Matchup game={game} playerName={playerName} />{game.streams?.length ? <GameStreamLinks links={game.streams} compact ariaLabel={`Streams for ${replayContext(game)}`} sharedPlayerName={owner ? undefined : playerName} className="mt-2" /> : null}</td>
      <td className="px-3 py-3 align-middle">
        {game.map ? (
          <MapLabel name={game.map} size="xs" preview className="max-w-48" />
        ) : (
          <span className="text-text-dim">Unknown map</span>
        )}
      </td>
      <td className="px-3 py-3 align-middle"><GamePlan game={game} owner={owner} /></td>
      <td className="px-3 py-3 align-middle"><Vitals game={game} /></td>
      <td className="px-4 py-3 align-middle">
        <div className="flex items-center justify-end gap-1.5">
          {owner ? <>
            <Link
              href={`${analysisHref}#macro`}
              className={actionClass}
              aria-label={`Open macro breakdown for ${opponentLabel(game)}`}
            >
              <Gauge className="h-4 w-4" aria-hidden /> Macro
            </Link>
          <Link href={analysisHref} className={actionClass} aria-label={`Open replay analysis for ${replayContext(game)}`}>
            <BarChart3 className="h-4 w-4" aria-hidden /> Analysis
          </Link>
          {owner && isReviewableGame(game) ? (
            <AskForReviewButton
              gameId={game.gameId}
              durationSec={game.durationSec}
              matchup={game.matchup ?? null}
              className={actionClass}
              label="Review"
              ariaLabel={`Ask for a review of your game vs ${replayContext(game)}`}
            />
          ) : null}
            <ReplayDownloadButton
              gameId={game.gameId}
              available={game.replayAvailable}
              filename={game.replayFilename}
              sizeBytes={game.replaySizeBytes}
              contextLabel={replayContext(game)}
            />
          </> : <PublicReplayActions game={game} href={analysisHref} handle={publicHandle} locked={publicLocked} />}
        </div>
      </td>
    </tr>
  );
}

function MobileReplayCard({ game, owner, playerName, publicRoot, publicHandle, publicLocked, listQuery }: RowProps) {
  const analysisHref = owner
    ? `/app/game/${encodeURIComponent(game.gameId)}`
    : sharedAnalysisHref(publicRoot || "", game.gameId, listQuery);
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
        {owner ? <Link
          href={analysisHref}
          aria-label={`${owner ? "Open" : "Sign in to open"} replay analysis for ${replayContext(game)}`}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full border-2 border-line bg-bg-elevated text-text transition-colors hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <ArrowUpRight className="h-4 w-4" aria-hidden />
        </Link> : null}
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
        {owner ? <>
          <Link href={`${analysisHref}#macro`} className={mobileActionClass} aria-label={`Open macro breakdown for ${replayContext(game)}`}>
            <Gauge className="h-4 w-4" aria-hidden /> Macro breakdown
          </Link>
        <Link href={analysisHref} className={mobileActionClass} aria-label={`Open replay analysis for ${replayContext(game)}`}>
          <Eye className="h-4 w-4" aria-hidden /> Analysis
        </Link>
        {owner && isReviewableGame(game) ? (
          <AskForReviewButton
            gameId={game.gameId}
            durationSec={game.durationSec}
            matchup={game.matchup ?? null}
            className={mobileActionClass}
            label="Ask for review"
            ariaLabel={`Ask for a review of your game vs ${replayContext(game)}`}
          />
        ) : null}
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
        </> : <PublicReplayActions game={game} href={analysisHref} handle={publicHandle} locked={publicLocked} mobile />}
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
        <dd className="flex min-w-0 items-center gap-1">
          <span className="truncate text-text" title={game.myBuild || undefined}>{game.myBuild || "Unclassified"}</span>
          {owner && game.buildPlanned === true ? <PlannedBadge detected={game.detectedBuild ?? null} /> : null}
        </dd>
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
        tone={macroScoreTone(game.macroScore)}
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
    <time suppressHydrationWarning dateTime={value} title={fmtDate(value)} className="whitespace-nowrap text-text-muted">
      {fmtDateCompact(value)}
    </time>
  );
}

type DisplayResult = "Win" | "Loss" | "Tie" | "Unknown";

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
  if (normalized === "draw" || normalized === "tie") return "Tie";
  return "Unknown";
}

function resultRail(result?: string | null): string {
  const normalized = normalizeResult(result);
  return normalized === "Win" ? "border-l-success" : normalized === "Loss" ? "border-l-danger" : "border-l-text-dim";
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

const lockedAnalysisLabel = "Timeline, macro breakdown and both build orders. Sign in free to open.";
function PublicReplayActions({ game, href, handle, locked, mobile = false }: { game: ReplayLibraryItem; href: string; handle?: string; locked: boolean; mobile?: boolean }) {
  return <div className={`flex items-center gap-2 ${mobile ? "w-full" : "justify-end"}`}>
    {handle ? <div className={mobile ? "min-w-0 flex-1" : undefined}><PublicReplayDownloadButton handle={handle} gameId={game.gameId} available={game.replayAvailable} sizeBytes={game.replaySizeBytes} contextLabel={replayContext(game)} mobile={mobile} primary /></div> : null}
    <Link href={href} className={mobile ? mobileActionClass : actionClass} title={locked ? lockedAnalysisLabel : undefined} aria-label={locked ? lockedAnalysisLabel : `Open replay analysis for ${replayContext(game)}`}>
      {locked ? <LockKeyhole className="h-3.5 w-3.5 flex-none text-text-dim" aria-hidden /> : <BarChart3 className="h-4 w-4 flex-none" aria-hidden />}<span>Analysis{locked ? <span className="block text-[10px] font-normal text-text-dim">Free account</span> : null}</span>
    </Link>
  </div>;
}

const actionClass = "inline-flex min-h-8 items-center gap-1.5 rounded-md border border-border bg-bg-elevated/60 px-2.5 text-micro font-semibold text-text-muted transition-colors hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const mobileActionClass = "inline-flex min-h-[44px] items-center gap-2 rounded-lg border-2 border-line bg-bg-surface px-3 text-caption font-semibold text-text transition-colors hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
