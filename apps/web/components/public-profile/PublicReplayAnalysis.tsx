"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  BarChart3,
  Check,
  Copy,
  Gauge,
  Radio,
  Swords,
} from "lucide-react";
import { GameStreamLinks } from "@/components/analyzer/GameStreamLinks";
import { BuildOrderColumns } from "@/components/analyzer/game/BuildOrderColumns";
import { InteractiveTimeline } from "@/components/analyzer/game/InteractiveTimeline";
import { MechanicsPanel } from "@/components/analyzer/game/MechanicsPanel";
import type { PublicReplayDetailResponse } from "@/components/analyzer/replays/types";
import { PublicReplayDownloadButton } from "@/components/public-profile/PublicReplayDownloadButton";
import { MapArtwork, MapLabel } from "@/components/maps/MapArtwork";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/Stat";
import { useToast } from "@/components/ui/Toast";
import { fmtDate, fmtMinutes, fmtMmr } from "@/lib/format";
import { coerceRace, raceIconName } from "@/lib/race";

export function PublicReplayAnalysis({ data }: { data: PublicReplayDetailResponse }) {
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const { profile, game, macroBreakdown, buildOrder, streams } = data;
  const root = `/p/${encodeURIComponent(profile.handle)}/replays`;
  const canonicalPath = `${root}/${encodeURIComponent(game.gameId)}`;
  const opponentName = game.opponent?.displayName?.trim() || "Unknown opponent";
  const matchup = matchupLabel(game.myRace, game.opponent?.race);
  const multiplayerLabel = replayFormatLabel(game.matchFormat, game.playerCount);
  const opponentPrefix = multiplayerLabel ? "Primary opponent" : "Opponent";
  const result = normalizedResult(game.result);
  const timelineAvailable = Boolean(
    macroBreakdown?.stats_events?.length || macroBreakdown?.opp_stats_events?.length,
  );

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${canonicalPath}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
      toast.success("Replay analysis link copied");
    } catch {
      window.prompt("Copy this replay analysis link", `${window.location.origin}${canonicalPath}`);
    }
  }

  return (
    <article className="space-y-6">
      <Link href={root} className="inline-flex min-h-[44px] items-center gap-2 rounded-md text-caption font-semibold text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Back to {profile.displayName}&apos;s replays
      </Link>

      <Card variant="feature" padded={false} className="relative overflow-hidden">
        <MapArtwork mapName={game.map} size="hero" eager className="pointer-events-none absolute inset-0 border-0 opacity-35" />
        <span aria-hidden className="absolute inset-0 bg-gradient-to-r from-bg-surface via-bg-surface/95 to-bg-surface/65" />
        <div className="relative p-5 sm:p-7">
          <PageHeader
            eyebrow={
              <span className="inline-flex flex-wrap items-center gap-2">
                <BarChart3 className="h-4 w-4" aria-hidden /> Shared replay analysis
                <ResultBadge result={result} />
              </span>
            }
            title={
              multiplayerLabel
                ? `${profile.displayName}'s ${multiplayerLabel.toLowerCase()}`
                : `${profile.displayName} vs ${opponentName}`
            }
            description={
              <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                {matchup ? <strong className="text-text">{matchup}</strong> : null}
                {multiplayerLabel ? (
                  <>
                    <span aria-hidden>·</span>
                    <strong className="text-text">{multiplayerLabel}</strong>
                    <span aria-hidden>·</span>
                    <span>{opponentPrefix}: {opponentName}</span>
                  </>
                ) : null}
                {game.map ? <><span aria-hidden>·</span><MapLabel name={game.map} size="xs" /></> : null}
                {game.date ? <><span aria-hidden>·</span><time suppressHydrationWarning dateTime={game.date}>{fmtDate(game.date)}</time></> : null}
              </span>
            }
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <PublicReplayDownloadButton
                  handle={profile.handle}
                  gameId={game.gameId}
                  available={game.replayAvailable}
                  sizeBytes={game.replaySizeBytes}
                  showLabel
                  contextLabel={
                    multiplayerLabel
                      ? `${profile.displayName}'s ${multiplayerLabel.toLowerCase()}`
                      : `${profile.displayName} vs ${opponentName}`
                  }
                />
                <button type="button" onClick={() => void copyLink()} className="hard-press inline-flex h-11 min-w-[44px] items-center gap-2 rounded-full border-2 border-line bg-bg-surface px-5 font-display text-body font-bold text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                  {copied ? <Check className="h-4 w-4 text-success" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
                  {copied ? "Copied" : "Copy analysis link"}
                </button>
              </div>
            }
          />

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Badge variant="accent" size="md">{profile.displayName}: {game.myBuild || "Unclassified"}</Badge>
            <Badge variant="neutral" size="md">{opponentPrefix}: {game.opponent?.strategy || "Unknown strategy"}</Badge>
            {streams?.length ? <GameStreamLinks links={streams} sharedPlayerName={profile.displayName} className="sm:ml-auto" /> : null}
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="Result" value={<span className={result === "Win" ? "text-success" : result === "Loss" ? "text-danger" : "text-text"}>{result}</span>} size="sm" />
        <StatCard label="Length" value={fmtMinutes(game.durationSec)} size="sm" />
        <StatCard label={`${profile.displayName} MMR`} value={fmtMmr(game.myMmr)} size="sm" />
        <StatCard label={`${opponentPrefix} MMR`} value={fmtMmr(game.opponent?.mmr)} size="sm" />
        <StatCard label="Macro score" value={game.macroScore != null ? Math.round(game.macroScore) : "—"} size="sm" className="col-span-2 lg:col-span-1" />
      </div>

      {streams?.length ? (
        <Card>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="flex items-center gap-2 font-display text-h3 font-bold text-text"><Radio className="h-5 w-5 text-danger" aria-hidden /> Watch the game</h2>
              <p className="mt-1 text-caption text-text-muted">Links open at the replay&apos;s matched start time. “Player” and “Opp” identify the recorded point of view.</p>
            </div>
            <GameStreamLinks links={streams} sharedPlayerName={profile.displayName} />
          </div>
        </Card>
      ) : null}

      <section id="replay-analysis" className="scroll-mt-24 space-y-4" aria-labelledby="analysis-title">
        <div>
          <p className="overline text-accent-cyan">Replay analysis</p>
          <h2 id="analysis-title" className="mt-1 font-display text-h2 font-bold text-text">How the game unfolded</h2>
          <p className="mt-1 text-body text-text-muted">Scrub the real replay samples to compare army value, economy and supply through each fight.</p>
        </div>
        {timelineAvailable ? (
          <InteractiveTimeline
            statsEvents={macroBreakdown?.stats_events}
            oppStatsEvents={macroBreakdown?.opp_stats_events}
            gameLengthSec={game.durationSec ?? macroBreakdown?.game_length_sec ?? null}
            scrubTime={scrubTime}
            onScrub={setScrubTime}
            myName={profile.displayName}
            oppName={opponentName}
            perspectiveLabel={profile.displayName}
          />
        ) : (
          <Card>
            <EmptyStatePanel
              icon={<Swords className="h-6 w-6" aria-hidden />}
              title="Timeline samples weren't captured for this replay"
              description="The rest of the replay-derived analysis remains available below."
            />
          </Card>
        )}
      </section>

      <section id="macro-breakdown" className="scroll-mt-24 space-y-4" aria-labelledby="macro-title">
        <div>
          <p className="overline text-accent-cyan">Macro breakdown</p>
          <h2 id="macro-title" className="mt-1 flex items-center gap-2 font-display text-h2 font-bold text-text"><Gauge className="h-6 w-6" aria-hidden /> Economy and mechanics</h2>
          <p className="mt-1 text-body text-text-muted">Replay-derived spending, supply, race-mechanic and resource-float signals.</p>
        </div>
        <div className="grid gap-6 lg:grid-cols-2">
          <MechanicsPanel
            breakdown={macroBreakdown}
            game={game}
            onSeek={timelineAvailable ? setScrubTime : undefined}
            emptyDescription="Detailed macro mechanics were not captured for this replay."
          />
          <MacroLeakCard data={macroBreakdown} />
        </div>
      </section>

      <section className="space-y-4" aria-labelledby="build-orders-title">
        <div>
          <p className="overline text-accent-cyan">Build reconstruction</p>
          <h2 id="build-orders-title" className="mt-1 font-display text-h2 font-bold text-text">Both build orders</h2>
        </div>
        <BuildOrderColumns
          myEvents={buildOrder?.events}
          oppEvents={buildOrder?.opp_events}
          myLabel={buildOrder?.my_build ?? game.myBuild}
          oppLabel={buildOrder?.opp_strategy ?? game.opponent?.strategy}
          myHeadingLabel={profile.displayName}
          opponentHeadingLabel={opponentPrefix}
          myStatus={buildOrder?.my_status}
          oppStatus={buildOrder?.opp_status}
        />
      </section>

      <p className="text-center text-micro text-text-dim">This analysis was shared by {profile.displayName}. Page data omits SC2 Tools account and storage fields; downloading the original replay exposes its embedded metadata and a temporary storage URL.</p>
    </article>
  );
}

