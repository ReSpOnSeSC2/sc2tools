"use client";

import { useMemo } from "react";
import { Icon } from "@/components/ui/Icon";
import { useApi } from "@/lib/clientApi";
import { formatGameClock } from "@/lib/macro";
import {
  computeArmyValue,
  isBuildingUnit,
  sortedArmyComposition,
} from "@/lib/sc2-units";
import type {
  StatsEvent,
  UnitTimelineEntry,
} from "./MacroBreakdownPanel.types";
import { nearestPoint } from "./activeArmyLayout";

export interface CompositionSnapshotProps {
  gameId: string | null;
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
}

/* ============================================================
 * Build-order shape — matches the GET /v1/games/:id/build-order
 * route on the API (see apps/api/src/services/perGameCompute.js
 * #parseBuildLogLines for the canonical parser).
 * ============================================================ */
interface BuildEvent {
  time: number;
  name: string;
  display?: string;
  is_building?: boolean;
}

interface BuildOrderResponse {
  ok?: boolean;
  events?: BuildEvent[];
  opp_events?: BuildEvent[];
}

/**
 * Live unit + building composition strip beneath the chart. Mirrors
 * sc2replaystats's overview: two side-by-side cards (you / opponent)
 * each showing army-value, workers, the army roster (sorted by cost
 * desc), and the buildings count built so far. As the user hovers
 * the chart above, every count snaps to the matching tick.
 *
 * Data sources:
 *   - Unit roster: ``unit_timeline`` (alive non-worker units sampled
 *     at PlayerStatsEvent cadence — agent v0.5+ uploads).
 *   - Worker count: ``stats_events.food_workers`` at the same tick.
 *   - Building count: per-game ``buildLog`` parsed by the API into
 *     ``events`` / ``opp_events`` — we filter on ``is_building`` and
 *     count cumulatively up to the hovered time.
 *
 * The build-order fetch is gated on ``gameId``; when null the
 * buildings rail just stays empty. We fetch lazily so opening the
 * panel doesn't pay for the buildings call until the user actually
 * looks at it.
 */
export function CompositionSnapshot({
  gameId,
  unitTimeline,
  mySamples,
  oppSamples,
  hoveredTime,
  gameLengthSec,
  myName,
  oppName,
  myRace,
  oppRace,
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

  const entry = useMemo(() => {
    if (!hasTimeline) return null;
    let best = unitTimeline![0];
    let bestD = Math.abs((best.time || 0) - targetT);
    for (let i = 1; i < unitTimeline!.length; i++) {
      const d = Math.abs((unitTimeline![i].time || 0) - targetT);
      if (d < bestD) {
        best = unitTimeline![i];
        bestD = d;
      }
    }
    return best;
  }, [hasTimeline, unitTimeline, targetT]);

  const myWorkers = useMemo(
    () => workersAt(mySamples, targetT),
    [mySamples, targetT],
  );
  const oppWorkers = useMemo(
    () => workersAt(oppSamples, targetT),
    [oppSamples, targetT],
  );

  // Build-order payload — used to derive cumulative building counts
  // at any time T. Both ``events`` and ``opp_events`` share the same
  // shape; the agent's buildLog parser tags every entry with
  // ``is_building``.
  const buildOrder = useApi<BuildOrderResponse>(
    gameId ? `/v1/games/${encodeURIComponent(gameId)}/build-order` : null,
    { revalidateOnFocus: false },
  );

  const myBuildings = useMemo(
    () =>
      countBuildingsAt(buildOrder.data?.events ?? [], targetT, "my"),
    [buildOrder.data, targetT],
  );
  const oppBuildings = useMemo(
    () =>
      countBuildingsAt(buildOrder.data?.opp_events ?? [], targetT, "opp"),
    [buildOrder.data, targetT],
  );

  const my = entry?.my ?? {};
  const opp = entry?.opp ?? {};
  const myArmyValue = computeArmyValue(my);
  const oppArmyValue = computeArmyValue(opp);

  const showHint =
    !hasTimeline &&
    Object.keys(myBuildings).length === 0 &&
    Object.keys(oppBuildings).length === 0 &&
    !buildOrder.isLoading;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-caption text-text-muted">
        <span className="font-semibold uppercase tracking-wider text-text">
          Unit &amp; building roster
        </span>
        <span className="text-[11px] tabular-nums">
          {hoveredTime != null ? "Hovering " : "Game end "}
          <span className="text-text">{formatGameClock(entry?.time ?? targetT)}</span>
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
          composition={my}
          workers={myWorkers}
          armyValue={myArmyValue}
          buildings={myBuildings}
          time={entry?.time ?? targetT}
          buildOrderState={
            buildOrder.isLoading
              ? "loading"
              : buildOrder.error
                ? "error"
                : buildOrder.data
                  ? "ok"
                  : "absent"
          }
        />
        <PlayerStrip
          side="opp"
          name={oppName?.trim() || "Opponent"}
          race={oppRace || ""}
          composition={opp}
          workers={oppWorkers}
          armyValue={oppArmyValue}
          buildings={oppBuildings}
          time={entry?.time ?? targetT}
          buildOrderState={
            buildOrder.isLoading
              ? "loading"
              : buildOrder.error
                ? "error"
                : buildOrder.data
                  ? "ok"
                  : "absent"
          }
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
  workers,
  armyValue,
  buildings,
  time,
  buildOrderState,
}: {
  side: "me" | "opp";
  name: string;
  race: string;
  composition: Record<string, number>;
  workers: number;
  armyValue: number;
  buildings: Record<string, number>;
  time: number;
  buildOrderState: BuildOrderState;
}) {
  const sortedUnits = useMemo(
    () => sortedArmyComposition(composition),
    [composition],
  );
  const sortedBuildings = useMemo(
    () => sortBuildings(buildings),
    [buildings],
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
      </div>
    </section>
  );
}

