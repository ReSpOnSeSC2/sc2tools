"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ExternalLink } from "lucide-react";
import { useApi } from "@/lib/clientApi";
import { useFilters } from "@/lib/filterContext";
import { Card, EmptyState, Skeleton, Stat, WrBar } from "@/components/ui/Card";
import { fmtMmr, pct1, wrColor } from "@/lib/format";
import { pickPulseLabel, sc2pulseCharacterUrl } from "@/lib/sc2pulse";
import { AllGamesTable } from "./AllGamesTable";
import { Last5GamesTimeline } from "./Last5GamesTimeline";
import type { ProfileGame } from "./Last5GamesTimeline";
import { MedianTimingsGrid } from "./MedianTimingsGrid";
import type { MatchupTimings, TimingInfo } from "./MedianTimingsGrid";
import { PredictedStrategiesList } from "./PredictedStrategiesList";
import type { Prediction } from "./PredictedStrategiesList";
import { StrategyTendencyChart } from "./StrategyTendencyChart";
import type { StrategyEntry } from "./StrategyTendencyChart";
import { H2HTrendsSection } from "./h2h/H2HTrendsSection";
import type { BuildMatchupSelection } from "./h2h/BuildMatrix";
import { gameOutcome } from "@/lib/h2hSeries";

type OpponentProfileResp = {
  pulseId?: string;
  pulseCharacterId?: string | null;
  toonHandle?: string | null;
  // Distinct toon handles whose games merged into this profile.
  // The API merges by canonical SC2Pulse character id when one is
  // resolved, which surfaces pre-rebind games against a player
  // whose Battle.net rotated. Length > 1 → render the disclosure
  // chip; absent / length ≤ 1 → render nothing extra.
  mergedToonHandles?: string[] | null;
  name?: string;
  displayNameSample?: string;
  // Last-known MMR — propagated from the most recent game's
  // ``opponent.mmr`` by ``recordGame`` / ``refreshMetadata``. The agent
  // sources this field SC2Pulse-first at upload time, falling back to
  // the in-replay value when SC2Pulse can't be reached. Null/absent
  // when no MMR has ever been recorded for this opponent.
  mmr?: number | null;
  totals?: { wins: number; losses: number; total: number; winRate: number };
  byMap?: Record<string, { wins: number; losses: number }>;
  byStrategy?: Record<string, { wins: number; losses: number }>;
  topStrategies?: StrategyEntry[];
  predictedStrategies?: Prediction[];
  myRace?: string;
  oppRaceModal?: string;
  matchupLabel?: string;
  matchupCounts?: Record<string, number>;
  matchupTimings?: Record<string, MatchupTimings>;
  matchupTimingsLegacy?: Record<string, MatchupTimings>;
  medianTimings?: Record<string, TimingInfo>;
  medianTimingsLegacy?: Record<string, TimingInfo>;
  medianTimingsOrder?: string[];
  last5Games?: ProfileGame[];
  games?: ProfileGame[];
};

export function ProfileView({
  pulseId,
  onBack,
}: {
  pulseId: string;
  onBack: () => void;
}) {
  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex min-h-[44px] items-center gap-1 rounded-md px-2 py-1 text-caption uppercase tracking-wider text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden />
        Back
      </button>
      <ProfileBody pulseId={pulseId} />
    </div>
  );
}

