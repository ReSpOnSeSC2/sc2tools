"use client";

import { EmptyState } from "@/components/ui/Card";
import { fmtMinutes } from "@/lib/format";

export type Phase = "early" | "earlyMid" | "mid" | "midLate" | "late";

export type PhaseTrajectoryStripProps = {
  sampleSize: {
    early: number;
    earlyMid: number;
    mid: number;
    midLate: number;
    late: number;
  };
  crossings: {
    earlyMidAt: number | null;
    midAt: number | null;
    midLateAt: number | null;
    lateAt: number | null;
  };
  finalPhaseDistribution: Record<Phase, number>;
  durationP95Sec: number;
  className?: string;
  compact?: boolean;
  /** When true, render only the "where games end" stacked bar — used by
   *  side-by-side comparison columns where the median-timing bands
   *  would crowd the layout. Takes precedence over ``compact``. */
  outcomeOnly?: boolean;
};

const PHASE_ORDER: Phase[] = ["early", "earlyMid", "mid", "midLate", "late"];

const PHASE_LABELS: Record<Phase, string> = {
  early: "Early",
  earlyMid: "Early/Mid",
  mid: "Mid",
  midLate: "Mid/Late",
  late: "Late",
};

const PHASE_SHORT_LABELS: Record<Phase, string> = {
  early: "Early",
  earlyMid: "E/Mid",
  mid: "Mid",
  midLate: "M/Late",
  late: "Late",
};

// Solid phase fills used for the "where games end" stacked bar segments
// and for the median-timing band tints. Higher saturation than the old
// strip so segments read distinctly even at 1-2% widths on mobile.
const PHASE_FILLS: Record<Phase, string> = {
  early: "rgb(var(--text-muted) / 0.55)",
  earlyMid: "rgb(var(--accent) / 0.85)",
  mid: "rgb(var(--accent-cyan) / 0.85)",
  midLate: "rgb(var(--warning) / 0.85)",
  late: "rgb(var(--danger) / 0.85)",
};

const PHASE_BAND_FILLS: Record<Phase, string> = {
  early: "rgb(var(--text-muted) / 0.18)",
  earlyMid: "rgb(var(--accent) / 0.20)",
  mid: "rgb(var(--accent-cyan) / 0.28)",
  midLate: "rgb(var(--warning) / 0.22)",
  late: "rgb(var(--danger) / 0.28)",
};

const CROSSING_ORDER: Array<{
  key: keyof PhaseTrajectoryStripProps["crossings"];
  label: string;
  to: Phase;
}> = [
  { key: "earlyMidAt", label: "Early/Mid", to: "earlyMid" },
  { key: "midAt", label: "Mid", to: "mid" },
  { key: "midLateAt", label: "Mid/Late", to: "midLate" },
  { key: "lateAt", label: "Late", to: "late" },
];

type BandSpec = { phase: Phase; start: number; end: number };

