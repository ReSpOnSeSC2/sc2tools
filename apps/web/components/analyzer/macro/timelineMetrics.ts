/**
 * The metrics behind the Match timeline switch: army value, workers,
 * supply, income and, for games with a trusted APM curve, APM. Pure
 * data and number formatting; ``activeArmyLayout`` plots whichever
 * metric is selected and the chart parts render it.
 *
 * The first four read tracker ``PlayerStatsEvent`` fields the agent
 * already uploads, so they work on existing games. APM comes from the
 * game's APM curve (lib/apm.ts) and is only offered when that curve is
 * trusted. Who leads, and by how much, is shown on every metric (shading
 * between the lines and a margin beside the leader) rather than as a
 * metric of its own.
 */

import { Keyboard, type LucideIcon } from "lucide-react";
import type { SeriesPoint } from "./activeArmyLayout";

export type TimelineMetric = "army" | "workers" | "supply" | "income" | "apm";

type RaceLetter = "P" | "T" | "Z";

export interface TimelineMetricDef {
  key: TimelineMetric;
  /** Switch label. */
  label: string;
  /** Full name for assistive tech and the chart description. */
  title: string;
  /** What the per-player number is, after the player's name. */
  caption: string;
  /** Per-player value at a sample; null when the payload lacks it. */
  read: (p: SeriesPoint) => number | null;
  /** Smallest axis maximum, so a quiet game still gets a sane scale. */
  floor: number;
  /** Per-player text for the tooltip and summary; defaults to ``read``. */
  describe?: (p: SeriesPoint) => string;
  /** The in-game icon that stands for this metric, per race. */
  icon?: Record<RaceLetter, string>;
  /** Generic glyph for a metric with no race-specific in-game icon. */
  glyph?: LucideIcon;
}

export const TIMELINE_METRICS: readonly TimelineMetricDef[] = [
  {
    key: "army",
    label: "Army",
    title: "Army value",
    caption: "army value",
    read: (p) => p.army,
    floor: 200,
    icon: { P: "Zealot", T: "Marine", Z: "Zergling" },
  },
  {
    key: "workers",
    label: "Workers",
    title: "Workers",
    caption: "workers",
    read: (p) => p.workers,
    floor: 12,
    icon: { P: "Probe", T: "SCV", Z: "Drone" },
  },
  {
    key: "supply",
    label: "Supply",
    title: "Supply used",
    caption: "supply",
    read: (p) => (typeof p.supply === "number" ? p.supply : null),
    floor: 20,
    describe: (p) =>
      typeof p.supply !== "number"
        ? "—"
        : typeof p.supplyCap === "number" && p.supplyCap > 0
          ? `${Math.round(p.supply)}/${Math.round(p.supplyCap)}`
          : String(Math.round(p.supply)),
    icon: { P: "Pylon", T: "SupplyDepot", Z: "Overlord" },
  },
  {
    key: "income",
    label: "Income",
    title: "Income (minerals and gas collected per minute)",
    caption: "income",
    read: (p) => (typeof p.income === "number" ? p.income : null),
    floor: 200,
    icon: { P: "Nexus", T: "CommandCenter", Z: "Hatchery" },
  },
  {
    key: "apm",
    label: "APM",
    title: "Actions per minute (every command, selection and control-group action)",
    caption: "APM",
    read: (p) => (typeof p.apm === "number" ? p.apm : null),
    floor: 100,
    glyph: Keyboard,
  },
];

/**
 * The metrics this game can show. APM needs a trusted APM curve, so it
 * is left out of the switch entirely rather than drawn empty.
 */
export function timelineMetricsFor({ apm }: { apm: boolean }): readonly TimelineMetricDef[] {
  return apm ? TIMELINE_METRICS : TIMELINE_METRICS.filter((m) => m.key !== "apm");
}

export const DEFAULT_TIMELINE_METRIC: TimelineMetric = "army";

export function timelineMetric(key: TimelineMetric): TimelineMetricDef {
  return TIMELINE_METRICS.find((m) => m.key === key) ?? TIMELINE_METRICS[0];
}

/** The metric's icon for a race ("Protoss", "P", …); null when unknown. */
export function metricIcon(
  metric: TimelineMetricDef,
  race: string | null | undefined,
): string | null {
  const letter = (race || "").charAt(0).toUpperCase();
  return metric.icon && (letter === "P" || letter === "T" || letter === "Z")
    ? metric.icon[letter]
    : null;
}

/** Full-precision number for the tooltip and summary: "8,025". */
export function formatMetricValue(v: number | null | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return Math.round(v).toLocaleString();
}

/** One player's number for ``metric``, "—" when the sample lacks it. */
export function describeMetric(
  metric: TimelineMetricDef,
  p: SeriesPoint | null | undefined,
): string {
  if (!p) return "—";
  if (metric.describe) return metric.describe(p);
  return formatMetricValue(metric.read(p));
}

/**
 * Your value minus the opponent's (positive while you lead), rounded;
 * null when either side has no value.
 */
export function metricLead(
  metric: TimelineMetricDef,
  my: SeriesPoint | null | undefined,
  opp: SeriesPoint | null | undefined,
): number | null {
  const mine = my ? metric.read(my) : null;
  const theirs = opp ? metric.read(opp) : null;
  if (mine == null || theirs == null) return null;
  return Math.round(mine - theirs);
}

/**
 * Compact axis label: 750, 2.5k, 5.0k, 10k. One decimal below ten
 * thousand keeps quarter ticks distinct.
 */
export function formatAxisValue(v: number): string {
  if (!Number.isFinite(v)) return "";
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  if (abs >= 10_000) return `${sign}${Math.round(abs / 1000)}k`;
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)}k`;
  return `${sign}${Math.round(abs)}`;
}

/** Signed margin: "+350", "-120", "0". */
export function formatSigned(v: number): string {
  const r = Math.round(v);
  if (r === 0) return "0";
  return `${r > 0 ? "+" : "-"}${Math.abs(r).toLocaleString()}`;
}
