"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useAuth } from "@clerk/nextjs";
import {
  AlertCircle,
  ChevronLeft,
  ListTree,
  MapPin,
  RefreshCcw,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { apiCall, useApi } from "@/lib/clientApi";
import type { ClientApiError } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { fmtDate, fmtMinutes } from "@/lib/format";
import { computeEffectiveRace } from "@/lib/macro";
import {
  coerceRace,
  raceIconName,
  type Race,
} from "@/lib/race";
import { ActiveArmyChart } from "@/components/analyzer/macro/ActiveArmyChart";
import type {
  LeakItem,
  MacroBreakdownData,
} from "@/components/analyzer/macro/MacroBreakdownPanel.types";
import type { BuildOrderEvent } from "@/lib/build-events";
import { ApmSpmChart, type ApmCurveData } from "./ApmSpmChart";
import { BuildOrderTimeline } from "./BuildOrderTimeline";
import { ChronoAllocationChart } from "./ChronoAllocationChart";
import { GamePicker, type PickerGame } from "./PerGameInspectorPicker";
import { ResourcesOverTimeChart } from "./ResourcesOverTimeChart";

/**
 * PerGameInspector — the Activity tab's main surface.
 *
 * Two-pane layout on desktop, detail-first on mobile:
 *   - Left (lg+): searchable list of recent games. On <lg the list owns
 *     the full panel until the user picks a game; selection swaps in
 *     the detail view with a sticky "Back" button so the user is never
 *     scrolled past a long picker to find the charts.
 *   - Right: per-game charts for the selected game. The cards render
 *     progressively — Build order from `buildLog` (always uploaded by
 *     the agent), Active Army / Resources / Chrono from the macro
 *     breakdown when present, APM/SPM from `apmCurve` when present.
 *     Each card carries its own empty state instead of one big blocker
 *     for the whole tab.
 *
 * Data sources hit /v1/games-list, /v1/games/:id/build-order,
 * /v1/games/:id/macro-breakdown and /v1/games/:id/apm-curve. No data
 * is synthesised — older replays without PlayerStatsEvent rows or APM
 * curves surface inline empty states explaining how to refresh the
 * sample stream via the agent's Resync.
 */

type GamesListResp = {
  ok?: boolean;
  total?: number;
  games: Array<{
    id?: string;
    date?: string;
    map?: string;
    opponent?: string;
    opp_race?: string;
    opp_strategy?: string | null;
    result?: string;
    build?: string;
    game_length?: number;
    macro_score?: number | null;
    my_race?: string;
  }>;
};

type BuildOrderResp = {
  ok?: boolean;
  game_id?: string;
  my_build?: string | null;
  my_race?: string | null;
  opp_strategy?: string | null;
  opponent?: string | null;
  opp_race?: string | null;
  map?: string | null;
  result?: string | null;
  events?: BuildOrderEvent[];
  early_events?: BuildOrderEvent[];
  opp_events?: BuildOrderEvent[];
  opp_early_events?: BuildOrderEvent[];
};

type SelectedGame = PickerGame;

const GAMES_LIMIT = 100;

export function PerGameInspector() {
  const { filters, dbRev } = useFilters();
  const queryStr = useMemo(() => {
    return filtersToQuery({
      ...filters,
      sort: "date_desc",
      limit: GAMES_LIMIT,
    });
  }, [filters]);

  const { data, error, isLoading } = useApi<GamesListResp>(
    `/v1/games-list${queryStr}#${dbRev}`,
  );

  const games = useMemo<SelectedGame[]>(() => {
    const raw = data?.games || [];
    return raw
      .filter((g): g is SelectedGame & { id: string } => Boolean(g.id))
      .map((g) => ({
        id: g.id,
        date: g.date,
        map: g.map,
        opponent: g.opponent,
        opp_race: g.opp_race,
        result: g.result,
        build: g.build,
        game_length: g.game_length,
        macro_score: g.macro_score ?? null,
        my_race: g.my_race,
      }));
  }, [data]);

  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // On mobile, hide the picker once a game is selected so the user
  // lands on the charts immediately. Defaulting to false avoids an
  // initial render where the picker takes over the screen on lg+.
  const [mobileShowDetail, setMobileShowDetail] = useState(false);

  useEffect(() => {
    if (games.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !games.some((g) => g.id === selectedId)) {
      // Auto-select most recent so desktop users see charts immediately,
      // but DON'T flip into mobile-detail mode — first paint on mobile
      // should land on the picker.
      setSelectedId(games[0].id);
    }
  }, [games, selectedId]);

  const filteredGames = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return games;
    return games.filter((g) => {
      const fields = [
        g.opponent,
        g.map,
        g.build,
        g.opp_race,
        g.my_race,
        g.result,
      ]
        .filter(Boolean)
        .map((v) => String(v).toLowerCase());
      return fields.some((f) => f.includes(q));
    });
  }, [games, search]);

  const selected = useMemo(
    () => games.find((g) => g.id === selectedId) || null,
    [games, selectedId],
  );

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
    setMobileShowDetail(true);
    // Snap to the top so the summary card is in view, not hidden
    // beneath the just-tapped picker row.
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, []);

  const handleBack = useCallback(() => {
    setMobileShowDetail(false);
  }, []);

  const showPickerMobile = !mobileShowDetail;
  const showDetailMobile = mobileShowDetail;

  return (
    <div className="lg:grid lg:grid-cols-[320px_minmax(0,1fr)] lg:gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
      <div
        className={[
          // Mobile/tablet: only show the picker when no game is open.
          // lg+: always render side-by-side regardless of detail state.
          showPickerMobile ? "block" : "hidden",
          "lg:block",
        ].join(" ")}
      >
        <GamePicker
          games={filteredGames}
          totalGames={games.length}
          isLoading={isLoading && games.length === 0}
          error={error?.message}
          search={search}
          onSearch={setSearch}
          selectedId={selectedId}
          onSelect={handleSelect}
        />
      </div>
      <div
        className={[
          "min-w-0 space-y-4",
          // Mobile/tablet: only show the detail when the user picked a
          // game. The lg+ panel always renders both columns.
          showDetailMobile ? "mt-4 block lg:mt-0" : "hidden",
          "lg:block",
        ].join(" ")}
      >
        {selected ? (
          <SelectedGameCharts game={selected} onBack={handleBack} />
        ) : (
          <Card title="Select a replay">
            <EmptyState
              title="No replay selected"
              sub={
                isLoading
                  ? "Loading your recent games…"
                  : "Pick a game from the list to see resources, army, APM, and chrono allocation."
              }
            />
          </Card>
        )}
      </div>
    </div>
  );
}