export function PhaseTrajectoryStrip({
  sampleSize,
  crossings,
  finalPhaseDistribution,
  durationP95Sec,
  className,
  compact = false,
  outcomeOnly = false,
}: PhaseTrajectoryStripProps) {
  const allEmpty = PHASE_ORDER.every((p) => (sampleSize[p] ?? 0) === 0);
  if (allEmpty) {
    return (
      <EmptyState
        title="Not enough games on this build yet"
        sub="A few more games will start drawing your phase trajectory."
      />
    );
  }

  const ceiling = Math.max(1, durationP95Sec);
  const clampPct = (t: number) =>
    Math.max(0, Math.min(100, (t / ceiling) * 100));

  // For null crossings (phase never reached), pin to the ceiling so
  // downstream bands collapse to zero width.
  const eMid = crossings.earlyMidAt ?? ceiling;
  const mid = crossings.midAt ?? ceiling;
  const mLate = crossings.midLateAt ?? ceiling;
  const late = crossings.lateAt ?? ceiling;

  const bands: BandSpec[] = [
    { phase: "early", start: 0, end: eMid },
    { phase: "earlyMid", start: eMid, end: mid },
    { phase: "mid", start: mid, end: mLate },
    { phase: "midLate", start: mLate, end: late },
    { phase: "late", start: late, end: ceiling },
  ];

  const totalFinal = PHASE_ORDER.reduce(
    (s, p) => s + (finalPhaseDistribution[p] ?? 0),
    0,
  );
  const maxFinal = PHASE_ORDER.reduce(
    (m, p) => Math.max(m, finalPhaseDistribution[p] ?? 0),
    0,
  );
  const totalSamples = PHASE_ORDER.reduce(
    (s, p) => s + (sampleSize[p] ?? 0),
    0,
  );

  const crossingsCaption = CROSSING_ORDER.map(({ key, label }) => {
    const v = crossings[key];
    return v == null
      ? `${label}: not reached`
      : `${label} crossing at ${fmtMinutes(v)}`;
  }).join("; ");

  const finalCaption =
    totalFinal > 0
      ? `Final phase distribution: ${PHASE_ORDER.map((p) => {
          const v = finalPhaseDistribution[p] ?? 0;
          const pct = Math.round((100 * v) / totalFinal);
          return `${PHASE_LABELS[p]} ${pct}%`;
        }).join(", ")}.`
      : "No final-phase data yet.";

  const caption =
    `Phase trajectory across ${totalSamples} game${totalSamples === 1 ? "" : "s"}. ` +
    `${crossingsCaption}. ${finalCaption}`;

  const figureClass = ["w-full", className].filter(Boolean).join(" ");

  // Median game-length: pick the band whose final count sits at or
  // above the cumulative midpoint (50% of games). Used as the "median
  // game ends here" pin.
  const medianCrossingPct = (() => {
    if (totalFinal === 0) return null;
    const half = totalFinal / 2;
    let cum = 0;
    for (const b of bands) {
      cum += finalPhaseDistribution[b.phase] ?? 0;
      if (cum >= half) {
        // Midpoint of the winning band, clamped to a visible range.
        const mid = (clampPct(b.start) + clampPct(b.end)) / 2;
        return Math.max(2, Math.min(98, mid));
      }
    }
    return null;
  })();

  return (
    <figure className={figureClass} data-testid="phase-trajectory-strip">
      <figcaption className="sr-only">{caption}</figcaption>
      {outcomeOnly ? (
        <OutcomeBar
          finalPhaseDistribution={finalPhaseDistribution}
          maxFinal={maxFinal}
          totalFinal={totalFinal}
          totalSamples={totalSamples}
        />
      ) : compact ? (
        <CompactStrip
          bands={bands}
          crossings={crossings}
          clampPct={clampPct}
          totalFinal={totalFinal}
          finalPhaseDistribution={finalPhaseDistribution}
          maxFinal={maxFinal}
        />
      ) : (
        <FullStrip
          bands={bands}
          crossings={crossings}
          ceiling={ceiling}
          clampPct={clampPct}
          finalPhaseDistribution={finalPhaseDistribution}
          maxFinal={maxFinal}
          totalFinal={totalFinal}
          totalSamples={totalSamples}
          medianCrossingPct={medianCrossingPct}
        />
      )}
    </figure>
  );
}

function FullStrip({
  bands,
  crossings,
  ceiling,
  clampPct,
  finalPhaseDistribution,
  maxFinal,
  totalFinal,
  totalSamples,
  medianCrossingPct,
}: {
  bands: BandSpec[];
  crossings: PhaseTrajectoryStripProps["crossings"];
  ceiling: number;
  clampPct: (t: number) => number;
  finalPhaseDistribution: Record<Phase, number>;
  maxFinal: number;
  totalFinal: number;
  totalSamples: number;
  medianCrossingPct: number | null;
}) {
  return (
    <div className="space-y-5">
      <OutcomeBar
        finalPhaseDistribution={finalPhaseDistribution}
        maxFinal={maxFinal}
        totalFinal={totalFinal}
        totalSamples={totalSamples}
      />
      <MedianTimingLine
        bands={bands}
        crossings={crossings}
        ceiling={ceiling}
        clampPct={clampPct}
        medianCrossingPct={medianCrossingPct}
      />
    </div>
  );
}