function ProfileBody({ pulseId }: { pulseId: string }) {
  // Date-range filter applies to every panel below except "Likely
  // strategies next" and "Last 5 games", which the API resolves from
  // the unfiltered history regardless of since/until.
  const { filters } = useFilters();
  const profileQuery = buildProfileQuery(filters.since, filters.until);
  const { data, isLoading } = useApi<OpponentProfileResp>(
    `/v1/opponents/${encodeURIComponent(pulseId)}${profileQuery}`,
  );
  // Lifted filter state — clicking a row label in the H2H "Maps"
  // view, or a cell in the "Builds" matrix, narrows the All-games
  // table and the by-map / by-strategy summary cards below it. The
  // chips inside the H2H header surface the active filter and clear
  // it on tap.
  const [selectedMap, setSelectedMap] = useState<string | null>(null);
  const [selectedBuildMatchup, setSelectedBuildMatchup] =
    useState<BuildMatchupSelection | null>(null);
  const [pendingGameId, setPendingGameId] = useState<string | null>(null);
  const [pendingGameSeq, setPendingGameSeq] = useState<number>(0);

  const games: ProfileGame[] = useMemo(() => data?.games || [], [data?.games]);
  const filteredGames = useMemo(() => {
    if (!selectedMap && !selectedBuildMatchup) return games;
    return games.filter((g) => {
      if (selectedMap && (g.map || "") !== selectedMap) return false;
      if (selectedBuildMatchup) {
        if ((g.my_build || "") !== selectedBuildMatchup.myBuild) return false;
        if ((g.opp_strategy || "") !== selectedBuildMatchup.oppStrategy) return false;
      }
      return true;
    });
  }, [games, selectedMap, selectedBuildMatchup]);

  if (isLoading) return <Skeleton rows={6} />;
  if (!data) return <EmptyState title="Opponent not found" sub={pulseId} />;
  const filterActive = !!selectedMap || !!selectedBuildMatchup;
  const t = filterActive
    ? totalsFromGames(filteredGames)
    : data.totals || { wins: 0, losses: 0, total: 0, winRate: 0 };
  const publicHref = `/community/opponents/${encodeURIComponent(pulseId)}`;
  const byMap = filterActive
    ? rollUpByMap(filteredGames)
    : Object.entries(data.byMap || {})
        .map(([name, v]) => ({
          name,
          wins: v.wins,
          losses: v.losses,
          total: v.wins + v.losses,
          winRate: v.wins + v.losses ? v.wins / (v.wins + v.losses) : 0,
        }))
        .sort((a, b) => b.total - a.total);
  const byStrategy = filterActive
    ? rollUpByStrategy(filteredGames)
    : Object.entries(data.byStrategy || {})
        .map(([name, v]) => ({
          name,
          wins: v.wins,
          losses: v.losses,
          total: v.wins + v.losses,
          winRate: v.wins + v.losses ? v.wins / (v.wins + v.losses) : 0,
        }))
        .sort((a, b) => b.total - a.total);
  const medianTimings = data.medianTimingsLegacy || {};
  const medianTimingsOrder =
    data.medianTimingsOrder && data.medianTimingsOrder.length
      ? data.medianTimingsOrder
      : Object.keys(medianTimings);
  const matchupTimings = data.matchupTimingsLegacy || {};
  const matchupCounts = data.matchupCounts || {};
  const opponentName = data.name || data.pulseId || pulseId;
  const handleSelectGame = (id: string) => {
    setPendingGameId(id);
    setPendingGameSeq((n) => n + 1);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-h2 font-semibold">{data.name || "unnamed"}</h1>
            <LastMmrChip mmr={data.mmr} />
            <MergedToonsChip handles={data.mergedToonHandles} />
          </div>
          <ProfilePulseLine
            pulseCharacterId={data.pulseCharacterId}
            toonHandle={data.toonHandle}
            pulseId={data.pulseId || pulseId}
          />
          <Link
            href={publicHref}
            className="text-caption text-accent hover:underline"
          >
            community profile →
          </Link>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Games" value={t.total || 0} />
          <Stat label="W" value={t.wins || 0} color="rgb(var(--success))" />
          <Stat label="L" value={t.losses || 0} color="rgb(var(--danger))" />
          <Stat
            label="WR"
            value={pct1(t.winRate)}
            color={wrColor(t.winRate, t.total)}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <Card title="By map">
          {byMap.length === 0 ? (
            <EmptyState sub="No maps yet" />
          ) : (
            <ul className="space-y-2 text-sm">
              {byMap.map((m) => (
                <li key={m.name}>
                  <div className="flex justify-between">
                    <span>{m.name}</span>
                    <span
                      className="tabular-nums"
                      style={{ color: wrColor(m.winRate, m.total) }}
                    >
                      {m.wins}-{m.losses} · {pct1(m.winRate)}
                    </span>
                  </div>
                  <WrBar wins={m.wins} losses={m.losses} />
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="By strategy">
          {byStrategy.length === 0 ? (
            <EmptyState sub="No strategies tagged yet" />
          ) : (
            <ul className="space-y-2 text-sm">
              {byStrategy.map((s) => (
                <li key={s.name}>
                  <div className="flex justify-between">
                    <span>{s.name}</span>
                    <span
                      className="tabular-nums"
                      style={{ color: wrColor(s.winRate, s.total) }}
                    >
                      {s.wins}-{s.losses} · {pct1(s.winRate)}
                    </span>
                  </div>
                  <WrBar wins={s.wins} losses={s.losses} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card title="Build tendencies (top 5 strategies)">
          <StrategyTendencyChart strategies={data.topStrategies || []} />
        </Card>
        <Card title="Likely strategies next">
          <PredictedStrategiesList
            predictions={data.predictedStrategies || []}
          />
        </Card>
      </div>

      <H2HTrendsSection
        games={games}
        oppRace={data.oppRaceModal}
        opponentName={opponentName}
        selectedMap={selectedMap}
        onSelectMap={setSelectedMap}
        selectedBuildMatchup={selectedBuildMatchup}
        onSelectBuildMatchup={setSelectedBuildMatchup}
        onSelectGame={handleSelectGame}
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card
          title={`Median key timings${data.matchupLabel ? ` — ${data.matchupLabel}` : ""}`}
        >
          <MedianTimingsGrid
            timings={medianTimings}
            order={medianTimingsOrder}
            matchupLabel={data.matchupLabel || ""}
            matchupCounts={matchupCounts}
            matchupTimings={matchupTimings}
            opponentName={opponentName}
          />
          <p className="mt-2 text-[10px] text-text-dim">
            Opponent-tech cards come from the agent-uploaded opponent build
            log; your-tech cards come from your build log. Click a card with
            samples to see the contributing games. "-" means no samples in
            this matchup.
          </p>
        </Card>
        <Card title="Last 5 games">
          <Last5GamesTimeline games={data.last5Games || []} />
        </Card>
      </div>

      <Card
        title={
          filterActive
            ? `All games (${filteredGames.length} of ${games.length}) · newest first`
            : `All games (${games.length}) · newest first`
        }
      >
        <AllGamesTable
          games={filteredGames}
          targetGameId={pendingGameId}
          targetGameSeq={pendingGameSeq}
        />
      </Card>
    </div>
  );
}

function rollUpByMap(games: ProfileGame[]): Array<{
  name: string;
  wins: number;
  losses: number;
  total: number;
  winRate: number;
}> {
  const acc = new Map<string, { wins: number; losses: number }>();
  for (const g of games) {
    const o = gameOutcome(g);
    if (o === "U") continue;
    const name = (g.map || "—").trim() || "—";
    const cur = acc.get(name) || { wins: 0, losses: 0 };
    if (o === "W") cur.wins++;
    else cur.losses++;
    acc.set(name, cur);
  }
  return Array.from(acc.entries())
    .map(([name, v]) => ({
      name,
      wins: v.wins,
      losses: v.losses,
      total: v.wins + v.losses,
      winRate: v.wins + v.losses ? v.wins / (v.wins + v.losses) : 0,
    }))
    .sort((a, b) => b.total - a.total);
}

function rollUpByStrategy(games: ProfileGame[]): Array<{
  name: string;
  wins: number;
  losses: number;
  total: number;
  winRate: number;
}> {
  const acc = new Map<string, { wins: number; losses: number }>();
  for (const g of games) {
    const o = gameOutcome(g);
    if (o === "U") continue;
    const name = (g.opp_strategy || "—").trim() || "—";
    const cur = acc.get(name) || { wins: 0, losses: 0 };
    if (o === "W") cur.wins++;
    else cur.losses++;
    acc.set(name, cur);
  }
  return Array.from(acc.entries())
    .map(([name, v]) => ({
      name,
      wins: v.wins,
      losses: v.losses,
      total: v.wins + v.losses,
      winRate: v.wins + v.losses ? v.wins / (v.wins + v.losses) : 0,
    }))
    .sort((a, b) => b.total - a.total);
}

function totalsFromGames(games: ProfileGame[]): {
  wins: number;
  losses: number;
  total: number;
  winRate: number;
} {
  let wins = 0;
  let losses = 0;
  for (const g of games) {
    const o = gameOutcome(g);
    if (o === "W") wins++;
    else if (o === "L") losses++;
  }
  const total = wins + losses;
  return { wins, losses, total, winRate: total > 0 ? wins / total : 0 };
}

function buildProfileQuery(since: string | undefined, until: string | undefined): string {
  const usp = new URLSearchParams();
  if (since) usp.set("since", since);
  if (until) usp.set("until", until);
  const q = usp.toString();
  return q ? `?${q}` : "";
}

/**
 * Disclosure chip rendered in the profile header when the opponent's
 * games were merged across more than one toon_handle (the rare
 * Battle.net rebind case where SC2Pulse keeps the same canonical
 * character id but the in-replay toon rotates). The chip's
 * native ``title`` attribute lists every merged toon so the user
 * can hover/long-press for the full set without us shipping a
 * dedicated tooltip primitive. Hidden entirely on the single-toon
 * common case so existing profiles look identical.
 *
 * Touch-target: the chip itself is non-interactive (no link / no
 * tap action), so the 44 px minimum-touch rule from the rest of the
 * SPA doesn't apply — it's an inline disclosure, sized to read
 * comfortably alongside the h1 on both mobile and desktop without
 * crowding the stat strip.
 */
/**
 * Last-known MMR pill rendered in the profile header next to the
 * opponent's name. Sources the ``opponent.mmr`` stamped onto the most
 * recent game we've ingested — the agent prefers SC2Pulse at upload
 * time and falls back to the in-replay value, so this is the freshest
 * rating we have for them. Hidden entirely when null/missing so empty
 * profiles look identical to today.
 *
 * Visual: same pill primitive as ``MergedToonsChip`` for visual rhyme,
 * but accent-coloured so MMR reads as a stat (not a disclosure). Sits
 * inside the flex-wrap row, so it slots cleanly under the title on
 * narrow viewports and inline with the title on desktop.
 */
function LastMmrChip({ mmr }: { mmr?: number | null }) {
  if (typeof mmr !== "number" || !Number.isFinite(mmr) || mmr <= 0) {
    return null;
  }
  return (
    <span
      role="note"
      aria-label={`Last known MMR ${Math.round(mmr)}`}
      title="Last known MMR — most recent game on record"
      className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-accent tabular-nums"
    >
      <span className="text-accent/70">MMR</span>
      <span>{fmtMmr(mmr)}</span>
    </span>
  );
}

function MergedToonsChip({
  handles,
}: {
  handles?: string[] | null;
}) {
  if (!handles || handles.length <= 1) return null;
  const summary = `Merged across ${handles.length} toons`;
  // Native title on a span — browsers / screen readers surface it
  // as the accessible description. Mobile users get the same on
  // long-press in most browsers; we don't need a custom tooltip.
  return (
    <span
      role="note"
      aria-label={`${summary}: ${handles.join(", ")}`}
      title={`Same SC2Pulse character across:\n${handles.join("\n")}`}
      className="inline-flex items-center rounded-full border border-accent-cyan/40 bg-accent-cyan/10 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-accent-cyan"
    >
      {summary}
    </span>
  );
}

/**
 * Pulse identity line in the profile header. Mirrors the table-cell
 * treatment in OpponentsTab: when we have a real SC2Pulse character
 * id, link out to nephest with the resolved id; otherwise fall back to
 * the toon_handle (the value from the user's replay folder name) and
 * label it accordingly.
 */
function ProfilePulseLine({
  pulseCharacterId,
  toonHandle,
  pulseId,
}: {
  pulseCharacterId?: string | null;
  toonHandle?: string | null;
  pulseId: string;
}) {
  const label = pickPulseLabel({ pulseCharacterId, toonHandle, pulseId });
  if (!label) {
    return (
      <div className="font-mono text-caption text-text-dim">Pulse ID —</div>
    );
  }
  if (label.isPulseCharacterId) {
    return (
      <div className="flex flex-wrap items-center gap-2 font-mono text-caption text-text-dim">
        <span>Pulse ID</span>
        <a
          href={sc2pulseCharacterUrl(label.value)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-accent-cyan hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          {label.value}
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
        {toonHandle ? (
          <span className="text-text-dim/70">· toon {toonHandle}</span>
        ) : null}
      </div>
    );
  }
  return (
    <div className="font-mono text-caption text-text-dim">
      Toon {label.value}
      <span className="ml-2 text-[10px] uppercase tracking-wider text-text-dim/70">
        sc2pulse id not resolved yet
      </span>
    </div>
  );
}
