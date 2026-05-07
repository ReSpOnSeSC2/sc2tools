"use client";

import { useMemo } from "react";
import { Icon } from "@/components/ui/Icon";
import { formatGameClock } from "@/lib/macro";
import {
  computeArmyValue,
  isWorkerUnit,
  sortedArmyComposition,
  workerCount,
} from "@/lib/sc2-units";
import type {
  StatsEvent,
  UnitTimelineEntry,
} from "./MacroBreakdownPanel.types";
import { nearestPoint } from "./activeArmyLayout";

export interface UnitCompositionSnapshotProps {
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

/**
 * "Live" unit-composition strip beneath the chart — mirrors
 * sc2replaystats's overview row. Renders unit icons + counts for
 * each side at the hovered tick, plus a worker pill (Probe / Drone /
 * SCV depending on race) showing the worker count from the matching
 * stats_events sample.
 *
 * When ``hoveredTime`` is null, we show the LAST tick (game-end
 * snapshot) so the section never looks empty. The composition map
 * is filtered through ``sortedArmyComposition`` so workers and
 * buildings drop out and the heaviest non-worker units appear first.
 *
 * Renders nothing when no unit_timeline data is available — older
 * payloads gracefully hide this strip rather than show a fake one.
 */
export function UnitCompositionSnapshot({
  unitTimeline,
  mySamples,
  oppSamples,
  hoveredTime,
  gameLengthSec,
  myName,
  oppName,
  myRace,
  oppRace,
}: UnitCompositionSnapshotProps) {
  const hasTimeline = Array.isArray(unitTimeline) && unitTimeline.length > 0;
  const lastT = useMemo(() => {
    if (hasTimeline) {
      return Math.max(
        0,
        ...unitTimeline!.map((e) => Number(e.time) || 0),
      );
    }
    return Number(gameLengthSec) || 0;
  }, [hasTimeline, unitTimeline, gameLengthSec]);

  const targetT = typeof hoveredTime === "number" && Number.isFinite(hoveredTime)
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

  if (!hasTimeline) {
    return (
      <p className="text-caption text-text-muted">
        Unit-composition snapshots become available once your agent re-uploads
        with the v0.5+ pipeline. Hover the chart above for army value;
        composition appears here when fresh replays land.
      </p>
    );
  }

  const my = entry?.my ?? {};
  const opp = entry?.opp ?? {};
  const myArmyValue = computeArmyValue(my);
  const oppArmyValue = computeArmyValue(opp);

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <PlayerStrip
        side="me"
        name={myName?.trim() || "You"}
        race={myRace || ""}
        composition={my}
        workers={myWorkers}
        armyValue={myArmyValue}
        time={entry?.time ?? targetT}
      />
      <PlayerStrip
        side="opp"
        name={oppName?.trim() || "Opponent"}
        race={oppRace || ""}
        composition={opp}
        workers={oppWorkers}
        armyValue={oppArmyValue}
        time={entry?.time ?? targetT}
      />
    </div>
  );
}

function PlayerStrip({
  side,
  name,
  race,
  composition,
  workers,
  armyValue,
  time,
}: {
  side: "me" | "opp";
  name: string;
  race: string;
  composition: Record<string, number>;
  workers: number;
  armyValue: number;
  time: number;
}) {
  const sorted = useMemo(
    () => sortedArmyComposition(composition),
    [composition],
  );
  const workerName = workerNameForRace(race);
  const accentClass =
    side === "me"
      ? "border-success/50 bg-success/[0.04]"
      : "border-danger/50 bg-danger/[0.04]";
  return (
    <section
      aria-label={`${name} unit composition at ${formatGameClock(time)}`}
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
        <span className="text-text-muted tabular-nums">
          {Math.round(armyValue).toLocaleString()} army
        </span>
      </header>
      <ul className="flex flex-wrap items-start gap-2">
        <li
          className="inline-flex items-center gap-1 rounded bg-bg-elevated px-2 py-1 text-[12px] tabular-nums text-text"
          title={`${workers} ${workerName}s`}
        >
          <Icon
            name={workerName}
            kind="unit"
            size="sm"
            fallback={workerName.slice(0, 1)}
            decorative
          />
          <span className="font-semibold">{workers}</span>
        </li>
        {sorted.length === 0 ? (
          <li className="text-caption text-text-muted">No army units yet.</li>
        ) : (
          sorted.map(({ name: unitName, count }) => (
            <li
              key={unitName}
              className="inline-flex items-center gap-1 rounded bg-bg-elevated px-2 py-1 text-[12px] tabular-nums text-text"
              title={`${count} × ${unitName}`}
            >
              <Icon
                name={unitName}
                kind="unit"
                size="sm"
                fallback={unitName.slice(0, 2)}
                decorative
              />
              <span className="font-semibold">{count}</span>
            </li>
          ))
        )}
      </ul>
    </section>
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

// Re-export so callers can compute composition aggregates without
// importing both files. Keeps the public surface of this module
// self-contained for the snapshot use-case.
export { isWorkerUnit, workerCount };
