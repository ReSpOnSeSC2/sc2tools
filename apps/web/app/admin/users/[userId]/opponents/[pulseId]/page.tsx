"use client";

import { use, useState } from "react";
import Link from "next/link";

import { useApi } from "@/lib/clientApi";
import { Card, Skeleton } from "@/components/ui/Card";
import { BuildOrderTimeline } from "@/components/analyzer/charts/BuildOrderTimeline";
import { ApmSpmChart, type ApmCurveData } from "@/components/analyzer/charts/ApmSpmChart";
import { ResourcesOverTimeChart } from "@/components/analyzer/charts/ResourcesOverTimeChart";
import { ChronoAllocationChart } from "@/components/analyzer/charts/ChronoAllocationChart";
import { ActiveArmyChart } from "@/components/analyzer/macro/ActiveArmyChart";
import { buildSeries } from "@/components/analyzer/macro/activeArmyLayout";
import type {
  LeakItem,
  MacroBreakdownData,
} from "@/components/analyzer/macro/MacroBreakdownPanel.types";
import { computeEffectiveRace } from "@/lib/macro";
import { coerceRace, type Race } from "@/lib/race";
import type { BuildOrderEvent } from "@/lib/build-events";
import { ForbiddenCard, LoadingRows } from "../../../../components/AdminFragments";
import type {
  AdminGameVsOpponentRow,
  OpponentGamesResp,
} from "../../../../components/adminTypes";

const PAGE_SIZE = 50;

// Mirrors the /build-order response shape (same as the user-facing
// /v1/games/:gameId/build-order endpoint the per-game inspector uses).
type BuildOrderResp = {
  ok?: boolean;
  my_build?: string | null;
  my_race?: string | null;
  opp_race?: string | null;
  events?: BuildOrderEvent[];
  opp_events?: BuildOrderEvent[];
};

function fmtDuration(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec) || sec <= 0) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function isWin(result: string | null): boolean {
  return ["win", "victory"].includes((result || "").toLowerCase());
}

/**
 * /admin/users/[userId]/opponents/[pulseId] — every game the user
 * played against one opponent, with each game's full build order
 * (player + opponent) rendered exactly like the user's own replay
 * view (reuses BuildOrderTimeline).
 *
 * Master/detail: games list on the left, the selected game's build
 * order on the right. On mobile the two swap so only one shows at a
 * time, with a back affordance.
 */