function RosterRow({
  label,
  chips,
  empty,
}: {
  label: string;
  chips: React.ReactNode[];
  empty: string;
}) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-wider text-text-dim">
        {label}
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

function UnitChip({
  name,
  kind,
  count,
  fallback,
  tone,
}: {
  name: string;
  kind: "unit" | "building";
  count: number;
  fallback: string;
  tone: "neutral" | "building";
}) {
  const toneClass =
    tone === "building"
      ? "bg-bg-elevated/80 ring-1 ring-accent-cyan/30"
      : "bg-bg-elevated";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded ${toneClass} px-2 py-1 text-[12px] tabular-nums text-text`}
      title={`${count} × ${name}`}
    >
      <Icon
        name={name}
        kind={kind}
        size="sm"
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

/**
 * Reduce a build-order timeline into ``{name: count}`` for buildings
 * built up to and including ``t``. The agent's buildLog only records
 * starts (no death events) but for the composition snapshot showing
 * total-built-by-T is the right answer — sc2replaystats's overview
 * shows the same cumulative summary.
 *
 * We accept either ``my_pid`` or ``opp_pid`` lists (caller picks); the
 * canonical building name comes from the agent's catalog so morphs
 * (Hatch → Lair → Hive) appear as their final form when reached. The
 * second parameter is unused here but kept on the signature so a
 * future refactor that splits build orders by side can lean on it
 * without touching every call site.
 */
function countBuildingsAt(
  events: BuildEvent[],
  t: number,
  _side: "my" | "opp",
): Record<string, number> {
  if (!Array.isArray(events) || events.length === 0) return {};
  const counts: Record<string, number> = {};
  // Track 1:1 morph chains so the destination building replaces
  // its predecessor in the count rather than double-counting. Mirrors
  // the agent's UnitTypeChangeEvent handling in event_extractor.py.
  const morphMap: Record<string, string> = {
    Lair: "Hatchery",
    Hive: "Lair",
    OrbitalCommand: "CommandCenter",
    PlanetaryFortress: "CommandCenter",
    GreaterSpire: "Spire",
    LurkerDen: "HydraliskDen",
    LurkerDenMP: "HydraliskDen",
    WarpGate: "Gateway",
  };
  for (const ev of events) {
    if (!ev || !ev.is_building) continue;
    const time = Number(ev.time) || 0;
    if (time > t) break; // events are sorted ascending
    const name = ev.name || ev.display || "";
    if (!name) continue;
    if (!isBuildingUnit(name)) continue;
    const prev = morphMap[name];
    if (prev && (counts[prev] || 0) > 0) {
      counts[prev] = (counts[prev] || 0) - 1;
      if (counts[prev] === 0) delete counts[prev];
    }
    counts[name] = (counts[name] || 0) + 1;
  }
  return counts;
}

/** Sort buildings by descending count, tiebreak by name. */
function sortBuildings(
  buildings: Record<string, number>,
): Array<{ name: string; count: number }> {
  const entries: Array<{ name: string; count: number }> = [];
  for (const [name, count] of Object.entries(buildings || {})) {
    if (!count || count <= 0) continue;
    entries.push({ name, count });
  }
  entries.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.name.localeCompare(b.name);
  });
  return entries;
}
