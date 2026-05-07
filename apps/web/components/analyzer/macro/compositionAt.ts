/**
 * Pure derivation helpers for the live "alive units & buildings"
 * composition shown beneath the Active Army chart.
 *
 * The composition snapshot has three available data sources, ranked
 * by accuracy:
 *
 *   1. ``unit_timeline`` — agent v0.5+ uploads. One snapshot of alive
 *      units per stats sample (~30s cadence post-downsample) per side.
 *      The tracker walk that builds it is fully death-aware: a unit
 *      vanishes from the snapshot the tick after its UnitDiedEvent.
 *
 *   2. Build-order events — every replay has these. They list every
 *      construction event with a timestamp but carry NO death info.
 *
 *   3. Stats events — only food_workers count is useful here, sourced
 *      separately by the caller.
 *
 * The previous implementation only used (1) for units, leaving the
 * roster empty for any replay whose agent didn't upload a unit_timeline
 * (slim variant, pre-v0.5 agent, or replays where the extractor failed
 * to attach a unit_timeline for any reason). This module builds a
 * resilient hybrid:
 *
 *   - When unit_timeline is populated AND the closest sample to the
 *     hovered time has at least one entry on the side we're rendering,
 *     trust it (it's death-aware).
 *
 *   - Otherwise, derive the composition from the build order
 *     (cumulative count up to ``t`` with morph adjustments) and apply
 *     death events derived from any unit_timeline diffs we can see.
 *     This keeps deaths visible even when the timeline is sparse or
 *     present for only one side.
 *
 * Buildings are always derived from the build order (as before) — the
 * build-order parser tags every entry with ``is_building`` so the
 * separation is trivial. Workers come from ``stats_events.food_workers``
 * and are not handled here.
 */

import { isBuildingUnit, isWorkerUnit } from "@/lib/sc2-units";
import type { UnitTimelineEntry } from "./MacroBreakdownPanel.types";

export interface BuildEvent {
  time: number;
  name: string;
  display?: string;
  is_building?: boolean;
}

export type CompositionSource = "timeline" | "hybrid" | "build_order" | "empty";

export interface DerivedComposition {
  /** ``{name: count}`` of alive non-worker, non-building units at time t. */
  units: Record<string, number>;
  /** Where the unit data came from — surfaced in the UI so users
   * understand whether deaths are being tracked. */
  source: CompositionSource;
}

/**
 * Unit morph map — when key X is built, it consumes one unit of the
 * mapped value. Keeps cumulative build-order counts honest: 5 Roaches
 * that morphed into Ravagers should show as "5 Ravagers" rather than
 * "5 Roaches + 5 Ravagers". Mirrors the agent's UnitTypeChangeEvent
 * handling in ``core/event_extractor.py``.
 *
 * Archon is a 2-parent morph (HighTemplar OR DarkTemplar — either
 * combination), so it's handled separately in ``applyMorph`` rather
 * than via this map.
 */
const UNIT_MORPH_PARENT: Record<string, string> = {
  // Zerg
  Lurker: "Hydralisk",
  LurkerMP: "Hydralisk",
  LurkerMPBurrowed: "Hydralisk",
  Ravager: "Roach",
  Baneling: "Zergling",
  BroodLord: "Corruptor",
  Broodlord: "Corruptor",
  Overseer: "Overlord",
  OverseerSiegeMode: "Overlord",
  // Terran (Hellbat ↔ Hellion is a stance toggle, not a morph; we
  // canonicalize the suffix away in ``canonicalizeName`` so both forms
  // collapse onto the same name and a stance flip is a no-op.)
};

/** Templar units that combine into an Archon — preference order for
 * which parent to consume first. Real games never split the pair, but
 * mass-DT openers often archon-shuffle so consuming DTs first matches
 * what most players expect to see in the roster. */
const ARCHON_PARENTS: ReadonlyArray<string> = ["DarkTemplar", "HighTemplar"];