export default function AdminOpponentGamesPage({
  params,
}: {
  params: Promise<{ userId: string; pulseId: string }>;
}) {
  const { userId, pulseId } = use(params);

  const [before, setBefore] = useState<string | null>(null);
  const [pageHistory, setPageHistory] = useState<Array<string | null>>([null]);
  const [selected, setSelected] = useState<AdminGameVsOpponentRow | null>(null);

  const query = new URLSearchParams();
  query.set("limit", String(PAGE_SIZE));
  if (before) query.set("before", before);
  const path = `/v1/admin/users/${encodeURIComponent(
    userId,
  )}/opponents/${encodeURIComponent(pulseId)}/games?${query.toString()}`;

  const { data, error, isLoading } = useApi<OpponentGamesResp>(path);

  function nextPage() {
    if (data?.nextBefore) {
      setPageHistory((h) => [...h, data.nextBefore]);
      setBefore(data.nextBefore);
      setSelected(null);
    }
  }
  function prevPage() {
    if (pageHistory.length <= 1) return;
    const popped = pageHistory.slice(0, -1);
    setPageHistory(popped);
    setBefore(popped[popped.length - 1] ?? null);
    setSelected(null);
  }

  if (error && error.status === 403) return <ForbiddenCard />;

  const oppName = data?.items[0]?.opponent.displayName || "";

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <Link
          href={`/admin/users/${encodeURIComponent(userId)}/opponents`}
          className="text-caption text-text-dim hover:text-text"
        >
          ← All opponents
        </Link>
        <h1 className="text-3xl font-bold">{oppName || "Opponent"}</h1>
        <p className="break-all font-mono text-caption text-text-dim">
          {pulseId}
        </p>
        <p className="text-text-muted">
          Every game this user played against this opponent. Click a game
          to see both build orders, just like the user&apos;s own replay.
        </p>
      </header>

      {isLoading ? (
        <LoadingRows rows={8} />
      ) : error ? (
        <Card padded>
          <p className="text-danger">Failed to load games: {error.message}</p>
        </Card>
      ) : !data || data.items.length === 0 ? (
        <Card padded>
          <p className="text-text-muted">
            No games recorded against this opponent.
          </p>
        </Card>
      ) : (
        <div className="lg:grid lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)] lg:gap-4">
          {/* Games list — hidden on mobile once a game is selected. */}
          <div className={selected ? "hidden lg:block" : "block"}>
            <Card padded={false}>
              <ul className="divide-y divide-border">
                {data.items.map((g) => {
                  const active = selected?.gameId === g.gameId;
                  return (
                    <li key={g.gameId}>
                      <button
                        type="button"
                        onClick={() => setSelected(g)}
                        className={[
                          "flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors",
                          active
                            ? "bg-accent/10"
                            : "hover:bg-bg-elevated/40",
                        ].join(" ")}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={[
                              "rounded-full px-2 py-0.5 text-caption font-semibold",
                              isWin(g.result)
                                ? "bg-success/15 text-success"
                                : "bg-danger/15 text-danger",
                            ].join(" ")}
                          >
                            {isWin(g.result) ? "Win" : "Loss"}
                          </span>
                          <span className="text-caption text-text-dim">
                            {fmtDate(g.date)}
                          </span>
                        </div>
                        <div className="text-caption text-text-muted">
                          {(g.myRace || "?")[0]}v{(g.opponent.race || "?")[0]}
                          {" · "}
                          {g.map || "—"}
                          {" · "}
                          {fmtDuration(g.durationSec)}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Card>

            <div className="mt-3 flex items-center justify-between gap-3">
              <button
                type="button"
                className="btn btn-secondary text-sm disabled:cursor-not-allowed disabled:opacity-50"
                disabled={pageHistory.length <= 1}
                onClick={prevPage}
              >
                ← Previous
              </button>
              <span className="text-caption text-text-dim">
                {data.items.length} on this page
              </span>
              <button
                type="button"
                className="btn btn-secondary text-sm disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!data.nextBefore}
                onClick={nextPage}
              >
                Next →
              </button>
            </div>
          </div>

          {/* Detail — hidden on mobile until a game is selected. */}
          <div className={selected ? "block" : "hidden lg:block"}>
            {selected ? (
              <GameDetail
                userId={userId}
                game={selected}
                onBack={() => setSelected(null)}
              />
            ) : (
              <Card padded>
                <p className="text-text-muted">
                  Select a game to view its build orders.
                </p>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function GameDetail({
  userId,
  game,
  onBack,
}: {
  userId: string;
  game: AdminGameVsOpponentRow;
  onBack: () => void;
}) {
  const base = `/v1/admin/users/${encodeURIComponent(
    userId,
  )}/games/${encodeURIComponent(game.gameId)}`;

  const { data, error, isLoading } = useApi<BuildOrderResp>(
    `${base}/build-order`,
    { revalidateOnFocus: false },
  );
  const apm = useApi<ApmCurveData>(`${base}/apm-curve`, {
    revalidateOnFocus: false,
  });
  const macro = useApi<MacroBreakdownData>(`${base}/macro-breakdown`, {
    revalidateOnFocus: false,
  });

  const myRace = coerceRace(data?.my_race || game.myRace);
  const oppRace = coerceRace(data?.opp_race || game.opponent.race);

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="text-caption text-text-dim hover:text-text lg:hidden"
      >
        ← Back to games
      </button>

      <Card padded>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-text-muted">
          <span
            className={[
              "rounded-full px-2 py-0.5 font-semibold",
              isWin(game.result)
                ? "bg-success/15 text-success"
                : "bg-danger/15 text-danger",
            ].join(" ")}
          >
            {isWin(game.result) ? "Win" : "Loss"}
          </span>
          <span className="font-mono text-text-dim">{fmtDate(game.date)}</span>
          <span>{game.map || "—"}</span>
          <span>{fmtDuration(game.durationSec)}</span>
          {game.myMmr !== null ? <span>You {game.myMmr} MMR</span> : null}
          {game.opponent.mmr !== null ? (
            <span>Opp {game.opponent.mmr} MMR</span>
          ) : null}
          {game.macroScore !== null ? (
            <span>Macro {game.macroScore}</span>
          ) : null}
        </div>
      </Card>

      {isLoading && !data ? (
        <Card padded>
          <Skeleton rows={4} />
        </Card>
      ) : error ? (
        <Card padded>
          <p className="text-caption text-danger">
            {error.status === 404
              ? "No build order stored for this game (the agent hasn't uploaded it)."
              : `Failed to load build order: ${error.message}`}
          </p>
        </Card>
      ) : data ? (
        <BuildOrderTimeline
          events={data.events || []}
          oppEvents={data.opp_events || []}
          defaultPerspective="you"
          gameId={game.gameId}
          race={myRace}
          oppRace={oppRace}
          title={data.my_build ? `Build — ${data.my_build}` : "Build order"}
        />
      ) : null}

      <ApmPanel
        data={apm.data ?? null}
        isLoading={apm.isLoading}
        notAvailable={apm.error?.status === 404}
        error={apm.error && apm.error.status !== 404 ? apm.error.message : undefined}
        myRace={myRace}
      />

      <MacroPanel
        data={macro.data ?? null}
        isLoading={macro.isLoading}
        notAvailable={macro.error?.status === 404 || macro.data?.ok === false}
        error={
          macro.error && macro.error.status !== 404 ? macro.error.message : undefined
        }
        myRace={myRace}
      />
    </div>
  );
}

function ApmPanel({
  data,
  isLoading,
  notAvailable,
  error,
  myRace,
}: {
  data: ApmCurveData | null;
  isLoading: boolean;
  notAvailable: boolean;
  error?: string;
  myRace: Race;
}) {
  if (isLoading && !data) {
    return (
      <Card padded>
        <Skeleton rows={4} />
      </Card>
    );
  }
  if (error) {
    return (
      <Card padded>
        <p className="text-caption text-danger">APM / SPM: {error}</p>
      </Card>
    );
  }
  if (notAvailable || !data) {
    return (
      <Card padded>
        <p className="text-caption text-text-muted">
          No APM / SPM curve uploaded for this game.
        </p>
      </Card>
    );
  }
  return (
    <Card padded>
      <ApmSpmChart data={data} myPlayerName={null} myRace={myRace} />
    </Card>
  );
}

function MacroPanel({
  data,
  isLoading,
  notAvailable,
  error,
  myRace,
}: {
  data: MacroBreakdownData | null;
  isLoading: boolean;
  notAvailable: boolean;
  error?: string;
  myRace: Race;
}) {
  if (isLoading && !data) {
    return (
      <Card padded>
        <Skeleton rows={5} />
      </Card>
    );
  }
  if (error) {
    return (
      <Card padded>
        <p className="text-caption text-danger">Macro breakdown: {error}</p>
      </Card>
    );
  }
  if (notAvailable || !data) {
    return (
      <Card padded>
        <p className="text-caption text-text-muted">
          No macro breakdown stored for this game (synced before the field
          existed, or not yet re-parsed by the agent).
        </p>
      </Card>
    );
  }

  const samples = data.stats_events ?? [];
  const oppSamples = data.opp_stats_events ?? [];
  const leaks: LeakItem[] = data.all_leaks ?? data.top_3_leaks ?? [];
  const effRace = computeEffectiveRace(myRace, data.raw);
  const chronoTargets = data.raw?.chrono_targets ?? [];
  const gameLengthSec = data.game_length_sec ?? 0;
  const mySeries = buildSeries(samples, data.unit_timeline, "my");
  const oppSeries = buildSeries(oppSamples, data.unit_timeline, "opp");

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <Card padded>
        <ActiveArmyChart
          mySeries={mySeries}
          oppSeries={oppSeries}
          gameLengthSec={gameLengthSec}
          leaks={leaks}
          highlightedKey={null}
        />
      </Card>
      <Card padded>
        <ResourcesOverTimeChart
          samples={samples}
          oppSamples={oppSamples}
          gameLengthSec={gameLengthSec}
        />
      </Card>
      {effRace === "Protoss" ? (
        <Card padded className="xl:col-span-2">
          <ChronoAllocationChart targets={chronoTargets} />
        </Card>
      ) : null}
    </div>
  );
}
