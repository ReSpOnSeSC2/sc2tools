"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ExternalLink } from "lucide-react";
import { useApi } from "@/lib/clientApi";
import {
  filtersToQuery,
  useFilters,
  type AnalyzerFilters,
} from "@/lib/filterContext";
import { useLocalStorageState } from "@/lib/useLocalStorageState";
import { useMyDisplayName } from "@/lib/useMyDisplayName";
import {
  LS_GROUP_BY_PLAYER,
  type MergedIdentity,
} from "@/lib/opponentGroups";
import { Card, EmptyState, Skeleton, Stat, WrBar } from "@/components/ui/Card";
import { pct1, wrColor } from "@/lib/format";
import {
  isBarcodeName,
  pickPulseLabel,
  sc2pulseCharacterUrl,
} from "@/lib/sc2pulse";
import { OpponentReplayHistory } from "./OpponentReplayHistory";
import { LadderContextCard } from "./LadderContextCard";
import { OpponentDiagnosticsPanel } from "./OpponentDiagnosticsPanel";
import {
  HeadlineMmrChip,
  RaceMmrPanel,
  type PulseRaceBreakdown,
} from "./OpponentRaceMmr";
import type { ProfileGame } from "./Last5GamesTimeline";
import { PredictedStrategiesList } from "./PredictedStrategiesList";
import type { Prediction } from "./PredictedStrategiesList";
import { StrategyTendencyChart } from "./StrategyTendencyChart";
import type { StrategyEntry } from "./StrategyTendencyChart";
import { H2HTrendsSection } from "./h2h/H2HTrendsSection";
import type { BuildMatchupSelection } from "./h2h/BuildMatrix";
import { gameOutcome } from "@/lib/h2hSeries";
import { WhereGamesEndBar } from "./WhereGamesEndBar";
import type { BuildPhasePayload, BuildTransitionsPayload } from "@/lib/serverApi";
import {
  OpponentNotesCard,
  type OpponentNotesValue,
} from "./OpponentNotesCard";
import { OpponentIdentityCandidates } from "./OpponentIdentityCandidates";

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
  // Per-name breakdown when the API merged every identity SC2Pulse
  // links to the same player into this profile (mergeLinked=1).
  // Newest activity first. Absent / length ≤ 1 → single-identity
  // profile, nothing extra rendered.
  mergedIdentities?: MergedIdentity[] | null;
  name?: string;
  displayNameSample?: string;
  // SC2Pulse "revealed" identity behind a barcode — the pro/main name
  // the community linked on sc2pulse.nephest.com. Absent for opponents
  // who aren't revealed.
  revealedName?: string | null;
  // Last-known MMR — propagated from the most recent game's
  // ``opponent.mmr`` by ``recordGame`` / ``refreshMetadata``. The agent
  // sources this field SC2Pulse-first at upload time, falling back to
  // the in-replay value when SC2Pulse can't be reached. Null/absent
  // when no MMR has ever been recorded for this opponent.
  mmr?: number | null;
  /** Private user-authored scouting notes for this exact opponent row. */
  notes?: string;
  /** Add the notes to TTS when this opponent is detected. */
  notesReadAloud?: boolean;
  totals?: { wins: number; losses: number; total: number; winRate: number };
  byMap?: Record<string, { wins: number; losses: number }>;
  byStrategy?: Record<string, { wins: number; losses: number }>;
  topStrategies?: StrategyEntry[];
  predictedStrategies?: Prediction[];
  myRace?: string;
  oppRaceModal?: string;
  // Phase distribution for the "Where games end" outcome bar.
  // Computed server-side from the same date-filtered matched games
  // that drive the by-map / by-strategy panels.
  // Optional so old API builds that pre-date the wiring still render
  // the rest of the profile without a runtime error.
  phases?: BuildPhasePayload;
  transitions?: BuildTransitionsPayload;
  gamesTruncated?: boolean;
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
  // The shared analyzer scope applies to the profile as well as the
  // opponents list that led here. In particular, opening an opponent
  // must not silently re-introduce custom or team games after the list
  // was narrowed to ladder 1v1.
  const { filters, dbRev } = useFilters();
  const myName = useMyDisplayName();
  // Same "Group same player" toggle the Opponents tab persists. When
  // on, the API folds every identity SC2Pulse links to this player
  // into ONE profile — merged games, totals, and timelines — and the
  // header shows the per-name breakdown below.
  const [groupByPlayer] = useLocalStorageState<boolean>(
    LS_GROUP_BY_PLAYER,
    true,
    (raw): raw is boolean => typeof raw === "boolean",
  );
  const profileQuery = buildProfileQuery(filters, groupByPlayer);
  const { data, isLoading, mutate } = useApi<OpponentProfileResp>(
    `/v1/opponents/${encodeURIComponent(pulseId)}${profileQuery}`,
  );
  // Per-race SC2Pulse breakdown — fetched in parallel (live, cached
  // server-side) so it doesn't block the main profile render. Drives
  // the header MMR chip + the "Ladder MMR by race" panel.
  const { data: races, isLoading: racesLoading } =
    useApi<PulseRaceBreakdown>(
      `/v1/opponents/${encodeURIComponent(pulseId)}/pulse-races`,
      { revalidateOnFocus: false },
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
  const replayHistoryQuery = buildOpponentReplayHistoryQuery(
    filters,
    groupByPlayer,
    selectedMap,
    selectedBuildMatchup,
  );
  const replayHistoryPath =
    `/v1/opponents/${encodeURIComponent(pulseId)}/games${replayHistoryQuery}`;

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
  const opponentName = data.name || data.pulseId || pulseId;
  const resolvedMmr = races?.topMmr ?? data.mmr;
  // Avoid the matcher request for normal readable profiles. The API repeats
  // this eligibility gate authoritatively because race/MMR enrichment can
  // finish between these parallel requests.
  const identityCandidatesEnabled =
    !racesLoading
    && isBarcodeName(data.name || data.displayNameSample)
    && !data.revealedName
    && (
      !data.pulseCharacterId
      || !(typeof resolvedMmr === "number" && resolvedMmr > 0)
    );
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
            <RevealedChip
              name={data.revealedName}
              displayedName={data.name}
            />
            <HeadlineMmrChip breakdown={races} fallbackMmr={data.mmr} />
            {/* The identities breakdown below supersedes the toons
                disclosure — showing both would say the same thing
                twice. */}
            {(data.mergedIdentities?.length ?? 0) > 1 ? null : (
              <MergedToonsChip handles={data.mergedToonHandles} />
            )}
          </div>
          <ProfilePulseLine
            pulseCharacterId={data.pulseCharacterId}
            toonHandle={data.toonHandle}
            pulseId={data.pulseId || pulseId}
          />
          <MergedIdentitiesLine
            identities={data.mergedIdentities}
            mainName={data.name}
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

      <OpponentNotesCard
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

      <OpponentIdentityCandidates
        pulseId={pulseId}
        enabled={identityCandidatesEnabled}
        race={data.oppRaceModal}
      />

      <RaceMmrPanel breakdown={races} isLoading={racesLoading} />

      {/* SC2Pulse ladder context — league/percentile, season record,
          peak, 90-day MMR sparkline, pro identity + linked accounts.
          Fetched in parallel with the profile; renders nothing while
          the opponent's pulseCharacterId is still unresolved. */}
      <LadderContextCard pulseId={pulseId} />

      <OpponentDiagnosticsPanel
        collapsible
        diagnosticsPath={`/v1/opponents/${encodeURIComponent(pulseId)}/diagnostics`}
        retryPath={`/v1/opponents/${encodeURIComponent(pulseId)}/retry-pulse`}
      />

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

      {/* ``min-w-0`` on the grid children lets the columns shrink
          below their intrinsic content size — long strategy names
          inside the Cards would otherwise overflow the page. */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div className="min-w-0">
          <Card title="Build tendencies (top 5 strategies)">
            <StrategyTendencyChart strategies={data.topStrategies || []} />
          </Card>
        </div>
        <div className="min-w-0">
          <Card title="Likely strategies next">
            <PredictedStrategiesList
              predictions={data.predictedStrategies || []}
            />
          </Card>
        </div>
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

      <WhereGamesEndSection
        finalPhaseDistribution={data.phases?.finalPhaseDistribution}
      />

      <OpponentReplayHistory
        // A query-scope or database revision change must reset cursor history
        // to page one. Remounting avoids briefly applying an old opaque cursor
        // to a new filter set.
        key={`${replayHistoryPath}:${dbRev}`}
        path={replayHistoryPath}
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
): string {
  return buildProfileQuery(
    {
      ...filters,
      ...(selectedMap ? { map: selectedMap } : {}),
      ...(selectedBuildMatchup
        ? {
            build: selectedBuildMatchup.myBuild,
            opp_strategy: selectedBuildMatchup.oppStrategy,
          }
        : {}),
    },
    mergeLinked,
  );
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
      className="inline-flex items-center rounded-full border border-accent-cyan/40 bg-accent-cyan/10 px-2 py-0.5 text-micro font-medium uppercase tracking-wider text-accent-cyan"
    >
      {summary}
    </span>
  );
}

