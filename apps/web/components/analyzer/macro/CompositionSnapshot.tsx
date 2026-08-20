"use client";

import { useCallback, useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import {
  canonicalSpriteName,
  spriteIconScale,
  spriteIconUrl,
} from "@/lib/spriteSheets";
import { formatGameClock } from "@/lib/macro";
import { humanizeBuildName } from "@/lib/build-events";
import { getUnitCost, sortedArmyComposition } from "@/lib/sc2-units";
import type {
  ProductionBuildingRecord,
  UnitTimelineEntry,
} from "./MacroBreakdownPanel.types";
import { nearestPriorPoint, type SeriesPoint } from "./activeArmyLayout";
import {
  countUpgradesAt,
  deriveBuildingComposition,
  sortByCountDesc,
  upgradeDisplayBase,
  upgradeDisplayTier,
  type BuildEvent,
  type BuildingSource,
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
  /**
   * Per-structure lifetimes (born/died plus lifecycle result) for each
   * side, from the macro breakdown payload. When present, both Buildings
   * rosters remove destroyed structures instead of showing the
   * cumulative-ever-built count.
   */
  myProductionBuildings?: ProductionBuildingRecord[];
  oppProductionBuildings?: ProductionBuildingRecord[];
}

/** Pixel size for unit/building chip icons. Bumped from the catalog
 * "sm" preset (16 px) so the chips remain legible at typical viewing
 * distances on dense rosters. The chip text scales with the icon. */
const CHIP_ICON_PX = 22;

/**
 * Icon size in the tap-to-enlarge detail dialog. The renders are 128 px
 * masters, so this is their native size — anything larger would just
 * upscale a thumbnail, and pulling the 2048² sprite SHEET for a sharper
 * one would mean a multi-hundred-KB download to enlarge a single chip.
 */
const CHIP_DETAIL_ICON_PX = 128;

/** What a chip stands for. Drives the icon source and the count wording. */
type ChipKind = "unit" | "building" | "upgrade";

/**
 * The chip the user tapped, frozen at the moment of the tap. Frozen
 * rather than live because the roster re-snaps as the pointer moves
 * over the chart above: without the freeze, opening a Roach chip and
 * then nudging the mouse would silently renumber the open dialog.
 */
interface ChipDetail {
  name: string;
  kind: ChipKind;
  count: number;
  side: "me" | "opp";
  playerName: string;
  /** Player race, used when the unit catalog has no race of its own. */
  playerRace: string;
  /** Game clock the roster was showing when the chip was tapped. */
  time: number;
  /** Row provenance, so the dialog can repeat the row's caveat. */
  source?: CompositionSource;
}

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
  myProductionBuildings,
  oppProductionBuildings,
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

  // Single source of truth: the chart's mySeries / oppSeries already
  // resolved (army_value preferred, timeline / build-order fallback,
  // composition map baked in). Reading via ``nearestPriorPoint`` gives
  // us the SAME SeriesPoint the chart's tooltip reads, so the army
  // header, the worker count, AND the unit chips below cannot disagree
  // with what the tooltip shows at the hovered tick. Pre-fix, this
  // panel re-derived composition itself with a slightly different
  // time anchor (``hoveredTime`` raw vs the chart's nearest-sample
  // snap) and a different fallback path (no army_value gate, no cap),
  // which is how the 9 200-late-game spike ended up disagreeing with
  // the roster's smaller running count.
  const myPoint = useMemo(
    () => nearestPriorPoint(mySeries, targetT),
    [mySeries, targetT],
  );
  const oppPoint = useMemo(
    () => nearestPriorPoint(oppSeries, targetT),
    [oppSeries, targetT],
  );

  const myComposition = pointComposition(myPoint);
  const oppComposition = pointComposition(oppPoint);
  const myWorkers = myPoint?.workers ?? 0;
  const oppWorkers = oppPoint?.workers ?? 0;
  const myArmyValue = myPoint?.army ?? 0;
  const oppArmyValue = oppPoint?.army ?? 0;

  const myBuildingComp = useMemo(
    () =>
      deriveBuildingComposition({
        buildEvents: buildOrderData?.events ?? [],
        productionBuildings: myProductionBuildings,
        t: targetT,
      }),
    [buildOrderData, myProductionBuildings, targetT],
  );
  const oppBuildingComp = useMemo(
    () =>
      deriveBuildingComposition({
        buildEvents: buildOrderData?.opp_events ?? [],
        productionBuildings: oppProductionBuildings,
        t: targetT,
      }),
    [buildOrderData, oppProductionBuildings, targetT],
  );
  const myBuildings = myBuildingComp.buildings;
  const oppBuildings = oppBuildingComp.buildings;
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

  // One dialog for the whole panel rather than one per chip: only a
  // single chip can be open at a time, and hoisting it here keeps the
  // ~100 chips of a late-game roster from each carrying dialog state.
  const [detail, setDetail] = useState<ChipDetail | null>(null);
  const closeDetail = useCallback(() => setDetail(null), []);

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
        <span className="text-micro tabular-nums">
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
          unitSource={myPoint?.unitsSource ?? "empty"}
          workers={myWorkers}
          armyValue={myArmyValue}
          buildings={myBuildings}
          buildingSource={myBuildingComp.source}
          upgrades={myUpgrades}
          time={snapshotTime}
          buildOrderState={buildOrderState}
          onSelect={setDetail}
        />
        <PlayerStrip
          side="opp"
          name={oppName?.trim() || "Opponent"}
          race={oppRace || ""}
          composition={oppComposition}
          unitSource={oppPoint?.unitsSource ?? "empty"}
          workers={oppWorkers}
          armyValue={oppArmyValue}
          buildings={oppBuildings}
          buildingSource={oppBuildingComp.source}
          upgrades={oppUpgrades}
          time={snapshotTime}
          buildOrderState={buildOrderState}
          onSelect={setDetail}
        />
      </div>

      <ChipDetailDialog detail={detail} onClose={closeDetail} />
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
  buildingSource,
  upgrades,
  time,
  buildOrderState,
  onSelect,
}: {
  side: "me" | "opp";
  name: string;
  race: string;
  composition: Record<string, number>;
  unitSource: CompositionSource;
  workers: number;
  armyValue: number;
  buildings: Record<string, number>;
  buildingSource: BuildingSource;
  upgrades: Record<string, number>;
  time: number;
  buildOrderState: BuildOrderState;
  /** Opens the enlarge dialog for a chip. */
  onSelect: (detail: ChipDetail) => void;
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
  // Everything a chip needs to describe itself in the dialog but that
  // is constant across the whole strip. Bundled so each chip call site
  // stays about the chip.
  const chipContext: ChipContext = useMemo(
    () => ({ side, playerName: name, playerRace: race, time, onSelect }),
    [side, name, race, time, onSelect],
  );
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
            <span className={`mr-1 text-micro uppercase tracking-wider ${labelTone}`}>
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
              ctx={chipContext}
              key="__worker__"
              name={workerName}
              kind="unit"
              count={workers}
              fallback={workerName.slice(0, 1)}
              tone="neutral"
              source={unitSource}
            />,
            ...sortedUnits.map(({ name: unitName, count }) => (
              <UnitChip
                ctx={chipContext}
                key={unitName}
                name={unitName}
                kind="unit"
                count={count}
                fallback={unitName.slice(0, 2)}
                tone="neutral"
                source={unitSource}
              />
            )),
          ]}
        />
        <RosterRow
          label="Buildings"
          // Map the building data source onto the shared badge: "alive"
          // is death-aware (destroyed structures already removed) so it
          // renders no badge, exactly like the unit "timeline" source;
          // "build_order" surfaces the same "deaths not tracked" warning
          // the units row uses.
          source={buildingSource === "alive" ? "timeline" : "build_order"}
          empty={
            buildOrderState === "loading"
              ? "Loading…"
              : buildOrderState === "error"
                ? "Couldn't load build order"
                : buildOrderState === "absent"
                  ? "Buildings unavailable for this game"
                  : buildingSource === "alive"
                    ? "No buildings on the field at this time"
                    : "No buildings yet"
          }
          chips={sortedBuildings.map(({ name: buildingName, count }) => (
            <UnitChip
              ctx={chipContext}
              key={buildingName}
              name={buildingName}
              kind="building"
              count={count}
              fallback={buildingName.slice(0, 2)}
              tone="building"
              source={buildingSource === "alive" ? "timeline" : "build_order"}
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
              ctx={chipContext}
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
        <span className="text-micro uppercase tracking-wider text-text-dim">
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
        className="rounded bg-bg-elevated px-1.5 py-0.5 text-micro uppercase tracking-wider text-text-muted"
        title="Counts come from the build order; deaths are derived from the unit timeline. Most accurate when the v0.5+ agent has uploaded both."
      >
        build order + deaths
      </span>
    );
  }
  if (source === "build_order") {
    return (
      <span
        className="rounded bg-bg-elevated px-1.5 py-0.5 text-micro uppercase tracking-wider text-warning"
        title="Counts come from the build order. Per-tick deaths aren't tracked for this game — re-upload via your v0.5+ agent for death-aware accuracy."
      >
        build order
      </span>
    );
  }
  return null;
}

