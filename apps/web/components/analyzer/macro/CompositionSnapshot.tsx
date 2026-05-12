"use client";

import { useMemo } from "react";
import { Icon } from "@/components/ui/Icon";
import { formatGameClock } from "@/lib/macro";
import { sortedArmyComposition } from "@/lib/sc2-units";
import type { UnitTimelineEntry } from "./MacroBreakdownPanel.types";
import { nearestPriorPoint, type SeriesPoint } from "./activeArmyLayout";
import {
  buildOrderUnitsAt,
  countBuildingsAt,
  countUpgradesAt,
  nearestTimelineEntry,
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
  /**
   * Pre-built per-tick series for the local player. Built once by the
   * parent (``MacroChartSection``) and threaded to both the chart and
   * this snapshot. Each SeriesPoint carries army value, worker count,
   * AND the alive unit composition — so this panel reads the SAME
   * numbers the chart's tooltip shows at the same hovered tick.
   */
  mySeries: SeriesPoint[];
  oppSeries: SeriesPoint[];
  /** Player unit composition timeline (post-downsample wire payload).
   *  Used only to drive the "snapshot time" header (the closest
   *  sample's game clock); the unit composition itself comes from
   *  ``mySeries`` / ``oppSeries`` so the chart and the roster cannot
   *  disagree. */
  unitTimeline?: UnitTimelineEntry[];
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
 * Data sources:
 *   - Unit roster: cumulative units BUILT up to the hovered time,
 *     derived from the build-order stream with morph adjustments
 *     (Hydralisk→Lurker, 2× Templar→Archon, etc.). Matches the
 *     Buildings/Upgrades treatment so the whole roster reads as a
 *     production summary — what the player MACRO'd, not what survived.
 *     Falls back to ``unit_timeline`` alive counts only when no
 *     build-order data is available (legacy slim payloads).
 *   - Worker count: ``stats_events.food_workers`` at the same tick
 *     (alive — workers are constantly replaced, so cumulative built
 *     would be misleading vs. the in-game worker count).
 *   - Building count: per-game ``buildLog`` parsed by the API into
 *     ``events`` / ``opp_events`` — filtered on ``is_building`` and
 *     counted cumulatively (with morph collapse) up to the hovered
 *     time.
 *
 * The build-order fetch is gated on ``gameId``; when null, the
 * roster falls back to whatever ``unit_timeline`` carries. We fetch
 * lazily so opening the panel doesn't pay for the buildings call
 * until the user actually looks at it.
 */
export function CompositionSnapshot({
  mySeries,
  oppSeries,
  unitTimeline,
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
  const hasMySeries = Array.isArray(mySeries) && mySeries.length > 0;
  const hasOppSeries = Array.isArray(oppSeries) && oppSeries.length > 0;
  const lastT = useMemo(() => {
    let m = Number(gameLengthSec) || 0;
    if (hasMySeries) m = Math.max(m, mySeries[mySeries.length - 1].t);
    if (hasOppSeries) m = Math.max(m, oppSeries[oppSeries.length - 1].t);
    return m;
  }, [hasMySeries, hasOppSeries, mySeries, oppSeries, gameLengthSec]);

  const targetT =
    typeof hoveredTime === "number" && Number.isFinite(hoveredTime)
      ? hoveredTime
      : lastT;

  // Army value + worker count come from the chart's pre-built series
  // (``nearestPriorPoint`` snaps to the latest sample at-or-before the
  // hovered tick, matching the chart tooltip's read so the "Army NNN"
  // header in this panel can never disagree with the tooltip above).
  const myPoint = useMemo(
    () => nearestPriorPoint(mySeries, targetT),
    [mySeries, targetT],
  );
  const oppPoint = useMemo(
    () => nearestPriorPoint(oppSeries, targetT),
    [oppSeries, targetT],
  );

  const myWorkers = myPoint?.workers ?? 0;
  const oppWorkers = oppPoint?.workers ?? 0;
  const myArmyValue = myPoint?.army ?? 0;
  const oppArmyValue = oppPoint?.army ?? 0;

  // Units roster: cumulative units built up to ``targetT`` — same
  // semantics as the Buildings / Upgrades rows so the panel reads as a
  // unified production summary. This is what users mean by "macro
  // breakdown": how many of each unit did they MAKE, not how many are
  // alive at this tick. Previously the roster read alive counts off
  // ``unit_timeline``, which caused a Protoss player who built 11
  // Immortals but lost 10 to fights to see "Immortal × 1" — surprising
  // for a row labelled UNITS on a panel labelled MACRO BREAKDOWN.
  // Build order has every construction event, so cumulative-by-name
  // (with morph adjustments — Hydralisk→Lurker, Templar→Archon) is
  // exact for both single-parent and 2-parent morphs.
  const hasBuildOrder = Array.isArray(buildOrderData?.events)
    || Array.isArray(buildOrderData?.opp_events);
  const myUnitsBuilt = useMemo(
    () => buildOrderUnitsAt(buildOrderData?.events ?? [], targetT),
    [buildOrderData, targetT],
  );
  const oppUnitsBuilt = useMemo(
    () => buildOrderUnitsAt(buildOrderData?.opp_events ?? [], targetT),
    [buildOrderData, targetT],
  );

  // Slim payload fallback: when the build-order endpoint hasn't loaded
  // (or this game's blob never carried a buildLog), the only data we
  // have on units is the death-aware ``unit_timeline``. Surface it as
  // a stop-gap so the roster isn't empty — the "alive only" badge
  // tells the user why the count may look low vs. their memory of the
  // game.
  const timelineFallback = useMemo(() => {
    if (hasBuildOrder) return null;
    if (!Array.isArray(unitTimeline) || unitTimeline.length === 0) return null;
    const entry = nearestTimelineEntry(unitTimeline, targetT);
    if (!entry) return null;
    return {
      my: { ...(entry.my || {}) },
      opp: { ...(entry.opp || {}) },
    };
  }, [hasBuildOrder, unitTimeline, targetT]);

  const myComposition = timelineFallback?.my ?? myUnitsBuilt;
  const oppComposition = timelineFallback?.opp ?? oppUnitsBuilt;
  const myUnitsSource: CompositionSource = hasBuildOrder
    ? "build_order"
    : timelineFallback
      ? "timeline"
      : "empty";
  const oppUnitsSource: CompositionSource = myUnitsSource;

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

  const hasTimeline = Array.isArray(unitTimeline) && unitTimeline.length > 0;
  // Header time: snap to whichever side has the later prior sample
  // (matches the chart tooltip's snap rule) so "Hovering 16:30" reads
  // the same on both. Falls back to the unit_timeline entry when the
  // series is empty (slim payload that still has a timeline).
  const snapshotTime = useMemo(() => {
    const candidates: number[] = [];
    if (myPoint) candidates.push(myPoint.t);
    if (oppPoint) candidates.push(oppPoint.t);
    if (candidates.length > 0) {
      return candidates.reduce((best, cand) => (cand > best ? cand : best), 0);
    }
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
  }, [myPoint, oppPoint, hasTimeline, unitTimeline, targetT]);

  const showHint =
    !hasTimeline &&
    Object.keys(myBuildings).length === 0 &&
    Object.keys(oppBuildings).length === 0 &&
    Object.keys(myComposition).length === 0 &&
    Object.keys(oppComposition).length === 0 &&
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
          composition={myComposition}
          unitSource={myUnitsSource}
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
          composition={oppComposition}
          unitSource={oppUnitsSource}
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
   * tells the user how the unit numbers were derived. The default
   * (``build_order``) is cumulative built — same as Buildings /
   * Upgrades — so we omit the badge to keep the row clean. The
   * ``timeline`` fallback (no build-order data on disk) shows alive
   * counts and gets an explicit "alive only" badge so users know why
   * the counts may look low vs. what they remember producing.
   */
  source?: CompositionSource;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-text-dim">
          {label}
        </span>
        {source && source !== "build_order" && source !== "empty" ? (
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
  if (source === "timeline") {
    return (
      <span
        className="rounded bg-bg-elevated px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-warning"
        title="Build-order data isn't available for this game, so these counts are alive-only (units that died are missing). Click Recompute to ask your desktop agent for a full re-upload."
      >
        alive only
      </span>
    );
  }
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