/**
 * Per-name breakdown for a merged player profile: every name SC2Pulse
 * links to this player, with its own W-L, so "all their games on one
 * page" stays auditable per name. The stats on this page already span
 * all of them — this line is disclosure, not navigation. Renders
 * nothing on single-identity profiles.
 */
function MergedIdentitiesLine({
  identities,
  mainName,
}: {
  identities?: MergedIdentity[] | null;
  mainName?: string;
}) {
  if (!identities || identities.length <= 1) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      <span
        className="text-micro uppercase tracking-wider text-text-dim"
        title="SC2Pulse links these names to the same player — this page merges all of their games"
      >
        Plays as
      </span>
      {identities.map((identity) => {
        const label = identity.name || "unnamed";
        const isMain = !!mainName && identity.name === mainName;
        return (
          <span
            key={identity.pulseId}
            title={`${label} · ${identity.wins}-${identity.losses} vs you`}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-caption ${
              isMain
                ? "border-accent/40 bg-accent/10 text-text"
                : "border-border bg-bg-elevated text-text-muted"
            }`}
          >
            <span className="max-w-[9rem] truncate">{label}</span>
            <span className="tabular-nums text-micro text-text-dim">
              {identity.wins}-{identity.losses}
            </span>
          </span>
        );
      })}
    </div>
  );
}

/**
 * SC2Pulse "revealed" identity pill for the profile heading. For a
 * barcode opponent the heading is unreadable bars; the revealed pro/main
 * name is the real identity. Renders nothing when not revealed — or
 * when the heading already IS the revealed name (a merged profile led
 * by the pro name; repeating it is clutter).
 */
function RevealedChip({
  name,
  displayedName,
}: {
  name?: string | null;
  displayedName?: string;
}) {
  const tag = typeof name === "string" ? name.trim() : "";
  if (!tag || tag === (displayedName || "").trim()) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-accent-cyan/15 px-2.5 py-0.5 text-caption font-semibold text-accent-cyan"
      title={`Revealed on SC2Pulse as ${tag}`}
    >
      <span className="text-micro font-medium uppercase tracking-wider opacity-70">
        revealed
      </span>
      {tag}
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
          <span className="text-text-muted">· toon {toonHandle}</span>
        ) : null}
      </div>
    );
  }
  return (
    <div className="font-mono text-caption text-text-dim">
      Toon {label.value}
      <span className="ml-2 text-micro uppercase tracking-wider text-text-muted">
        sc2pulse id not resolved yet
      </span>
    </div>
  );
}

/**
 * "Where games end" — stacked outcome distribution over the same
 * date-filtered matched games that drive the other panels on this
 * page. Renders nothing when the API hasn't returned any phase data
 * (or the sum is zero), so first-meeting opponents don't see an
 * empty card.
 */
function WhereGamesEndSection({
  finalPhaseDistribution,
}: {
  finalPhaseDistribution?: BuildPhasePayload["finalPhaseDistribution"];
}) {
  const total =
    (finalPhaseDistribution?.early || 0) +
    (finalPhaseDistribution?.earlyMid || 0) +
    (finalPhaseDistribution?.mid || 0) +
    (finalPhaseDistribution?.midLate || 0) +
    (finalPhaseDistribution?.late || 0);
  if (total === 0) return null;
  return (
    <Card title="Where games end">
      <WhereGamesEndBar finalPhaseDistribution={finalPhaseDistribution} />
    </Card>
  );
}