/**
 * The chip's icon. Units and buildings use the Blender-rendered sprite
 * cutout; upgrades have no 3D render and keep the flat command-card
 * icon, as does anything the sprite manifest doesn't know (Broodling,
 * the Adept phase-shift). A 404 falls back at runtime rather than
 * showing a broken image.
 *
 * Deliberately local to this file: the app-wide ``Icon`` is shared with
 * the optimizer, randomizer, fingerprint card and race chips, so
 * swapping it there would be a far wider blast radius than the army
 * roster the change is actually for.
 */
function ChipIcon({
  name,
  kind,
  side,
  fallback,
  px = CHIP_ICON_PX,
}: {
  name: string;
  kind: ChipKind;
  side: "me" | "opp";
  fallback: string;
  /** Rendered box size. Defaults to the roster chip; the detail dialog
   *  passes the render's native 128 px. */
  px?: number;
}) {
  const sprite = kind === "upgrade" ? null : canonicalSpriteName(name);
  const url = sprite ? spriteIconUrl(sprite, side === "me" ? "blue" : "red") : null;
  const [failed, setFailed] = useState<string | null>(null);
  if (url && failed !== url) {
    // The bake framed structures with a wide transparent margin and
    // units edge-to-edge, so a Nexus drew about two thirds the pixels
    // of the Marine beside it. ``spriteIconScale`` scales the margin
    // away. It is a transform, NOT a width bump: the element keeps its
    // ``px`` layout box, so a denser roster does not reflow and only
    // the (transparent) frame edge spills out.
    const scale = spriteIconScale(sprite);
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt=""
        width={px}
        height={px}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(url)}
        style={{
          width: px,
          height: px,
          transform: scale === 1 ? undefined : `scale(${scale})`,
        }}
        className="shrink-0 object-contain"
      />
    );
  }
  // Flat command-card fallback. No fit correction: those icons are a
  // different asset family and were already cropped tight.
  return (
    <Icon name={name} kind={kind} size={px} fallback={fallback} decorative />
  );
}