/**
 * Strip morphological/stance suffixes the tracker emits but the unit
 * catalog doesn't enumerate (Burrowed, Sieged, Phasing, Lowered…).
 * This collapses transient stances onto a single canonical name so a
 * SiegeTank → SiegeTankSieged → SiegeTank cycle doesn't decrement and
 * re-increment the count.
 */
export function canonicalizeName(name: string): string {
  if (!name) return "";
  const stripped = name
    .replace(/(Burrowed|Sieged|Phasing|Flying|Lowered|Cocoon|Uprooted)$/i, "")
    .replace(/^Burrowed/i, "");
  return stripped || name;
}

/** Mutate ``counts`` to apply the morph rule for ``name`` (consume one
 * parent if present). Returns the canonical name to credit. */
function applyMorph(counts: Record<string, number>, name: string): string {
  const canonical = canonicalizeName(name);
  if (canonical === "Archon") {
    let consumed = 0;
    for (const parent of ARCHON_PARENTS) {
      while (consumed < 2 && (counts[parent] || 0) > 0) {
        counts[parent] = (counts[parent] || 0) - 1;
        if (counts[parent] === 0) delete counts[parent];
        consumed += 1;
      }
      if (consumed >= 2) break;
    }
    return canonical;
  }
  const parent = UNIT_MORPH_PARENT[canonical];
  if (parent && (counts[parent] || 0) > 0) {
    counts[parent] = (counts[parent] || 0) - 1;
    if (counts[parent] === 0) delete counts[parent];
  }
  return canonical;
}

/**
 * Cumulative count of non-worker, non-building units the player has
 * commanded up to and including ``t`` from the build-order event
 * stream. Applies morph rules so a Hydralisk that became a Lurker
 * shows as a Lurker, not as both. Returns a fresh ``{name: count}``
 * map; never null.
 *
 * Events MUST be sorted ascending by ``time`` (the API guarantees this
 * via ``parseBuildLogLines``'s post-sort). We early-exit on the first
 * event past ``t`` for O(t)-bounded work on long replays.
 */
export function buildOrderUnitsAt(
  events: BuildEvent[] | undefined | null,
  t: number,
): Record<string, number> {
  if (!Array.isArray(events) || events.length === 0) return {};
  const counts: Record<string, number> = {};
  for (const ev of events) {
    if (!ev || ev.is_building) continue;
    const time = Number(ev.time) || 0;
    if (time > t) break;
    const rawName = ev.name || ev.display || "";
    if (!rawName) continue;
    const canonical = canonicalizeName(rawName);
    if (!canonical) continue;
    if (isWorkerUnit(canonical)) continue;
    if (isBuildingUnit(canonical)) continue;
    const credited = applyMorph(counts, rawName);
    counts[credited] = (counts[credited] || 0) + 1;
  }
  return counts;
}

interface DeathEvent {
  time: number;
  name: string;
  count: number;
}

/**
 * Derive death events for ``side`` by diffing consecutive
 * ``unit_timeline`` samples. When unit X drops from N to M between
 * samples ``s_i`` (time t_i) and ``s_{i+1}`` (time t_{i+1}), we record
 * ``(N - M)`` deaths attributed to t_{i+1}. We can't pinpoint the
 * exact death time within the sample window — the tracker only
 * surfaces alive-counts at sample times — so we anchor the death to
 * the later sample. The user-facing impact is bounded by the sample
 * cadence (≤30 s in v0.5+ payloads).
 *
 * Increases are ignored — they're handled by the build-order births.
 * That means a unit that was born and died inside a single window
 * will be invisible to this diff (count never went above prev), but
 * will also never be added to the build-order count past the death
 * window, so the net effect is correct.
 *
 * Returns events sorted ascending by time so the consumer can early-
 * exit when scanning up to a target ``t``.
 */
