/**
 * The selected /try game's detail data, in the shapes the analyzer's own
 * components take — all from the local payload, so nothing is fetched
 * (the /try page never calls the API). Imported only by the lazily
 * loaded game detail, so the build-event and icon tables stay out of the
 * page's first load.
 *
 *   offlineBuildEvents — `[m:ss] Name` lines → build events, with the
 *                        same cosmetic-line filter the API applies
 *   gameBuilds         — both sides' build events + labels
 *   macroChartProps    — the macro timeline's props from `macroBreakdown`
 *                        plus both build orders; null when the game has
 *                        no stats samples
 *
 * Example:
 *   const builds = gameBuilds(payload);
 *   const chart = macroChartProps(payload, builds);
 */
import type { BuildOrderResponse } from "@/components/analyzer/macro/CompositionSnapshot";
import type { MacroChartSectionProps } from "@/components/analyzer/macro/MacroChartSection";
import type { StatsEvent } from "@/components/analyzer/macro/MacroBreakdownPanel.types";
import { readGameApm } from "@/lib/apm";
import { buildLogToEvents, type BuildOrderEvent } from "@/lib/build-events";
import { selectLeaks } from "@/lib/macro";
import type { InstantPayload } from "./reportPayload";

/**
 * Cosmetic build-log lines (reward dances, beacons, sprays). Same rule
 * as the API's `BUILD_LOG_NOISE_RE` (apps/api perGameCompute.js), which
 * feeds the analyzer's build-order columns, and `lib/build-rules.ts`.
 */
export const BUILD_LOG_NOISE_RE = /^(Beacon|Reward|Spray)/;
/** `[m:ss] Name` — the same line shape `buildLogToEvents` parses. */
const BUILD_LOG_LINE_RE = /^\[\d+:\d{2}\]\s+(.+?)\s*$/;

export type BuildStatus = "ok" | "empty";

export interface GameBuilds {
  myEvents: BuildOrderEvent[];
  oppEvents: BuildOrderEvent[];
  myStatus: BuildStatus;
  oppStatus: BuildStatus;
  /** Your detected build, or null. */
  myLabel: string | null;
  /** The opponent's detected strategy, or null. */
  oppLabel: string | null;
}

/**
 * `MacroChartSection`'s props minus the API-bound `gameId`, plus the
 * build order it would have fetched (parsed here from the payload).
 */
export interface OfflineMacroChartProps extends Omit<MacroChartSectionProps, "gameId" | "highlightedKey"> {
  buildOrder: BuildOrderResponse;
}

/**
 * Build-log lines minus cosmetic ones (reward dances, beacons, sprays).
 *
 * Example:
 *   withoutCosmeticLines(["[0:00] RewardDanceStalker", "[0:18] Pylon"]); // -> ["[0:18] Pylon"]
 */
export function withoutCosmeticLines(lines: ReadonlyArray<string>): string[] {
  return lines.filter((line) => {
    const name = BUILD_LOG_LINE_RE.exec(line)?.[1] ?? "";
    return !BUILD_LOG_NOISE_RE.test(name);
  });
}

/**
 * Build events for `BuildOrderColumns` from `[m:ss] Name` lines:
 * cosmetic lines dropped, then `buildLogToEvents`, then ordered by time
 * like the API does. Times stay as the replay recorded them (the
 * analyzer additionally rewinds finished units and upgrades to their
 * start with a server-side duration table).
 *
 * Example:
 *   offlineBuildEvents(["[0:00] RewardDanceStalker", "[0:18] Pylon"], "Protoss")[0].name; // -> "Pylon"
 */
export function offlineBuildEvents(lines: ReadonlyArray<string>, race: string | null): BuildOrderEvent[] {
  const events = buildLogToEvents(withoutCosmeticLines(lines), race ?? undefined);
  return events.sort((a, b) => a.time - b.time);
}

/**
 * Both build orders of one game, with an "empty" status for a side
 * that parsed to no events (the column then says so).
 *
 * Example:
 *   gameBuilds(payload).oppLabel; // -> "ZvP - Speedling Flood"
 */
export function gameBuilds(payload: InstantPayload): GameBuilds {
  const myEvents = offlineBuildEvents(payload.buildLog, payload.myRace);
  const oppEvents = offlineBuildEvents(payload.oppBuildLog, payload.opponent?.race ?? null);
  return {
    myEvents,
    oppEvents,
    myStatus: myEvents.length > 0 ? "ok" : "empty",
    oppStatus: oppEvents.length > 0 ? "ok" : "empty",
    myLabel: payload.myBuild,
    oppLabel: payload.opponent?.strategy ?? null,
  };
}

type Breakdown = NonNullable<InstantPayload["macroBreakdown"]>;

/** Both sides' series and structures, as the analyzer's panel passes them. */
function chartSeries(breakdown: Breakdown, samples: StatsEvent[]) {
  const raw = breakdown.raw ?? {};
  return {
    samples,
    oppSamples: breakdown.opp_stats_events ?? [],
    unitTimeline: breakdown.unit_timeline,
    myProductionBuildings: breakdown.production_buildings,
    oppProductionBuildings: breakdown.opp_production_buildings,
    supplyBlockWindows: raw.supply_block_windows ?? [],
    oppSupplyBlockWindows: raw.opp_supply_block_windows ?? [],
  };
}

/** Names and races: "You" (null) vs the opponent's display name. */
function chartPlayers(payload: InstantPayload) {
  const opponent = payload.opponent;
  return {
    myName: null,
    oppName: opponent?.displayName ?? null,
    myRace: payload.myRace,
    oppRace: opponent?.race ?? null,
  };
}

/**
 * Macro timeline props for one game, wired exactly like the analyzer's
 * macro panel (samples, unit timeline, production buildings, leaks via
 * `selectLeaks`, supply-block windows, trusted APM), plus both build
 * orders for the roster's buildings and upgrades; null when the payload
 * has no stats samples to plot.
 *
 * Example:
 *   macroChartProps(payload, gameBuilds(payload))?.samples.length; // -> 32
 */
export function macroChartProps(payload: InstantPayload, builds: GameBuilds): OfflineMacroChartProps | null {
  const breakdown = payload.macroBreakdown;
  const samples = breakdown?.stats_events;
  if (!breakdown || !samples || samples.length === 0) return null;
  return {
    ...chartSeries(breakdown, samples),
    ...chartPlayers(payload),
    gameLengthSec: payload.durationSec ?? undefined,
    leaks: selectLeaks({ ok: true, ...breakdown }),
    apm: readGameApm(payload.apmCurve),
    buildOrder: { ok: true, events: builds.myEvents, opp_events: builds.oppEvents },
  };
}
