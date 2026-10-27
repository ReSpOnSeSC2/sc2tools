"use client";

import { useChromeBreadcrumb } from "@/components/chrome/ChromeContext";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import type { TimingHistoryFilter } from "@/lib/dossierTypes";
import type { OpponentProfileResp } from "./ProfileView.types";
import { MergedToonsChip, MergedIdentitiesLine, ProfilePulseLine, PublicProfileLink } from "./DossierHeaderDetails";
import { useSWRConfig } from "swr";
import Link from "next/link";
import dynamic from "next/dynamic";
import { SectionNav } from "@/components/ui/SectionNav";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { DossierOnView } from "./DossierOnView";
import { DossierIdentitySection } from "./DossierIdentitySection";
import { dossierIsBusy, useDossierBusyRetry } from "./useDossierBusyRetry";
import { DossierFilterBar } from "./DossierFilterBar";
import { Button } from "@/components/ui/Button";
import { useToastOptional } from "@/components/ui/Toast";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { isOpponentKey } from "@/lib/opponentCache";
import { useApi } from "@/lib/clientApi";
import { RevealedChip } from "./RevealedChip";
import { DossierRivalStar } from "./opponents/DossierRivalStar";
import { UnsavedNoteProvider } from "./UnsavedNoteContext";
import {
  filtersToQuery,
  summarizeFilters,
  useFilters,
  type AnalyzerFilters,
} from "@/lib/filterContext";
import { useOpponentScoutingPreference } from "@/lib/useOpponentScoutingPreference";
import { GroupingPreference } from "./opponents/GroupingPreference";
import { useMyDisplayName } from "@/lib/useMyDisplayName";
import { Card, EmptyState, Stat, WrBar } from "@/components/ui/Card";
import { QueryState, hasQueryData } from "@/components/ui/QueryState";
import { isNotFoundError } from "@/lib/requestErrors";
import { pct1, wrColor } from "@/lib/format";
import {
  isBarcodeName,
} from "@/lib/sc2pulse";
import { OpponentReplayHistory } from "./OpponentReplayHistory";
const DossierAnalysisSection = dynamic(() => import("./DossierAnalysisSection").then(module => module.DossierAnalysisSection), { ssr: false });
const ScoutingBriefCard = dynamic(() => import("./ScoutingBriefCard").then(module => module.ScoutingBriefCard));
const OpponentSeriesStrip = dynamic(() => import("./OpponentSeriesStrip").then(module => module.OpponentSeriesStrip));
const LadderContextCard = dynamic(() => import("./LadderContextCard").then(module => module.LadderContextCard));
import {
  HeadlineMmrChip,
  RaceMmrPanel,
  type PulseRaceBreakdown,
  type PulseLadderRating,
} from "./OpponentRaceMmr";
import type { ProfileGame } from "./Last5GamesTimeline";
import { H2HTrendsSection } from "./h2h/H2HTrendsSection";
import type { BuildMatchupSelection } from "./h2h/BuildMatrix";
import { gameOutcome } from "@/lib/h2hSeries";
import {
  OpponentNotesCard,
  type OpponentNotesValue,
} from "./OpponentNotesCard";
import { PlayerChannelLinks } from "./PlayerChannelLinks";
import { usePlayerChannels } from "./usePlayerChannels";
import {
  DOSSIER_ERROR_COPY,
  DossierSkeleton,
  OpponentNotFound,
} from "./OpponentDossierStates";


/**
 * Behavioral identity leads are useful until a barcode has a readable reveal.
 * A Pulse character id and MMR describe the ladder character, but they do not
 * identify the person behind an intentionally unreadable display name.
 */
export function hasUnrevealedBarcodeIdentity(
  profile: Pick<
    OpponentProfileResp,
    | "name"
    | "displayNameSample"
    | "revealedName"
    | "pulseCharacterId"
    | "mmr"
  >,
): boolean {
  const displayedName = profile.name || profile.displayNameSample;
  const reveal =
    typeof profile.revealedName === "string"
      ? profile.revealedName.trim()
      : "";
  const hasReadableReveal = Boolean(reveal && !isBarcodeName(reveal));
  return isBarcodeName(displayedName) && !hasReadableReveal;
}

