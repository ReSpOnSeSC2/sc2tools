"use client";

import { useMemo } from "react";
import { Icon } from "@/components/ui/Icon";
import { formatGameClock } from "@/lib/macro";
import { computeArmyValue, sortedArmyComposition } from "@/lib/sc2-units";
import type {
  StatsEvent,
  UnitTimelineEntry,
} from "./MacroBreakdownPanel.types";
import { nearestPoint } from "./activeArmyLayout";
import {
  countBuildingsAt,
  countUpgradesAt,
  deriveUnitComposition,
  sortByCountDesc,
  type BuildEvent,
  type CompositionSource,
} from "./compositionAt";

/**
 * Build-order shape — matches the GET /v1/games/:id/build-order
 * route on the API (see apps/api/src/services/perGameCompute.js
 * #parseBuildLogLines for the canonical parser). The fetch itself
 * lives in ``MacroChartSection`` so the chart and the snapshot share a
 * single SWR call and stay consistent across re-renders.
 */
export interface BuildOrderResponse {
  ok?: boolean;
  events?: BuildEvent[];
  opp_events?: BuildEvent[];
}

export interface CompositionSnapshotProps {
  /** Player unit composition timeline (post-downsample wire payload). */
  unitTimeline?: UnitTimelineEntry[];
  /** Player stats samples — supplies the worker count at each tick. */
  mySamples: StatsEvent[];
  oppSamples: StatsEvent[];
  /** Currently hovered game-time second. */
  hoveredTime?: number | null;
  /** Total game length, used for the "latest sample" fallback. */
  gameLengthSec?: number;
  myName?: string | null;
  oppName?: string | null;
  myRace?: string | null;
  oppRace?: string | null;
  /** Build-order payload, fetched and shared by the parent. */
  buildOrderData?: BuildOrderResponse;
  buildOrderLoading?: boolean;
  buildOrderError?: boolean;
}

/** Pixel size for unit/building chip icons. Bumped from the catalog
 * "sm" preset (16 px) so the chips remain legible at typical viewing
 * distances on dense rosters. The chip text scales with the icon. */
const CHIP_ICON_PX = 22;

/**
 * Live unit + building composition strip beneath the chart. Mirrors
 * sc2replaystats's overview: two side-by-side cards (you / opponent)
 * each showing army-value, workers, the army roster (sorted by cost
 * desc), and the buildings count built so far. As the user hovers
 * the chart above, every count snaps to the matching tick.
 *
 * Data sources (see ``compositionAt.ts`` for the resolution order):
 *   - Unit roster: prefers ``unit_timeline`` (death-aware) when
 *     populated; falls back to a build-order-derived cumulative count
 *     with morph adjustments and timeline-derived death subtraction.
 *   - Worker count: ``stats_events.food_workers`` at the same tick.
 *   - Building count: per-game ``buildLog`` parsed by the API into
 *     ``events`` / ``opp_events`` — filtered on ``is_building`` and
 *     counted cumulatively (with morph collapse) up to the hovered
 *     time. The build-order endpoint is the same call that powers the
 *     unit fallback above, so both sources hit a single SWR cache.
 *
 * The build-order fetch is gated on ``gameId``; when null, the
 * roster falls back to whatever ``unit_timeline`` carries. We fetch
 * lazily so opening the panel doesn't pay for the buildings call
 * until the user actually looks at it.
 */
