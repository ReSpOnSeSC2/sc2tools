"use client";

import { useId, useMemo } from "react";
import { AlertCircle } from "lucide-react";

/**
 * ChronoAllocationChart — donut + table showing where the Protoss
 * player's chrono boosts landed by target building. Aggregated by the
 * agent's macro_score pass — `raw.chrono_targets` is `[{name, count}]`
 * sorted by count desc.
 *
 * The donut surfaces the top 5 buckets plus an "Other" tail aggregator
 * so it doesn't fragment beyond legibility; the table lists every row
 * so absolute counts always reconcile to the chrono total.
 *
 * Targets sc2reader couldn't resolve are bucketed under "Unknown" with
 * a neutral grey — we never invent a name.
 *
 * For non-Protoss races the wrapper renders nothing (callers gate on
 * race externally so the card slot disappears entirely).
 */

export interface ChronoTarget {
  /** Cloud canonical key — falls back to `building_name` when missing. */
  name?: string;
  building_name?: string;
  count: number;
}

export interface ChronoAllocationChartProps {
  targets: ChronoTarget[];
}

function resolveName(t: ChronoTarget): string {
  return String(t?.name || t?.building_name || "Unknown");
}

const TOP_N = 5;
const RADIUS = 36;
const STROKE_WIDTH = 18;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const COLOR_TOKENS: Record<string, string> = {
  Nexus: "rgb(var(--accent-cyan))",
  Gateway: "rgb(var(--success))",
  WarpGate: "rgb(var(--success))",
  RoboticsFacility: "rgb(var(--accent))",
  RoboticsBay: "rgb(var(--accent))",
  Stargate: "rgb(var(--accent-cyan))",
  FleetBeacon: "rgb(var(--accent-cyan))",
  Forge: "rgb(var(--warning))",
  CyberneticsCore: "rgb(var(--warning))",
  TwilightCouncil: "rgb(var(--danger))",
  TemplarArchive: "rgb(var(--danger))",
  DarkShrine: "rgb(var(--danger))",
};
const COLOR_OTHER = "rgb(var(--text-muted))";
const COLOR_UNKNOWN = "rgb(var(--text-dim))";

function colorFor(name: string): string {
  if (name === "Other") return COLOR_OTHER;
  if (name === "Unknown") return COLOR_UNKNOWN;
  return COLOR_TOKENS[name] || COLOR_OTHER;
}

function humanize(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function ChronoAllocationChart({ targets }: ChronoAllocationChartProps) {
  const titleId = useId();

  const view = useMemo(() => {
    if (!Array.isArray(targets) || targets.length === 0) return null;
    const total = targets.reduce(
      (sum, t) => sum + (Number(t && t.count) || 0),
      0,
    );
    if (total <= 0) return null;
    const tableRows = targets.map((t) => ({
      name: resolveName(t),
      count: Number(t?.count) || 0,
      pct: (100 * (Number(t?.count) || 0)) / total,
    }));
    const head = tableRows.slice(0, TOP_N);
    const tail = tableRows.slice(TOP_N);
    const tailCount = tail.reduce((sum, r) => sum + r.count, 0);
    const donut = head.slice();
    if (tail.length > 0 && tailCount > 0) {
      donut.push({
        name: "Other",
        count: tailCount,
        pct: (100 * tailCount) / total,
      });
    }
    return { total, tableRows, donut };
  }, [targets]);

  if (!view) return <ChartEmptyState />;

  let cumulative = 0;
  const slices = view.donut.map((s, idx) => {
    const dash = (s.pct / 100) * CIRCUMFERENCE;
    const gap = CIRCUMFERENCE - dash;
    const offset = -((cumulative / 100) * CIRCUMFERENCE);
    cumulative += s.pct;
    return (
      <circle
        key={idx}
        cx="50"
        cy="50"
        r={RADIUS}
        fill="none"
        stroke={colorFor(s.name)}
        strokeWidth={STROKE_WIDTH}
        strokeDasharray={`${dash.toFixed(3)} ${gap.toFixed(3)}`}
        strokeDashoffset={offset.toFixed(3)}
        transform="rotate(-90 50 50)"
      />
    );
  });

  return (
    <figure className="space-y-3" aria-labelledby={titleId}>
      <figcaption
        id={titleId}
        className="flex flex-wrap items-center justify-between gap-2 text-caption text-text-muted"
      >
        <span className="font-semibold uppercase tracking-wider text-text">
          Chrono allocation
        </span>
        <span className="text-[11px] text-text-dim tabular-nums">
          {view.total} cast{view.total === 1 ? "" : "s"}
        </span>
      </figcaption>

      <div className="flex flex-col gap-4 md:flex-row md:items-start">
        <div
          className="flex shrink-0 items-center justify-center rounded-lg border border-border bg-bg-elevated p-3"
          aria-hidden
        >
          <svg viewBox="0 0 100 100" width="160" height="160">
            <circle
              cx="50"
              cy="50"
              r={RADIUS}
              fill="none"
              stroke="rgb(var(--bg-subtle))"
              strokeWidth={STROKE_WIDTH}
            />
            {slices}
          </svg>
        </div>

        <div className="min-w-0 flex-1">
          <table className="w-full text-caption">
            <thead className="border-b border-border text-[11px] uppercase tracking-wider text-text-dim">
              <tr>
                <th className="py-1 pr-2 text-left">Target</th>
                <th className="py-1 pr-2 text-right">Casts</th>
                <th className="py-1 text-right">Share</th>
              </tr>
            </thead>
            <tbody>
              {view.tableRows.map((r) => (
                <tr key={r.name} className="border-b border-border last:border-b-0">
                  <td className="flex items-center gap-2 py-1 pr-2 text-text">
                    <span
                      aria-hidden
                      className="inline-block h-2 w-2 rounded-sm"
                      style={{ background: colorFor(r.name) }}
                    />
                    {humanize(r.name)}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums text-text-muted">
                    {r.count}
                  </td>
                  <td className="py-1 text-right tabular-nums text-text-muted">
                    {r.pct.toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="px-1 text-caption text-text-dim">
        Where each chrono cast landed by target building. Buildings still under
        construction count under their final name; targets sc2reader could not
        resolve bucket as <span className="text-text-muted">Unknown</span>.
      </p>
    </figure>
  );
}

function ChartEmptyState() {
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg border border-border bg-bg-subtle p-4">
      <div className="inline-flex items-center gap-2 text-caption font-semibold text-accent-cyan">
        <AlertCircle className="h-4 w-4" aria-hidden />
        Chrono allocation unavailable
      </div>
      <p className="text-caption text-text-muted">
        No chrono casts recorded for this game — either the macro breakdown
        hasn&apos;t been computed yet, or the player didn&apos;t cast any
        chronos.
      </p>
    </div>
  );
}