/**
 * One roster chip. A BUTTON, not a span: the icon is 22 px and the name
 * lives only in the ``title``, which touch devices never show — so on a
 * phone the chip was an unidentifiable thumbnail. Tapping (or pressing
 * Enter / Space) opens the detail dialog, which names it.
 */
function UnitChip({
  ctx,
  name,
  kind,
  count,
  fallback,
  tone,
  source,
}: {
  ctx: ChipContext;
  name: string;
  kind: ChipKind;
  count: number;
  fallback: string;
  tone: "neutral" | "building" | "upgrade";
  /** Row provenance, repeated in the dialog. */
  source?: CompositionSource;
}) {
  const toneClass =
    tone === "building"
      ? "bg-bg-elevated/80 ring-1 ring-accent-cyan/30"
      : tone === "upgrade"
        ? "bg-bg-elevated/80 ring-1 ring-accent/30"
        : "bg-bg-elevated";
  const label = chipLabel(name, kind, count);
  return (
    <button
      type="button"
      // ``py-1.5`` on touch and the original ``py-1`` from sm up: the
      // desktop roster keeps its density while the tap target clears
      // the ~32 px the chip needs to be reliably hittable.
      className={`inline-flex touch-manipulation items-center gap-1.5 rounded ${toneClass} px-2 py-1.5 text-[13px] tabular-nums text-text transition-colors hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:py-1`}
      title={label}
      aria-label={label}
      aria-haspopup="dialog"
      onClick={() =>
        ctx.onSelect({
          name,
          kind,
          count,
          side: ctx.side,
          playerName: ctx.playerName,
          playerRace: ctx.playerRace,
          time: ctx.time,
          source,
        })
      }
    >
      <ChipIcon name={name} kind={kind} side={ctx.side} fallback={fallback} />
      <span className="font-semibold">{count}</span>
    </button>
  );
}

/** Strip-wide context every chip in a strip shares. */
interface ChipContext {
  side: "me" | "opp";
  playerName: string;
  playerRace: string;
  time: number;
  onSelect: (detail: ChipDetail) => void;
}

/**
 * Tap-to-enlarge dialog. Answers the two things a 22 px chip cannot:
 * WHAT it is (the roster is 3D renders, and a Robotics Bay at 22 px is
 * not obviously a Robotics Bay) and what its number means.
 *
 * Rendered once for the whole panel, from state the chip froze on tap.
 */