function MacroLeakCard({ data }: { data: PublicReplayDetailResponse["macroBreakdown"] }) {
  const leaks = (data?.top_3_leaks?.length ? data.top_3_leaks : data?.all_leaks)?.slice(0, 3) || [];
  return (
    <Card title="Highest-impact macro leaks">
      {leaks.length === 0 ? (
        <EmptyStatePanel size="sm" title="No scored macro leaks" description="This replay has no detailed leak events in its uploaded analysis." />
      ) : (
        <ol className="space-y-3">
          {leaks.map((leak, index) => (
            <li key={`${leak.name || "leak"}-${index}`} className="rounded-lg border border-border bg-bg-elevated/45 p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-text">{leak.name || "Macro inefficiency"}</p>
                  {leak.detail ? <p className="mt-1 text-caption text-text-muted">{leak.detail}</p> : null}
                </div>
                {leak.penalty != null ? <Badge variant="danger" size="sm">−{Math.abs(Math.round(leak.penalty))} pts</Badge> : null}
              </div>
              {leak.mineral_cost != null ? <p className="mt-2 font-mono text-micro tabular-nums text-warning">≈ {Math.round(leak.mineral_cost)} minerals</p> : null}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

type DisplayResult = "Win" | "Loss" | "Draw" | "Unknown";

function ResultBadge({ result }: { result: DisplayResult }) {
  return <Badge variant={result === "Win" ? "success" : result === "Loss" ? "danger" : "neutral"} size="sm">{result}</Badge>;
}

function normalizedResult(value?: string | null): DisplayResult {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "win" || normalized === "victory") return "Win";
  if (normalized === "loss" || normalized === "defeat") return "Loss";
  if (normalized === "draw" || normalized === "tie") return "Draw";
  return "Unknown";
}

function matchupLabel(myRace?: string | null, oppRace?: string | null): string | null {
  if (!myRace || !oppRace) return null;
  const mine = coerceRace(myRace);
  const opponent = coerceRace(oppRace);
  return `${raceLetter(mine)}v${raceLetter(opponent)}`;
}

function raceLetter(race: ReturnType<typeof coerceRace>): string {
  return raceIconName(race).charAt(0).toUpperCase();
}

function replayFormatLabel(
  format?: "1v1" | "team" | "ffa" | "other" | null,
  playerCount?: number | null,
): string | null {
  const players = playerCount ? ` · ${playerCount} players` : "";
  if (format === "team") return `Team replay${players}`;
  if (format === "ffa") return `Free-for-all replay${players}`;
  if (format === "other") return `Custom-format replay${players}`;
  return null;
}