function SelectedGameCharts({
  game,
  onBack,
}: {
  game: SelectedGame;
  onBack: () => void;
}) {
  const { getToken } = useAuth();
  const { data, error, isLoading, mutate } = useApi<MacroBreakdownData>(
    `/v1/games/${encodeURIComponent(game.id)}/macro-breakdown`,
    { revalidateOnFocus: false },
  );
  const { data: apm, isLoading: apmLoading, error: apmError } =
    useApi<ApmCurveData>(
      `/v1/games/${encodeURIComponent(game.id)}/apm-curve`,
      { revalidateOnFocus: false },
    );
  const {
    data: buildOrder,
    isLoading: buildOrderLoading,
    error: buildOrderError,
  } = useApi<BuildOrderResp>(
    `/v1/games/${encodeURIComponent(game.id)}/build-order`,
    { revalidateOnFocus: false },
  );

  const [recomputing, setRecomputing] = useState(false);
  const [recomputeMsg, setRecomputeMsg] = useState<string | null>(null);

  useEffect(() => {
    setRecomputing(false);
    setRecomputeMsg(null);
  }, [game.id]);

  const recompute = useCallback(async () => {
    if (recomputing) return;
    setRecomputeMsg(null);
    setRecomputing(true);
    try {
      await apiCall<{ ok: boolean }>(
        getToken,
        `/v1/games/${encodeURIComponent(game.id)}/macro-breakdown`,
        { method: "POST", body: JSON.stringify({}) },
      );
      setRecomputeMsg(
        "Recompute requested. If your desktop agent is online and listening, it'll re-upload shortly. If nothing changes after a minute, open the agent app and click Resync — that re-parses every replay on disk.",
      );
      mutate();
    } catch (err) {
      const e = err as { message?: string };
      setRecomputeMsg(e.message || "Recompute failed.");
    }
    finally {
      window.setTimeout(() => setRecomputing(false), 1500);
    }
  }, [getToken, game.id, mutate, recomputing]);

  const myRace = coerceRace(game.my_race ?? data?.race ?? null);
  const oppRace = coerceRace(game.opp_race);
  const effectiveMacroScore =
    typeof data?.macro_score === "number"
      ? data.macro_score
      : (game.macro_score ?? null);

  const macroNotComputed = isNotComputedError(error) || data?.ok === false;
  const macroFatalError = error && !isNotComputedError(error);

  return (
    <div className="space-y-4">
      <BackBar onBack={onBack} />

      <GameSummaryCard
        game={game}
        myRace={myRace}
        oppRace={oppRace}
        macroScore={effectiveMacroScore}
        onRecompute={recompute}
        recomputing={recomputing}
        macroAvailable={!macroNotComputed && !!data}
      />

      {recomputeMsg ? (
        <p
          className="rounded-lg border border-border bg-bg-elevated/60 px-3 py-2 text-caption text-text-muted"
          role="status"
        >
          {recomputeMsg}
        </p>
      ) : null}

      <BuildOrderCard
        data={buildOrder}
        isLoading={buildOrderLoading}
        error={buildOrderError?.message}
        gameId={game.id}
        myRace={myRace}
        oppRace={oppRace}
      />

      <ApmCard
        apm={apm ?? null}
        isLoading={apmLoading}
        error={apmError?.message}
        myRace={myRace}
      />

      <MacroChartGroup
        data={data ?? null}
        isLoading={isLoading}
        notComputed={!!macroNotComputed}
        fatalError={macroFatalError ? error : undefined}
        recomputing={recomputing}
        onRecompute={recompute}
        myRace={myRace}
      />
    </div>
  );
}