export function ProfileView({
  pulseId,
  onBack,
  backHref = "/app/opponents",
}: {
  pulseId: string;
  onBack: () => void;
  backHref?: string;
}) {
  const { userId, isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <DossierSkeleton />;
  if (!isSignedIn || !userId) return <p role="status" className="text-caption text-text-muted">Sign in to view opponent history.</p>;
  return <UnsavedNoteProvider key={`${userId}:${pulseId}`} onLeaveList={onBack}><ProfileBody pulseId={pulseId} backHref={backHref} /></UnsavedNoteProvider>;
}

function ProfileBody({ pulseId, backHref }: { pulseId: string; backHref: string }) {
  const { mutate: refreshCache } = useSWRConfig();
  // The shared analyzer scope applies to the profile as well as the
  // opponents list that led here. In particular, opening an opponent
  // must not silently re-introduce custom or team games after the list
  // was narrowed to ladder 1v1.
  const { filters: analyzerFilters, dbRev, seasons } = useFilters();
  const [allTime, setAllTime] = useState(false);
  const filters = useMemo(() => allTime ? { ...analyzerFilters, preset: "all" as const, since: undefined, until: undefined } : analyzerFilters, [allTime, analyzerFilters]);
  const [identityOpen, setIdentityOpen] = useState(false), [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const debouncedDbRev = useDebouncedValue(dbRev, 2000);
  const toast = useToastOptional()?.toast;
  const myName = useMyDisplayName();
  // Same "Group same player" toggle the Opponents tab persists. When
  // on, the API folds every identity SC2Pulse links to this player
  // into ONE profile — merged games, totals, and timelines — and the
  // header shows the per-name breakdown below.
  const grouping = useOpponentScoutingPreference();
  const { groupByPlayer } = grouping;
  const profileQuery = buildProfileQuery(filters, groupByPlayer);
  const profile = useApi<OpponentProfileResp>(
    grouping.loading ? null : `/v1/opponents/${encodeURIComponent(pulseId)}${profileQuery}#${debouncedDbRev}`,
    { keepPreviousData: true, shouldRetryOnError: false },
  );
  const { data, mutate } = profile;
  const busyRetrying = useDossierBusyRetry(`${pulseId}:${profileQuery}`, profile.error, mutate);
  const anonymous = !!data && !data.globalIdentity && hasUnrevealedBarcodeIdentity(data);
  const unresolved = !!data && !data.pulseCharacterId;
  useEffect(() => { if (anonymous || unresolved) setIdentityOpen(true); if (unresolved) setDiagnosticsOpen(true); }, [anonymous, unresolved]);
  // Per-race SC2Pulse breakdown — fetched in parallel (live, cached
  // server-side) so it doesn't block the main profile render. Drives
  // the header MMR chip + the "Ladder MMR by race" panel.
  const { data: races, isLoading: racesLoading } =
    useApi<PulseRaceBreakdown>(
      `/v1/opponents/${encodeURIComponent(pulseId)}/pulse-races`,
      { revalidateOnFocus: false },
    );
  // Shares the LadderContextCard SWR key, so a confirmed main without
  // current-season race teams can still show its latest recorded rating.
  const { data: ladder } = useApi<{ intel: PulseLadderRating | null }>(
    data?.globalIdentity ? `/v1/opponents/${encodeURIComponent(pulseId)}/pulse-intel` : null,
    { revalidateOnFocus: false },
  );
  // Lifted filter state — clicking a row label in the H2H "Maps"
  // view, or a cell in the "Builds" matrix, narrows the All-games
  // table and the by-map / by-strategy summary cards below it. The
  // chips inside the H2H header surface the active filter and clear
  // it on tap.
  const [selectedTiming, setSelectedTiming] = useState<TimingHistoryFilter | null>(null);
  useEffect(() => { setSelectedTiming(null); }, [profileQuery, debouncedDbRev]);
  const [selectedStrategy, setSelectedStrategy] = useState<string | null>(null);
  const [selectedMap, setSelectedMap] = useState<string | null>(null);
  const [selectedBuildMatchup, setSelectedBuildMatchup] =
    useState<BuildMatchupSelection | null>(null);
  const [pendingGameId, setPendingGameId] = useState<string | null>(null);
  const [pendingGameSeq, setPendingGameSeq] = useState<number>(0);

  const games: ProfileGame[] = useMemo(() => data?.games || [], [data?.games]);
  const filteredGames = useMemo(() => {
    if (!selectedMap && !selectedBuildMatchup && !selectedStrategy && !selectedTiming) return games;
    const timingIds = selectedTiming ? new Set(selectedTiming.gameIds) : null;
    return games.filter((g) => {
      if (timingIds && (!g.id || !timingIds.has(g.id))) return false;
      if (selectedMap && (g.map || "") !== selectedMap) return false;
      if (selectedStrategy && g.opp_strategy !== selectedStrategy) return false;
      if (selectedBuildMatchup) {
        if ((g.my_build || "") !== selectedBuildMatchup.myBuild) return false;
        if ((g.opp_strategy || "") !== selectedBuildMatchup.oppStrategy) return false;
      }
      return true;
    });
  }, [games, selectedMap, selectedBuildMatchup, selectedStrategy, selectedTiming]);
  const replayHistoryQuery = buildOpponentReplayHistoryQuery(
    filters,
    groupByPlayer,
    selectedMap,
    selectedBuildMatchup,
    selectedStrategy,
    selectedTiming?.gameIds,
  );
  const replayHistoryPath =
    `/v1/opponents/${encodeURIComponent(pulseId)}/games${replayHistoryQuery}`;
  const channelProfileIdentity = {
    pulseId: data?.pulseId || pulseId,
    pulseCharacterId: data?.pulseCharacterId,
    toonHandle: data?.toonHandle,
  };
  const channelsFor = usePlayerChannels([channelProfileIdentity]);

  // A 404 means "not in your history"; a 503, 5xx or dropped connection
  // means the dossier couldn't be built right now, and gets Retry.
  const chromeBreadcrumb = useChromeBreadcrumb({ backHref, backLabel: "All opponents", trail: [{ label: "Opponents", href: backHref }, { label: profile.data?.name || (profile.data ? profile.data.pulseId || pulseId : "…") }] });

  if (!hasQueryData(profile)) {
    return (
      <div className="space-y-3">
      {!chromeBreadcrumb ? <nav aria-label="Breadcrumb" className="text-caption text-text-muted"><Link href={backHref}>Opponents</Link><span aria-hidden> / </span><span aria-current="page">…</span></nav> : null}
      <QueryState
        q={profile}
        skeleton={<DossierSkeleton />}
        filtered
        errorCopy={DOSSIER_ERROR_COPY}
        renderError={(error) => isNotFoundError(error) ? <OpponentNotFound /> : dossierIsBusy(error) && busyRetrying ? <div role="status" className="rounded-xl border border-border p-5"><p>Analyzing… retrying</p><Button variant="ghost" onClick={() => void mutate()}>Retry now</Button></div> : undefined}
      />
      </div>
    );
  }
  if (!data) return <OpponentNotFound />;
  const filterActive = !!selectedMap || !!selectedBuildMatchup || !!selectedStrategy || !!selectedTiming;
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
  const opponentName = data.name || data.pulseId || pulseId;
  const playerChannels = channelsFor(channelProfileIdentity);
  // Avoid the bounded matcher request for readable profiles. Pulse/MMR data
  // enriches an anonymous barcode; only a readable reveal resolves it.
  const identityCandidatesEnabled = !data.globalIdentity && hasUnrevealedBarcodeIdentity(data);
  const identitySubmissionEnabled = Boolean(data.globalIdentity) || isBarcodeName(data.displayNameSample || data.name);
  const handleSelectGame = (id: string) => {
    setPendingGameId(id);
    setPendingGameSeq((n) => n + 1);
  };

  return (
    <div className="min-w-0 max-w-full space-y-5">
      {!chromeBreadcrumb ? <nav aria-label="Breadcrumb" className="min-w-0 max-w-full text-caption text-text-muted"><Link href={backHref} className="underline">Opponents</Link><span aria-hidden> / </span><span aria-current="page" className="[overflow-wrap:anywhere]">{opponentName}</span></nav> : null}
      <header aria-label="Opponent profile" className="flex flex-wrap items-end justify-between gap-4">
        <div className="w-full min-w-0 lg:w-auto lg:flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="min-w-0 max-w-full [overflow-wrap:anywhere] text-h2 font-semibold">{data.name || "unnamed"}</h1>
            <DossierRivalStar pulseId={data.pulseId || pulseId} name={data.name || "unnamed opponent"} />
            <RevealedChip
              size="md"
              name={data.globalIdentity?.displayName || data.revealedName}
              displayedName={data.name}
              confirmed={Boolean(data.globalIdentity)}
            />
            <HeadlineMmrChip breakdown={races} fallbackMmr={data.mmr} confirmedIdentity={data.globalIdentity} ladderIntel={ladder?.intel} />
            {/* The identities breakdown below supersedes the toons
                disclosure — showing both would say the same thing
                twice. */}
            {(data.mergedIdentities?.length ?? 0) > 1 ? null : (
              <MergedToonsChip handles={data.mergedToonHandles} />
            )}
          </div>
          {data.series ? <div className="my-3"><OpponentSeriesStrip series={data.series} /></div> : null}
          <div className="flex flex-wrap items-center gap-3"><ProfilePulseLine
            pulseCharacterId={data.pulseCharacterId}
            toonHandle={data.toonHandle}
            pulseId={data.pulseId || pulseId}
            recordedAccount={Boolean(data.globalIdentity)}
          /><a href="#dossier-identity" className="inline-flex min-h-11 items-center text-caption text-accent underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={() => { setIdentityOpen(true); setDiagnosticsOpen(true); }}>Data looks wrong?</a></div>
          {playerChannels ? (
            <div className="mt-3 [&_a]:min-h-11">
              <PlayerChannelLinks
                channels={playerChannels}
                playerName={data.globalIdentity?.displayName || data.revealedName || data.name || data.displayNameSample}
              />
            </div>
          ) : null}
          <MergedIdentitiesLine
            identities={data.mergedIdentities}
            mainName={data.name}
          />
          {data.communityAvailable ? (
            <PublicProfileLink href={publicHref} />
          ) : null}
        </div>
        <div className={`grid w-full grid-cols-2 gap-3 sm:grid-cols-4 lg:w-auto ${filterActive ? "[&>div]:border-accent" : ""}`}>
          <Stat label={filterActive ? "Games (filtered)" : "Games"} value={t.total || 0} />
          <Stat label={filterActive ? "W (filtered)" : "W"} value={t.wins || 0} color="rgb(var(--success))" />
          <Stat label={filterActive ? "L (filtered)" : "L"} value={t.losses || 0} color="rgb(var(--danger))" />
          <Stat
            label={filterActive ? "WR (filtered)" : "WR"}
            value={pct1(t.winRate)}
            color={wrColor(t.winRate, t.total)}
          />
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 text-caption text-text-muted"><span>Showing {summarizeFilters(filters, seasons)}</span><Button variant="ghost" onClick={() => setAllTime(value => !value)}>{allTime ? "Use analyzer dates" : "Show all time"}</Button><LazyHelpLink slug="opponent-dossier">How to read this page</LazyHelpLink></div>
      <GroupingPreference preference={grouping} />
      {data.games?.length === 0 && !!data.series?.games.length ? <p className="text-caption text-text-muted">No games in this range.{data.series.lastSeen ? ` You last met on ${new Date(data.series.lastSeen).toLocaleDateString()}.` : ""} <button type="button" className="min-h-11 px-2 text-accent underline" onClick={() => setAllTime(true)}>Show all time</button></p> : null}
      {profile.error ? <div role="status" className="flex items-center gap-3 text-caption text-warning">
        <span>Couldn't refresh after your last game</span><Button variant="ghost" size="sm" onClick={() => mutate()}>Retry</Button>
      </div> : null}
      <DossierFilterBar filters={[
        ...(selectedTiming ? [{ key: "timing", label: "Analyzed timing sample", value: `${selectedTiming.label} · ${selectedTiming.gameIds.length} games`, clear: () => setSelectedTiming(null) }] : []),
        ...(selectedMap ? [{ key: "map", label: "Map", value: selectedMap, clear: () => setSelectedMap(null) }] : []),
        ...(selectedStrategy ? [{ key: "strategy", label: "Their strategy", value: selectedStrategy, clear: () => setSelectedStrategy(null) }] : []),
        ...(selectedBuildMatchup ? [{ key: "build", label: "Build", value: `${selectedBuildMatchup.myBuild} vs ${selectedBuildMatchup.oppStrategy}`, clear: () => setSelectedBuildMatchup(null) }] : []),
      ]} onClear={() => { setSelectedMap(null); setSelectedStrategy(null); setSelectedBuildMatchup(null); setSelectedTiming(null); }} />
      {filterActive && data.gamesTruncated ? <p className="text-caption text-text-muted">Filtered summary uses the latest analyzed games. Replay history below searches your full history.</p> : null}
      <SectionNav variant="bar" aria-label="Dossier sections" items={[{ id: "dossier-brief", label: "Brief" }, { id: "dossier-tendencies", label: "Tendencies" }, { id: "dossier-timings", label: "Timings" }, { id: "dossier-history", label: "History" }, { id: "dossier-ladder", label: "Ladder" }, { id: "dossier-identity", label: "Identity" }]} />
      <section id="dossier-brief" tabIndex={-1} className="min-w-0 max-w-full scroll-mt-32 space-y-3"><h2 className="text-h3 font-semibold">Brief</h2><ScoutingBriefCard profile={data} /></section>
      <section id="dossier-tendencies" tabIndex={-1} className="min-w-0 max-w-full scroll-mt-32 space-y-5"><h2 className="text-h3 font-semibold">Tendencies</h2>
      <H2HTrendsSection
        games={games}
        oppRace={data.oppRaceModal}
        opponentName={opponentName}
        selectedMap={selectedMap}
        onSelectMap={setSelectedMap}
        selectedBuildMatchup={selectedBuildMatchup}
        onSelectBuildMatchup={(selection) => { setSelectedBuildMatchup(selection); setSelectedStrategy(null); }}
        onSelectGame={handleSelectGame}
      />

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <Card title="By map">
          {byMap.length === 0 ? (
            <EmptyState sub="No maps yet" />
          ) : (
            <ul className="space-y-2 text-sm">
              {byMap.map((m) => (
                <li key={m.name}>
                  <button className={`flex min-h-11 w-full items-center justify-between rounded px-2 text-left ${selectedMap === m.name ? "bg-accent/10 ring-1 ring-accent" : ""}`} aria-pressed={selectedMap === m.name} onClick={() => setSelectedMap(selectedMap === m.name ? null : m.name)}>
                    <span className="min-w-0 flex-1 break-words">{m.name}</span>
                    <span
                      className="tabular-nums"
                      style={{ color: wrColor(m.winRate, m.total) }}
                    >
                      {m.wins}-{m.losses} · {pct1(m.winRate)}
                    </span>
                  </button>
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
                  <button className={`flex min-h-11 w-full items-center justify-between rounded px-2 text-left ${selectedStrategy === s.name ? "bg-accent/10 ring-1 ring-accent" : ""}`} aria-pressed={selectedStrategy === s.name} onClick={() => { setSelectedStrategy(selectedStrategy === s.name ? null : s.name); setSelectedBuildMatchup(null); }}>
                    <span className="min-w-0 flex-1 break-words">{s.name}</span>
                    <span
                      className="tabular-nums"
                      style={{ color: wrColor(s.winRate, s.total) }}
                    >
                      {s.wins}-{s.losses} · {pct1(s.winRate)}
                    </span>
                  </button>
                  <p className="text-micro text-text-muted">{Math.round(100 * s.total / Math.max(1, byStrategy.reduce((sum, row) => sum + row.total, 0)))}% of tagged decided games</p><div className="h-1.5 overflow-hidden rounded-full bg-bg-elevated" aria-hidden><div className="h-full bg-accent" style={{ width: `${100 * s.total / Math.max(1, byStrategy.reduce((sum, row) => sum + row.total, 0))}%` }} /></div>
                  <WrBar wins={s.wins} losses={s.losses} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      </section>
      <section id="dossier-timings" tabIndex={-1} className="min-w-0 max-w-full scroll-mt-32 space-y-3"><h2 className="text-h3 font-semibold">Timings and phases</h2><DossierOnView key={`${profileQuery}:${debouncedDbRev}`} label="Timing and phase analysis"><DossierAnalysisSection path={`/v1/opponents/${encodeURIComponent(pulseId)}/analysis${profileQuery}#${debouncedDbRev}`} sourceFilters={profileQuery} scopeLabel={summarizeFilters(filters, seasons)} predictions={profile.isPreviousData ? null : data.predictedStrategies || []} forecast={profile.isPreviousData ? undefined : data.openingForecast} selected={selectedTiming} onSelect={setSelectedTiming} /></DossierOnView></section>
      <section id="dossier-history" tabIndex={-1} className="min-w-0 max-w-full scroll-mt-32 space-y-5"><h2 className="text-h3 font-semibold">History</h2>
      <OpponentReplayHistory
        // A query-scope or database revision change must reset cursor history
        // to page one. Remounting avoids briefly applying an old opaque cursor
        // to a new filter set.
        key={`${replayHistoryPath}:${dbRev}`}
        path={replayHistoryPath}
        selectedMap={selectedMap} onSelectMap={setSelectedMap} maps={Object.keys(data.byMap || {})}
        initialGames={filteredGames}
        profileTruncated={data.gamesTruncated}
        targetGameId={pendingGameId}
        targetGameSeq={pendingGameSeq}
        myName={myName}
        opponentContext={{
          pulseId,
          displayName: data.name || data.displayNameSample || null,
        }}
      />

      <OpponentNotesCard
        headingLevel={3}
        pulseId={pulseId}
        initialNotes={data.notes}
        initialNotesReadAloud={data.notesReadAloud}
        onSaved={(value: OpponentNotesValue) => {
          void mutate(
            { ...data, ...value },
            { revalidate: false },
          );
        }}
      />

      </section>
      <section id="dossier-ladder" tabIndex={-1} className="min-w-0 max-w-full scroll-mt-32 space-y-3"><h2 className="text-h3 font-semibold">Ladder</h2><DossierOnView label="Ladder context"><LadderContextCard pulseId={pulseId} confirmedIdentity={data.globalIdentity}><RaceMmrPanel embedded breakdown={races} isLoading={racesLoading} confirmedIdentity={data.globalIdentity} /></LadderContextCard></DossierOnView></section>
      <DossierIdentitySection pulseId={pulseId} open={identityOpen} onOpenChange={setIdentityOpen} diagnosticsOpen={diagnosticsOpen} submission={identitySubmissionEnabled} candidates={identityCandidatesEnabled} race={data.oppRaceModal} onChanged={() => { void refreshCache(isOpponentKey(pulseId)); }} onRetried={async response => { await refreshCache(isOpponentKey(pulseId)); if (response.resolvedPulseCharacterId) toast?.success("Pulse data refreshed"); else toast?.info("Still couldn't find their SC2Pulse profile"); }} />



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

export function buildProfileQuery(
  filters: AnalyzerFilters,
  mergeLinked?: boolean,
): string {
  const filterQuery = filtersToQuery(filters);
  const usp = new URLSearchParams(
    filterQuery.startsWith("?") ? filterQuery.slice(1) : filterQuery,
  );
  if (mergeLinked) usp.set("mergeLinked", "1");
  const q = usp.toString();
  return q ? `?${q}` : "";
}

/** Build the compact history request, including H2H table drill-downs. */
export function buildOpponentReplayHistoryQuery(
  filters: AnalyzerFilters,
  mergeLinked?: boolean,
  selectedMap?: string | null,
  selectedBuildMatchup?: BuildMatchupSelection | null,
  selectedStrategy?: string | null,
  analysisGameIds?: string[],
): string {
  const query = buildProfileQuery(
    {
      ...filters,
      ...(selectedMap ? { map: selectedMap } : {}),
      ...(selectedStrategy ? { opp_strategy: selectedStrategy } : {}),
      ...(selectedBuildMatchup
        ? {
            build: selectedBuildMatchup.myBuild,
            opp_strategy: selectedBuildMatchup.oppStrategy,
          }
        : {}),
    },
    mergeLinked,
  );
  if (analysisGameIds) {
    const params = new URLSearchParams(query.replace(/^\?/, ""));
    params.set("analysisGameIds", JSON.stringify(analysisGameIds));
    return `?${params}`;
  }
  return query;
}