function ChipDetailDialog({
  detail,
  onClose,
}: {
  detail: ChipDetail | null;
  onClose: () => void;
}) {
  if (!detail) return null;
  const { name, kind, count, side, playerName, playerRace, time } = detail;
  // Upgrades are not in the unit catalog and have no cost row.
  const cost = kind === "upgrade" ? null : getUnitCost(name);
  const race = raceLabel(cost?.race ?? playerRace);
  const displayName = chipDisplayName(name, kind);
  const subtitle = [playerName, KIND_WORD[kind], race, formatGameClock(time)]
    .filter(Boolean)
    .join(" · ");
  const totalCost =
    cost && count > 1
      ? { m: cost.m * count, g: cost.g * count, s: cost.s * count }
      : null;
  const caveat = SOURCE_CAVEAT[detail.source ?? "timeline"];

  return (
    <Modal
      open
      onClose={onClose}
      title={displayName}
      description={subtitle}
      size="sm"
      mobileLayout="center"
    >
      <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start sm:gap-5">
        <div
          className={`flex h-40 w-40 shrink-0 items-center justify-center rounded-lg border ${
            side === "me" ? "border-success/40" : "border-danger/40"
          } bg-bg-elevated`}
        >
          <ChipIcon
            name={name}
            kind={kind}
            side={side}
            fallback={name.slice(0, 2)}
            px={CHIP_DETAIL_ICON_PX}
          />
        </div>
        <dl className="w-full min-w-0 space-y-2 text-caption">
          <DetailRow
            label={kind === "upgrade" ? "Status" : "Count"}
            value={chipCountLabel(name, kind, count)}
          />
          {cost ? (
            <DetailRow label="Cost each" value={costLine(cost.m, cost.g, cost.s)} />
          ) : null}
          {totalCost ? (
            <DetailRow
              label="Total"
              value={costLine(totalCost.m, totalCost.g, totalCost.s)}
            />
          ) : null}
          {caveat ? (
            <p className="pt-1 text-micro text-text-muted">{caveat}</p>
          ) : null}
        </dl>
      </div>
    </Modal>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-border/60 pb-1.5 last:border-0">
      <dt className="text-micro uppercase tracking-wider text-text-dim">
        {label}
      </dt>
      <dd className="tabular-nums text-text">{value}</dd>
    </div>
  );
}

const KIND_WORD: Record<ChipKind, string> = {
  unit: "Unit",
  building: "Structure",
  upgrade: "Upgrade",
};

/** Repeats the row's SourceBadge warning, which has no hover on touch. */
const SOURCE_CAVEAT: Record<CompositionSource, string> = {
  timeline: "",
  empty: "",
  hybrid:
    "Counted from the build order, with deaths taken from the unit timeline.",
  build_order:
    "Counted from the build order — per-tick deaths aren't tracked for this game, so losses may not be subtracted.",
};

/**
 * Chip name for humans: ``CyberneticsCore`` → ``Cybernetics Core``.
 * Tiered upgrades drop the level suffix, because the level is reported
 * separately rather than as part of the name.
 */
function chipDisplayName(name: string, kind: ChipKind): string {
  const base = kind === "upgrade" ? upgradeDisplayBase(name) : name;
  return humanizeBuildName(base) || base;
}

/**
 * What the number on the chip MEANS. For units and structures it is a
 * quantity; for a tiered upgrade ``countUpgradesAt`` reuses the slot to
 * carry the level, so "3" there means +3, not three of them.
 */
function chipCountLabel(name: string, kind: ChipKind, count: number): string {
  if (kind === "upgrade") {
    const tier = upgradeDisplayTier(name);
    return tier ? `Level ${tier}` : "Researched";
  }
  return `${count.toLocaleString()} on the field`;
}

/** Chip tooltip / accessible name: "Roach — 23 on the field". */
function chipLabel(name: string, kind: ChipKind, count: number): string {
  return `${chipDisplayName(name, kind)} — ${chipCountLabel(name, kind, count)}`;
}

/** "75 minerals · 25 gas · 2 supply", dropping whatever is zero. */
function costLine(minerals: number, gas: number, supply: number): string {
  const parts: string[] = [];
  if (minerals > 0) parts.push(`${Math.round(minerals).toLocaleString()} minerals`);
  if (gas > 0) parts.push(`${Math.round(gas).toLocaleString()} gas`);
  // Zerglings and Banelings cost half supply, so a count multiple can
  // land on a half — round to one decimal rather than lying with an int.
  if (supply > 0) parts.push(`${Math.round(supply * 10) / 10} supply`);
  return parts.length > 0 ? parts.join(" · ") : "Free";
}

/** Race letter or full name → full name; "" for Random / unknown. */
function raceLabel(race: string): string {
  const initial = (race || "").charAt(0).toUpperCase();
  if (initial === "Z") return "Zerg";
  if (initial === "T") return "Terran";
  if (initial === "P") return "Protoss";
  return "";
}

function workerNameForRace(race: string): string {
  const r = (race || "").charAt(0).toUpperCase();
  if (r === "Z") return "Drone";
  if (r === "T") return "SCV";
  return "Probe";
}

/**
 * Read the alive unit composition out of a SeriesPoint, returning a
 * fresh empty object when the point is null. Returning an empty
 * object (rather than null) keeps the downstream renderers
 * branch-free.
 */
function pointComposition(
  point: SeriesPoint | null,
): Record<string, number> {
  if (!point || !point.units) return {};
  return point.units;
}