function BackBar({ onBack }: { onBack: () => void }) {
  return (
    <div className="lg:hidden">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex min-h-[44px] items-center gap-1 rounded-md px-2 py-1 text-caption uppercase tracking-wider text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden />
        All replays
      </button>
    </div>
  );
}

function isNotComputedError(err: ClientApiError | undefined): boolean {
  if (!err) return false;
  if (err.status === 404) return true;
  if (err.code === "macro_not_computed" || err.code === "game_not_found") return true;
  return false;
}

function GameSummaryCard({
  game,
  myRace,
  oppRace,
  macroScore,
  onRecompute,
  recomputing,
  macroAvailable,
}: {
  game: SelectedGame;
  myRace: Race;
  oppRace: Race;
  macroScore: number | null;
  onRecompute: () => void;
  recomputing: boolean;
  macroAvailable: boolean;
}) {
  const result = (game.result || "").toLowerCase();
  const isWin = ["win", "victory"].includes(result);
  return (
    <Card padded>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-caption text-text-muted">
            <Badge size="sm" variant={isWin ? "success" : "danger"}>
              {isWin ? "Win" : "Loss"}
            </Badge>
            <span className="font-mono text-[11px] text-text-dim">
              {fmtDate(game.date)}
            </span>
            {game.game_length ? (
              <span className="text-[11px] tabular-nums text-text-dim">
                · {fmtMinutes(game.game_length)}
              </span>
            ) : null}
          </div>
          <h3 className="mt-1 truncate text-h4 font-semibold text-text">
            {game.opponent || "Unknown opponent"}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-text-muted">
            <span className="inline-flex items-center gap-1.5">
              <Icon name={raceIconName(myRace)} kind="race" size={14} decorative />
              <span>You · {myRace}</span>
            </span>
            <span className="text-text-dim">vs</span>
            <span className="inline-flex items-center gap-1.5">
              <Icon
                name={raceIconName(oppRace)}
                kind="race"
                size={14}
                decorative
              />
              <span>{oppRace}</span>
            </span>
            {game.map ? (
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3.5 w-3.5" aria-hidden />
                {game.map}
              </span>
            ) : null}
            {game.build ? (
              <Badge size="sm" variant="neutral">
                {game.build}
              </Badge>
            ) : null}
          </div>
        </div>
        <div className="flex flex-shrink-0 flex-col items-end gap-2">
          <SummaryStat
            label="Macro"
            value={macroScore == null ? "—" : macroScore.toFixed(1)}
            tone={
              macroScore == null
                ? "neutral"
                : macroScore >= 75
                  ? "success"
                  : macroScore >= 50
                    ? "warning"
                    : "danger"
            }
          />
          <Button
            variant="secondary"
            size="sm"
            loading={recomputing}
            onClick={onRecompute}
            iconLeft={<RefreshCcw className="h-3.5 w-3.5" aria-hidden />}
            aria-label={
              macroAvailable
                ? "Re-request the macro breakdown for this game"
                : "Ask the desktop agent to compute the macro breakdown for this game"
            }
          >
            {recomputing ? "Recomputing…" : "Recompute"}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function SummaryStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "neutral" | "success" | "warning" | "danger";
}) {
  const toneClass =
    tone === "success"
      ? "text-success"
      : tone === "warning"
        ? "text-warning"
        : tone === "danger"
          ? "text-danger"
          : "text-text";
  return (
    <div className="rounded-lg border border-border bg-bg-elevated px-3 py-2 text-right">
      <div className="text-[10px] uppercase tracking-wider text-text-dim">
        {label}
      </div>
      <div
        className={["text-xl font-semibold tabular-nums", toneClass].join(" ")}
      >
        {value}
      </div>
    </div>
  );
}