export function derivedDeathsFromTimeline(
  timeline: UnitTimelineEntry[] | undefined | null,
  side: "my" | "opp",
): DeathEvent[] {
  if (!Array.isArray(timeline) || timeline.length < 2) return [];
  const out: DeathEvent[] = [];
  for (let i = 1; i < timeline.length; i++) {
    const prevSide = side === "my" ? timeline[i - 1].my : timeline[i - 1].opp;
    const curSide = side === "my" ? timeline[i].my : timeline[i].opp;
    if (!prevSide && !curSide) continue;
    const prev = prevSide || {};
    const cur = curSide || {};
    const seen = new Set<string>();
    for (const name of Object.keys(prev)) seen.add(name);
    for (const name of Object.keys(cur)) seen.add(name);
    for (const name of seen) {
      const prevCount = prev[name] || 0;
      const curCount = cur[name] || 0;
      if (curCount < prevCount) {
        out.push({
          time: Number(timeline[i].time) || 0,
          name,
          count: prevCount - curCount,
        });
      }
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/** Closest unit_timeline entry to ``t``. Returns null on empty input. */
export function nearestTimelineEntry(
  timeline: UnitTimelineEntry[] | undefined | null,
  t: number,
): UnitTimelineEntry | null {
  if (!Array.isArray(timeline) || timeline.length === 0) return null;
  let best = timeline[0];
  let bestD = Math.abs((best.time || 0) - t);
  for (let i = 1; i < timeline.length; i++) {
    const d = Math.abs((timeline[i].time || 0) - t);
    if (d < bestD) {
      best = timeline[i];
      bestD = d;
    }
  }
  return best;
}

/**
 * Single entry point for the snapshot: pick the best available source
 * for the live unit composition at ``t``. See module header for the
 * preference order.
 *
 * Always returns a fresh ``units`` map — callers are free to mutate.
 */
export function deriveUnitComposition(opts: {
  timeline: UnitTimelineEntry[] | undefined | null;
  buildEvents: BuildEvent[] | undefined | null;
  side: "my" | "opp";
  t: number;
}): DerivedComposition {
  const { timeline, buildEvents, side, t } = opts;
  const hasTimeline = Array.isArray(timeline) && timeline.length > 0;
  const hasBuildEvents = Array.isArray(buildEvents) && buildEvents.length > 0;

  // Source 1: unit_timeline — preferred when it has populated data
  // for this side at the closest sample. An empty side-map at the
  // closest sample doesn't mean "nothing alive"; it could mean the
  // extractor never populated this side (older payloads omitted opp).
  // Treat empty-but-have-other-side as "fall back" so the build order
  // can still fill the roster.
  if (hasTimeline) {
    const entry = nearestTimelineEntry(timeline, t);
    const composition = (side === "my" ? entry?.my : entry?.opp) || {};
    if (Object.keys(composition).length > 0) {
      return { units: { ...composition }, source: "timeline" };
    }
  }

  // Source 2: build-order cumulative + timeline-derived deaths.
  if (!hasBuildEvents) {
    return { units: {}, source: "empty" };
  }
  const built = buildOrderUnitsAt(buildEvents, t);

  if (!hasTimeline) {
    return { units: built, source: "build_order" };
  }

  // Subtract any deaths we can derive from the timeline up to t. The
  // timeline may carry the OTHER side only (e.g. ``my`` populated,
  // ``opp`` empty for older payloads), in which case derivedDeaths
  // returns an empty list for our side and ``built`` passes through
  // unchanged.
  const deaths = derivedDeathsFromTimeline(timeline, side);
  let appliedAny = false;
  for (const death of deaths) {
    if (death.time > t) break;
    const canonical = canonicalizeName(death.name);
    const cur = built[canonical] || 0;
    if (cur > 0) {
      const next = Math.max(0, cur - death.count);
      if (next === 0) delete built[canonical];
      else built[canonical] = next;
      appliedAny = true;
    }
  }
  return {
    units: built,
    source: appliedAny ? "hybrid" : "build_order",
  };
}
