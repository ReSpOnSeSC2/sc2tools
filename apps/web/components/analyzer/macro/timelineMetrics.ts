/**
 * The metrics behind the Match timeline tabs — the sc2replaystats
 * vocabulary (Army Value, Workers, Supply, Collection Rate, Income
 * Advantage). Pure data and number formatting; ``activeArmyLayout``
 * plots whichever metric is selected and the chart parts render it.
 *
 * Only tracker ``PlayerStatsEvent`` fields the agent already uploads
 * are used, so every tab works on existing games. sc2replaystats'
 * "Resources Lost" is absent because the samples carry no loss totals.
 */

import type { SeriesPoint } from "./activeArmyLayout";

export type TimelineMetric =
  | "army"
  | "workers"
  | "supply"
  | "income"
  | "incomeAdvantage";

export interface TimelineMetricDef {
  key: TimelineMetric;
  /** Tab label. */
  label: string;
  /** What the per-player number is, after the player's name. */
  caption: string;
  /** Per-player value at a sample; null when the payload lacks it. */
  read: (p: SeriesPoint) => number | null;
  /** Smallest axis maximum, so a quiet game still gets a sane scale. */
  floor: number;
  /**
   * Plot one signed line (you minus the opponent) instead of one line
   * per player. ``read`` still gives each player's own number for the
   * tooltip and the summary row.
   */
  advantage?: boolean;
  /** Per-player text for the tooltip and summary; defaults to ``read``. */
  describe?: (p: SeriesPoint) => string;
}

function income(p: SeriesPoint): number | null {
  return typeof p.income === "number" ? p.income : null;
}

export const TIMELINE_METRICS: readonly TimelineMetricDef[] = [
  {
    key: "army",
    label: "Army Value",
    caption: "army value",
    read: (p) => p.army,
    floor: 200,
  },
  {
    key: "workers",
    label: "Workers",
    caption: "workers",
    read: (p) => p.workers,
    floor: 12,
  },
  {
    key: "supply",
    label: "Supply",
    caption: "supply",
    read: (p) => (typeof p.supply === "number" ? p.supply : null),
    floor: 20,
    describe: (p) =>
      typeof p.supply !== "number"
        ? "—"
        : typeof p.supplyCap === "number" && p.supplyCap > 0
          ? `${Math.round(p.supply)}/${Math.round(p.supplyCap)}`
          : String(Math.round(p.supply)),
  },
  {
    key: "income",
    label: "Collection Rate",
    caption: "collection rate",
    read: income,
    floor: 200,
  },
  {
    key: "incomeAdvantage",
    label: "Income Advantage",
    caption: "collection rate",
    read: income,
    floor: 100,
    advantage: true,
  },
];

export const DEFAULT_TIMELINE_METRIC: TimelineMetric = "army";

export function timelineMetric(key: TimelineMetric): TimelineMetricDef {
  return TIMELINE_METRICS.find((m) => m.key === key) ?? TIMELINE_METRICS[0];
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
 * Compact axis label, sc2replaystats style: 750, 2.5k, 5.0k, 10k.
 * One decimal below ten thousand keeps quarter ticks distinct.
 */
export function formatAxisValue(v: number): string {
  if (!Number.isFinite(v)) return "";
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  if (abs >= 10_000) return `${sign}${Math.round(abs / 1000)}k`;
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)}k`;
  return `${sign}${Math.round(abs)}`;
}

/** Signed difference for the advantage metric: "+350", "-120", "0". */
export function formatSigned(v: number): string {
  const r = Math.round(v);
  if (r === 0) return "0";
  return `${r > 0 ? "+" : "-"}${Math.abs(r).toLocaleString()}`;
}

export interface AdvantagePoint {
  t: number;
  /** Your value minus the opponent's at ``t``. */
  value: number;
}

/**
 * ``read(you) - read(opponent)`` at each of your samples. The opponent
 * is read at its latest sample at or before ``t`` (its first sample
 * before it has one), the same never-read-the-future rule the tooltip
 * and roster use. Both series are ascending by ``t``.
 */
export function advantageSeries(
  mySeries: SeriesPoint[],
  oppSeries: SeriesPoint[],
  read: (p: SeriesPoint) => number | null,
): AdvantagePoint[] {
  if (mySeries.length === 0 || oppSeries.length === 0) return [];
  const out: AdvantagePoint[] = [];
  let j = 0;
  for (const p of mySeries) {
    while (j + 1 < oppSeries.length && oppSeries[j + 1].t <= p.t) j++;
    const mine = read(p);
    const theirs = read(oppSeries[j]);
    if (mine == null || theirs == null) continue;
    out.push({ t: p.t, value: mine - theirs });
  }
  return out;
}