function BuildOrderCard({
  data,
  isLoading,
  error,
  gameId,
  myRace,
  oppRace,
}: {
  data: BuildOrderResp | undefined;
  isLoading: boolean;
  error?: string;
  gameId: string;
  myRace: Race;
  oppRace: Race;
}) {
  if (isLoading && !data) {
    return (
      <Card>
        <div className="flex items-center gap-2 text-caption text-text-muted">
          <ListTree className="h-4 w-4 text-accent-cyan" aria-hidden />
          <span className="font-semibold uppercase tracking-wider text-text">
            Build order
          </span>
        </div>
        <div className="mt-3">
          <Skeleton rows={4} />
        </div>
      </Card>
    );
  }
  if (error) {
    return (
      <Card title="Build order">
        <p className="text-caption text-danger">{error}</p>
      </Card>
    );
  }
  if (!data) return null;
  const events = data.events || [];
  const oppEvents = data.opp_events || [];
  return (
    <BuildOrderTimeline
      events={events}
      oppEvents={oppEvents}
      defaultPerspective="you"
      gameId={gameId}
      race={data.my_race || myRace}
      oppRace={data.opp_race || oppRace}
      title={data.my_build ? `Your build — ${data.my_build}` : "Your build"}
      onSaveAsBuild={async () => {
        // SaveAsBuildButton handles the API call internally via the
        // BuildEditorModal -> PUT /v1/custom-builds/:slug flow.
      }}
    />
  );
}