export function CompositionSnapshot({
  unitTimeline,
  mySamples,
  oppSamples,
  hoveredTime,
  gameLengthSec,
  myName,
  oppName,
  myRace,
  oppRace,
  buildOrderData,
  buildOrderLoading,
  buildOrderError,
}: CompositionSnapshotProps) {
  const hasTimeline = Array.isArray(unitTimeline) && unitTimeline.length > 0;
  const lastT = useMemo(() => {
    if (hasTimeline) {
      return Math.max(0, ...unitTimeline!.map((e) => Number(e.time) || 0));
    }
    return Number(gameLengthSec) || 0;
  }, [hasTimeline, unitTimeline, gameLengthSec]);

  const targetT =
    typeof hoveredTime === "number" && Number.isFinite(hoveredTime)
      ? hoveredTime
      : lastT;

  const myWorkers = useMemo(
    () => workersAt(mySamples, targetT),
    [mySamples, targetT],
  );
  const oppWorkers = useMemo(
    () => workersAt(oppSamples, targetT),
    [oppSamples, targetT],
  );

  const myComposition = useMemo(
    () =>
      deriveUnitComposition({
        timeline: unitTimeline,
        buildEvents: buildOrderData?.events,
        side: "my",
        t: targetT,
      }),
    [unitTimeline, buildOrderData, targetT],
  );
  const oppComposition = useMemo(
    () =>
      deriveUnitComposition({
        timeline: unitTimeline,
        buildEvents: buildOrderData?.opp_events,
        side: "opp",
        t: targetT,
      }),
    [unitTimeline, buildOrderData, targetT],
  );

  const myBuildings = useMemo(
    () => countBuildingsAt(buildOrderData?.events ?? [], targetT),
    [buildOrderData, targetT],
  );
  const oppBuildings = useMemo(
    () => countBuildingsAt(buildOrderData?.opp_events ?? [], targetT),
    [buildOrderData, targetT],
  );
  const myUpgrades = useMemo(
    () => countUpgradesAt(buildOrderData?.events ?? [], targetT),
    [buildOrderData, targetT],
  );
  const oppUpgrades = useMemo(
    () => countUpgradesAt(buildOrderData?.opp_events ?? [], targetT),
    [buildOrderData, targetT],
  );

  const myArmyValue = computeArmyValue(myComposition.units);
  const oppArmyValue = computeArmyValue(oppComposition.units);

  // Resolve the snapshot time to display in the header. unit_timeline
  // entries snap to the agent's sample grid; without one, just use t.
  const snapshotTime = useMemo(() => {
    if (!hasTimeline) return targetT;
    let best = unitTimeline![0].time || 0;
    let bestD = Math.abs(best - targetT);
    for (let i = 1; i < unitTimeline!.length; i++) {
      const time = unitTimeline![i].time || 0;
      const d = Math.abs(time - targetT);
      if (d < bestD) {
        best = time;
        bestD = d;
      }
    }
    return best;
  }, [hasTimeline, unitTimeline, targetT]);

  const showHint =
    !hasTimeline &&
    Object.keys(myBuildings).length === 0 &&
    Object.keys(oppBuildings).length === 0 &&
    Object.keys(myComposition.units).length === 0 &&
    Object.keys(oppComposition.units).length === 0 &&
    Object.keys(myUpgrades).length === 0 &&
    Object.keys(oppUpgrades).length === 0 &&
    !buildOrderLoading;

  const buildOrderState: BuildOrderState = buildOrderLoading
    ? "loading"
    : buildOrderError
      ? "error"
      : buildOrderData
        ? "ok"
        : "absent";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-caption text-text-muted">
        <span className="font-semibold uppercase tracking-wider text-text">
          Unit &amp; building roster
        </span>
        <span className="text-[11px] tabular-nums">
          {hoveredTime != null ? "Hovering " : "Game end "}
          <span className="text-text">{formatGameClock(snapshotTime)}</span>
        </span>
      </div>

      {showHint ? (
        <p className="text-caption text-text-muted">
          Per-tick composition becomes available after your agent
          re-uploads on the v0.5+ pipeline. The chart and worker line
          above don&apos;t require v0.5+ — they fill in as soon as
          any agent build syncs the game.
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <PlayerStrip
          side="me"
          name={myName?.trim() || "You"}
          race={myRace || ""}
          composition={myComposition.units}
          unitSource={myComposition.source}
          workers={myWorkers}
          armyValue={myArmyValue}
          buildings={myBuildings}
          upgrades={myUpgrades}
          time={snapshotTime}
          buildOrderState={buildOrderState}
        />
        <PlayerStrip
          side="opp"
          name={oppName?.trim() || "Opponent"}
          race={oppRace || ""}
          composition={oppComposition.units}
          unitSource={oppComposition.source}
          workers={oppWorkers}
          armyValue={oppArmyValue}
          buildings={oppBuildings}
          upgrades={oppUpgrades}
          time={snapshotTime}
          buildOrderState={buildOrderState}
        />
      </div>
    </div>
  );
}

type BuildOrderState = "ok" | "loading" | "error" | "absent";

function PlayerStrip({
  side,
  name,
  race,
  composition,
  unitSource,
  workers,
  armyValue,
  buildings,
  upgrades,
  time,
  buildOrderState,
}: {
  side: "me" | "opp";
  name: string;
  race: string;
  composition: Record<string, number>;
  unitSource: CompositionSource;
  workers: number;
  armyValue: number;
  buildings: Record<string, number>;
  upgrades: Record<string, number>;
  time: number;
  buildOrderState: BuildOrderState;
}) {
  const sortedUnits = useMemo(
    () => sortedArmyComposition(composition),
    [composition],
  );
  const sortedBuildings = useMemo(
    () => sortByCountDesc(buildings),
    [buildings],
  );
  const sortedUpgrades = useMemo(
    () => sortByCountDesc(upgrades),
    [upgrades],
  );
  const workerName = workerNameForRace(race);
  const accentClass =
    side === "me"
      ? "border-success/50 bg-success/[0.04]"
      : "border-danger/50 bg-danger/[0.04]";
  const labelTone = side === "me" ? "text-success" : "text-danger";

  return (
    <section
      aria-label={`${name} composition at ${formatGameClock(time)}`}
      className={`rounded-md border ${accentClass} p-3`}
    >
      <header className="mb-2 flex items-baseline justify-between gap-2 text-caption">
        <span className="flex min-w-0 items-center gap-2">
          {race ? (
            <Icon
              name={race.charAt(0).toUpperCase()}
              kind="race"
              size="sm"
              fallback={race.charAt(0).toUpperCase()}
              decorative
            />
          ) : null}
          <span className="truncate font-semibold text-text">{name}</span>
        </span>
        <span className="flex items-baseline gap-2 tabular-nums text-text-muted">
          <span>
            <span className={`mr-1 text-[10px] uppercase tracking-wider ${labelTone}`}>
              army
            </span>
            <span className="font-semibold text-text">
              {Math.round(armyValue).toLocaleString()}
            </span>
          </span>
        </span>
      </header>

      <div className="space-y-2">
        <RosterRow
          label="Units"
          empty="No army units"
          source={unitSource}
          chips={[
            <UnitChip
              key="__worker__"
              name={workerName}
              kind="unit"
              count={workers}
              fallback={workerName.slice(0, 1)}
              tone="neutral"
            />,
            ...sortedUnits.map(({ name: unitName, count }) => (
              <UnitChip
                key={unitName}
                name={unitName}
                kind="unit"
                count={count}
                fallback={unitName.slice(0, 2)}
                tone="neutral"
              />
            )),
          ]}
        />
        <RosterRow
          label="Buildings"
          empty={
            buildOrderState === "loading"
              ? "Loading…"
              : buildOrderState === "error"
                ? "Couldn't load build order"
                : buildOrderState === "absent"
                  ? "Buildings unavailable for this game"
                  : "No buildings yet"
          }
          chips={sortedBuildings.map(({ name: buildingName, count }) => (
            <UnitChip
              key={buildingName}
              name={buildingName}
              kind="building"
              count={count}
              fallback={buildingName.slice(0, 2)}
              tone="building"
            />
          ))}
        />
        <RosterRow
          label="Upgrades"
          empty={
            buildOrderState === "loading"
              ? "Loading…"
              : "No upgrades yet"
          }
          chips={sortedUpgrades.map(({ name: upgradeName, count }) => (
            <UnitChip
              key={upgradeName}
              name={upgradeName}
              kind="upgrade"
              count={count}
              fallback={upgradeName.slice(0, 2)}
              tone="upgrade"
            />
          ))}
        />
      </div>
    </section>
  );
}

function RosterRow({
  label,
  chips,
  empty,
  source,
}: {
  label: string;
  chips: React.ReactNode[];
  empty: string;
  /**
   * When provided, surfaces a small badge next to the row label that
   * tells the user how the data was derived. ``hybrid`` and
   * ``build_order`` mean we filled in from the build order — the chip
   * count may include units whose deaths the timeline didn't capture.
   */
  source?: CompositionSource;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-text-dim">
          {label}
        </span>
        {source && source !== "timeline" && source !== "empty" ? (
          <SourceBadge source={source} />
        ) : null}
      </div>
      <ul className="flex flex-wrap items-center gap-1.5">
        {chips.length === 0 ? (
          <li className="text-caption text-text-muted">{empty}</li>
        ) : (
          chips.map((chip, idx) => <li key={idx}>{chip}</li>)
        )}
      </ul>
    </div>
  );
}

function SourceBadge({ source }: { source: CompositionSource }) {
  if (source === "hybrid") {
    return (
      <span
        className="rounded bg-bg-elevated px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-text-muted"
        title="Counts come from the build order; deaths are derived from the unit timeline. Most accurate when the v0.5+ agent has uploaded both."
      >
        build order + deaths
      </span>
    );
  }
  if (source === "build_order") {
    return (
      <span
        className="rounded bg-bg-elevated px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-warning"
        title="Counts come from the build order. Per-tick deaths aren't tracked for this game — re-upload via your v0.5+ agent for death-aware accuracy."
      >
        build order
      </span>
    );
  }
  return null;
}

function UnitChip({
  name,
  kind,
  count,
  fallback,
  tone,
}: {
  name: string;
  kind: "unit" | "building" | "upgrade";
  count: number;
  fallback: string;
  tone: "neutral" | "building" | "upgrade";
}) {
  const toneClass =
    tone === "building"
      ? "bg-bg-elevated/80 ring-1 ring-accent-cyan/30"
      : tone === "upgrade"
        ? "bg-bg-elevated/80 ring-1 ring-accent/30"
        : "bg-bg-elevated";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded ${toneClass} px-2 py-1 text-[13px] tabular-nums text-text`}
      title={`${count} × ${name}`}
    >
      <Icon
        name={name}
        kind={kind}
        size={CHIP_ICON_PX}
        fallback={fallback}
        decorative
      />
      <span className="font-semibold">{count}</span>
    </span>
  );
}

function workerNameForRace(race: string): string {
  const r = (race || "").charAt(0).toUpperCase();
  if (r === "Z") return "Drone";
  if (r === "T") return "SCV";
  return "Probe";
}

/** Worker count at ``t`` from the closest stats_events sample. */
function workersAt(samples: StatsEvent[], t: number): number {
  if (!Array.isArray(samples) || samples.length === 0) return 0;
  const series = samples.map((s) => ({
    t: Math.round(Number(s.time) || 0),
    army: 0,
    workers: Number(s.food_workers) || 0,
  }));
  const nearest = nearestPoint(series, t);
  return nearest ? nearest.workers : 0;
}

