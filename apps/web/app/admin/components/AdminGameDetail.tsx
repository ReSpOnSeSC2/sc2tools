"use client";

import { useApi } from "@/lib/clientApi";
import { Card, Skeleton } from "@/components/ui/Card";
import { BuildOrderTimeline } from "@/components/analyzer/charts/BuildOrderTimeline";
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

/**
 * Shared admin per-game detail renderer — build order and macro
 * breakdown for a single game owned by an arbitrary user.
 *
 * Used by both the per-user opponent drill-down
 * (``/admin/users/[userId]/opponents/[pulseId]``) and the platform-wide
 * player profile (``/admin/global/players/[pulseId]``). Both fetch the
 * same ``/admin/users/<userId>/games/<gameId>/*`` endpoints, so the
 * fetching + rendering lives here once rather than being duplicated.
 */

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

/**
 * Minimal game shape this component needs. Both
 * ``AdminGameVsOpponentRow`` and ``GlobalPlayerGameRow`` satisfy it
 * structurally, so either page can pass its own row type unchanged.
 */
export type AdminGameDetailGame = {
  gameId: string;
  date: string | null;
  result: string | null;
  myRace: string | null;
  map: string | null;
  durationSec: number | null;
  myMmr: number | null;
  macroScore: number | null;
  opponent: { displayName: string; race: string; mmr: number | null };
};

export function fmtDuration(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec) || sec <= 0) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

export function isWin(result: string | null): boolean {
  return ["win", "victory"].includes((result || "").toLowerCase());
}

export function AdminGameDetail({
  userId,
  game,
  onBack,
}: {
  userId: string;
  game: AdminGameDetailGame;
  onBack: () => void;
}) {
  const base = `/v1/admin/users/${encodeURIComponent(
    userId,
  )}/games/${encodeURIComponent(game.gameId)}`;

  const { data, error, isLoading } = useApi<BuildOrderResp>(
    `${base}/build-order`,
    { revalidateOnFocus: false },
  );
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