function ApmCard({
  apm,
  isLoading,
  error,
  myRace,
}: {
  apm: ApmCurveData | null;
  isLoading: boolean;
  error?: string;
  myRace: Race;
}) {
  if (isLoading && !apm) {
    return (
      <Card padded>
        <Skeleton rows={5} />
      </Card>
    );
  }
  if (error) {
    return (
      <Card padded>
        <div className="flex flex-col items-start gap-2 rounded-lg border border-border bg-bg-subtle p-4">
          <div className="inline-flex items-center gap-2 text-caption font-semibold text-accent-cyan">
            <AlertCircle className="h-4 w-4" aria-hidden />
            APM / SPM unavailable
          </div>
          <p className="text-caption text-text-muted">
            The agent hasn't uploaded an APM curve for this replay yet. Open
            the desktop agent and click Resync to push it.
          </p>
        </div>
      </Card>
    );
  }
  return (
    <Card padded>
      <ApmSpmChart data={apm} myPlayerName={null} myRace={myRace} />
    </Card>
  );
}

function MacroChartGroup({
  data,
  isLoading,
  notComputed,
  fatalError,
  recomputing,
  onRecompute,
  myRace,
}: {
  data: MacroBreakdownData | null;
  isLoading: boolean;
  notComputed: boolean;
  fatalError?: ClientApiError;
  recomputing: boolean;
  onRecompute: () => void;
  myRace: Race;
}) {
  if (fatalError) {
    return (
      <Card title="Couldn't load macro charts">
        <EmptyState title="Error" sub={fatalError.message} />
      </Card>
    );
  }

  if (notComputed || !data) {
    if (isLoading) {
      return (
        <Card padded>
          <Skeleton rows={5} />
        </Card>
      );
    }
    return (
      <NotComputedPanel
        recomputing={recomputing}
        onRecompute={onRecompute}
      />
    );
  }

  const samples = data.stats_events ?? [];
  const oppSamples = data.opp_stats_events ?? [];
  const leaks: LeakItem[] = data.all_leaks ?? data.top_3_leaks ?? [];
  const effRace = computeEffectiveRace(myRace, data.raw);
  const chronoTargets = data.raw?.chrono_targets ?? [];
  const showChrono = effRace === "Protoss";

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <Card padded>
        <ActiveArmyChart
          samples={samples}
          oppSamples={oppSamples}
          gameLengthSec={data.game_length_sec}
          leaks={leaks}
          highlightedKey={null}
        />
      </Card>
      <Card padded>
        <ResourcesOverTimeChart
          samples={samples}
          oppSamples={oppSamples}
          gameLengthSec={data.game_length_sec}
        />
      </Card>
      {showChrono ? (
        <Card padded className="xl:col-span-2">
          <ChronoAllocationChart targets={chronoTargets} />
        </Card>
      ) : null}
    </div>
  );
}

function NotComputedPanel({
  onRecompute,
  recomputing,
}: {
  onRecompute: () => void;
  recomputing: boolean;
}) {
  return (
    <Card padded>
      <div className="rounded-lg border border-border bg-bg-elevated/40 p-5">
        <div className="inline-flex items-center gap-2 text-caption font-semibold text-accent-cyan">
          <AlertCircle className="h-4 w-4" aria-hidden />
          Macro breakdown not available for this game yet
        </div>
        <p className="mt-2 text-caption text-text-muted">
          Newer replays upload the breakdown automatically. Older replays were
          synced before that field existed, so the data has to come from your
          desktop agent re-parsing the .SC2Replay file on disk. The build
          order above still works because it comes from the build log the
          agent always uploads.
        </p>
        <p className="mt-2 text-caption text-text-muted">
          The reliable path:{" "}
          <span className="font-semibold text-text">
            open the agent app and click Resync
          </span>{" "}
          — that clears the upload cursor and re-sends every replay,
          including the macro breakdown. Recompute below pings the agent for
          just this one game; if your agent is online and listens for
          per-game requests it'll re-upload, otherwise nothing visible will
          change.
        </p>
        <div className="mt-3">
          <Button
            variant="secondary"
            size="sm"
            loading={recomputing}
            onClick={onRecompute}
            iconLeft={<RefreshCcw className="h-3.5 w-3.5" aria-hidden />}
          >
            {recomputing ? "Recomputing…" : "Recompute this game"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