/**
 * Stacked "where games end" bar. Replaces the old vertical histogram
 * whose teal "handles" sat above the colored bands and were widely
 * mistaken for clickable UI. Each phase's segment width is proportional
 * to its share of completed games; the legend below mirrors that with
 * raw counts + percentages so the bar isn't carrying both jobs.
 */
function OutcomeBar({
  finalPhaseDistribution,
  maxFinal,
  totalFinal,
  totalSamples,
}: {
  finalPhaseDistribution: Record<Phase, number>;
  maxFinal: number;
  totalFinal: number;
  totalSamples: number;
}) {
  const safeTotal = Math.max(1, totalFinal);
  return (
    <div data-testid="phase-histogram">
      <div className="mb-1 flex items-baseline justify-between text-[11px] uppercase tracking-wider text-text-dim">
        <span className="font-semibold">Where games end</span>
        <span className="font-mono normal-case tracking-normal tabular-nums text-text-muted">
          {totalSamples} game{totalSamples === 1 ? "" : "s"}
        </span>
      </div>
      <div
        role="img"
        aria-label={`Where games end: ${PHASE_ORDER.map((p) => {
          const v = finalPhaseDistribution[p] ?? 0;
          const pct = Math.round((100 * v) / safeTotal);
          return `${PHASE_LABELS[p]} ${pct}%`;
        }).join(", ")}.`}
        className="flex h-7 w-full overflow-hidden rounded-md border border-border bg-bg-elevated md:h-8"
      >
        {PHASE_ORDER.map((phase) => {
          const count = finalPhaseDistribution[phase] ?? 0;
          const pct = totalFinal > 0 ? (count / safeTotal) * 100 : 0;
          const heightPct =
            maxFinal > 0 ? (count / maxFinal) * 100 : 0;
          // Always render the segment so the data attributes are
          // discoverable to tests / a11y consumers. ``flex: 0`` collapses
          // empty buckets to zero width visually.
          return (
            <div
              key={phase}
              className={[
                "relative flex items-center justify-center text-[10px] font-semibold text-white/95 transition-[filter]",
                count > 0 ? "hover:brightness-110" : "",
              ].join(" ")}
              style={{
                flex: count,
                background: count > 0 ? PHASE_FILLS[phase] : "transparent",
                textShadow: "0 1px 2px rgba(0,0,0,0.5)",
              }}
              title={`${PHASE_LABELS[phase]}: ${count} game${count === 1 ? "" : "s"} (${Math.round(pct)}%)`}
              data-testid="phase-final-bar"
              data-phase={phase}
              data-count={count}
              data-pct={pct.toFixed(2)}
              data-height-pct={heightPct}
            >
              {pct >= 10 ? `${Math.round(pct)}%` : null}
            </div>
          );
        })}
      </div>
      <ul
        className="mt-1.5 flex w-full justify-between gap-1 text-[10px] text-text-dim"
        aria-hidden="true"
      >
        {PHASE_ORDER.map((phase) => {
          const count = finalPhaseDistribution[phase] ?? 0;
          const pct = totalFinal > 0 ? (count / safeTotal) * 100 : 0;
          const dim = count === 0;
          return (
            <li
              key={phase}
              className={[
                "flex flex-1 flex-col items-center gap-0.5 leading-tight",
                dim ? "opacity-50" : "",
              ].join(" ")}
              data-testid="phase-outcome-legend-item"
              data-phase={phase}
            >
              <span className="hidden md:inline">{PHASE_LABELS[phase]}</span>
              <span className="md:hidden">{PHASE_SHORT_LABELS[phase]}</span>
              <span className="font-mono text-text">
                {count}
                {totalFinal > 0 ? (
                  <span className="ml-1 text-text-dim">
                    · {Math.round(pct)}%
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Median phase-timing line. Replaces the old "colored bands + faint
 * ticks" strip with an explicit timeline: the bar gradients through
 * each phase, vertical crossing markers label when the median game
 * enters each phase, and an accent "median ends" pin pinpoints the
 * 50th-percentile finish.
 */
function MedianTimingLine({
  bands,
  crossings,
  ceiling,
  clampPct,
  medianCrossingPct,
}: {
  bands: BandSpec[];
  crossings: PhaseTrajectoryStripProps["crossings"];
  ceiling: number;
  clampPct: (t: number) => number;
  medianCrossingPct: number | null;
}) {
  const bandsAriaLabel =
    "Phase bands: " +
    bands
      .map((b) => {
        const w = clampPct(b.end) - clampPct(b.start);
        return `${PHASE_LABELS[b.phase]} ${Math.round(w)}%`;
      })
      .join(", ");
  const tickCount = Math.floor(ceiling / 60) + 1;

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-[11px] uppercase tracking-wider text-text-dim">
        <span className="font-semibold">Median phase timing</span>
        <span className="font-mono normal-case tracking-normal tabular-nums text-text-muted">
          0:00 – {fmtMinutes(ceiling)}
        </span>
      </div>
      <div className="relative pt-7 md:pt-8">
        {medianCrossingPct !== null ? (
          <div
            className="absolute top-0 z-10 -translate-x-1/2 whitespace-nowrap rounded-md bg-accent px-2 py-0.5 text-[10px] font-semibold text-white shadow-sm"
            style={{ left: `${medianCrossingPct}%` }}
            title="Where the median game ends"
            data-testid="phase-median-pin"
            data-at-pct={medianCrossingPct.toFixed(2)}
          >
            median ends here
            <span
              className="absolute -bottom-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-accent"
              aria-hidden="true"
            />
          </div>
        ) : null}
        <div
          role="img"
          aria-label={bandsAriaLabel}
          className="relative h-8 w-full overflow-hidden rounded-md border border-border md:h-10"
          data-testid="phase-bands"
        >
          {bands.map((b) => {
            const startPct = clampPct(b.start);
            const widthPct = Math.max(0, clampPct(b.end) - startPct);
            return (
              <div
                key={b.phase}
                className="absolute top-0 h-full"
                style={{
                  left: `${startPct}%`,
                  width: `${widthPct}%`,
                  background: PHASE_BAND_FILLS[b.phase],
                }}
                data-testid="phase-band"
                data-phase={b.phase}
                data-width-pct={widthPct}
                title={`${PHASE_LABELS[b.phase]} band`}
              />
            );
          })}
          {Array.from({ length: tickCount }).map((_, i) => {
            const t = i * 60;
            const left = clampPct(t);
            return (
              <span
                key={`tick-${i}`}
                className="absolute top-0 h-full w-px bg-border"
                style={{ left: `${left}%` }}
                aria-hidden="true"
                data-testid="phase-tick"
              />
            );
          })}
          {CROSSING_ORDER.map(({ key, label }) => {
            const v = crossings[key];
            if (v == null) return null;
            const left = clampPct(v);
            return (
              <span
                key={key}
                className="absolute top-0 h-full"
                style={{
                  left: `${left}%`,
                  // 32px-wide invisible touch target centered on the
                  // marker satisfies iOS's 44px guideline minus the line
                  // itself.
                  width: 32,
                  marginLeft: -16,
                }}
                title={`${label} crossing at ${fmtMinutes(v)}`}
                data-testid="phase-crossing"
                data-key={key}
                data-at-pct={left}
                aria-hidden="true"
              >
                <span
                  className="absolute left-1/2 top-0 h-full w-0.5 -translate-x-1/2"
                  style={{ background: "rgb(var(--text))" }}
                />
              </span>
            );
          })}
        </div>

        <div
          className="relative mt-1.5 h-7 w-full text-[10px] tabular-nums text-text-dim"
          data-testid="phase-labels"
        >
          <span
            className="absolute left-0 hidden whitespace-nowrap md:inline"
            aria-hidden="true"
          >
            0:00
          </span>
          {CROSSING_ORDER.map(({ key, label }) => {
            const v = crossings[key];
            if (v == null) return null;
            const left = clampPct(v);
            return (
              <span
                key={`label-${key}`}
                className="absolute -translate-x-1/2 whitespace-nowrap text-center leading-tight"
                style={{ left: `${left}%` }}
                title={`${label} crossing`}
              >
                <span className="block font-mono font-semibold text-text">
                  {fmtMinutes(v)}
                </span>
                <span className="block text-[9px] uppercase tracking-wider">
                  {label}
                </span>
              </span>
            );
          })}
          <span
            className="absolute right-0 hidden whitespace-nowrap md:inline"
            aria-hidden="true"
          >
            {fmtMinutes(ceiling)}
          </span>
        </div>
      </div>
    </div>
  );
}

function CompactStrip({
  bands,
  crossings,
  clampPct,
  totalFinal,
  finalPhaseDistribution,
  maxFinal,
}: {
  bands: BandSpec[];
  crossings: PhaseTrajectoryStripProps["crossings"];
  clampPct: (t: number) => number;
  totalFinal: number;
  finalPhaseDistribution: Record<Phase, number>;
  maxFinal: number;
}) {
  const safeTotal = Math.max(1, totalFinal);
  const bandsAriaLabel =
    "Phase bands: " +
    bands
      .map((b) => {
        const w = clampPct(b.end) - clampPct(b.start);
        return `${PHASE_LABELS[b.phase]} ${Math.round(w)}%`;
      })
      .join(", ");
  // The compact variant collapses the two-row layout into a single
  // 24px-tall median-timing strip — used inside dense dossier views.
  // The full outcome bar would dominate the row, so we drop it; tests
  // for `phase-histogram` rely on it being absent here too.
  // We still emit the `phase-final-bar` data attributes inside the
  // band so callers can introspect counts at the data layer.
  return (
    <div
      role="img"
      aria-label={bandsAriaLabel}
      className="relative w-full overflow-hidden rounded"
      style={{ height: 24 }}
      data-testid="phase-bands"
      data-compact="1"
    >
      {bands.map((b) => {
        const startPct = clampPct(b.start);
        const widthPct = Math.max(0, clampPct(b.end) - startPct);
        const count = finalPhaseDistribution[b.phase] ?? 0;
        const pct = totalFinal > 0 ? (count / safeTotal) * 100 : 0;
        const heightPct =
          maxFinal > 0 ? (count / maxFinal) * 100 : 0;
        return (
          <div
            key={b.phase}
            className="absolute top-0 h-full"
            style={{
              left: `${startPct}%`,
              width: `${widthPct}%`,
              background: PHASE_BAND_FILLS[b.phase],
            }}
            data-testid="phase-band"
            data-phase={b.phase}
            data-width-pct={widthPct}
            title={`${PHASE_LABELS[b.phase]} band`}
          >
            <span
              className="hidden"
              data-testid="phase-final-bar"
              data-phase={b.phase}
              data-count={count}
              data-pct={pct.toFixed(2)}
              data-height-pct={heightPct}
            />
          </div>
        );
      })}
      {CROSSING_ORDER.map(({ key, label }) => {
        const v = crossings[key];
        if (v == null) return null;
        const left = clampPct(v);
        return (
          <span
            key={key}
            className="absolute top-0 h-full w-px"
            style={{ left: `${left}%`, background: "rgb(var(--text))" }}
            title={`${label} crossing at ${fmtMinutes(v)}`}
            data-testid="phase-crossing"
            data-key={key}
            data-at-pct={left}
            aria-hidden="true"
          />
        );
      })}
    </div>
  );
}
