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
};

const PHASE_ORDER: Phase[] = ["early", "earlyMid", "mid", "midLate", "late"];

const PHASE_LABELS: Record<Phase, string> = {
  early: "Early",
  earlyMid: "Early/Mid",
  mid: "Mid",
  midLate: "Mid/Late",
  late: "Late",
};

const PHASE_FILLS: Record<Phase, string> = {
  early: "rgb(var(--text-muted) / 0.18)",
  earlyMid: "rgb(var(--accent) / 0.20)",
  mid: "rgb(var(--accent-cyan) / 0.28)",
  midLate: "rgb(var(--warning) / 0.22)",
  late: "rgb(var(--warning) / 0.32)",
};

const HIST_COLOR = "rgb(var(--accent-cyan))";
const CROSSING_COLOR = "rgb(var(--text))";

const CROSSING_ORDER: Array<{
  key: keyof PhaseTrajectoryStripProps["crossings"];
  label: string;
}> = [
  { key: "earlyMidAt", label: "Early/Mid" },
  { key: "midAt", label: "Mid" },
  { key: "midLateAt", label: "Mid/Late" },
  { key: "lateAt", label: "Late" },
];

type BandSpec = { phase: Phase; start: number; end: number };

export function PhaseTrajectoryStrip({
  sampleSize,
  crossings,
  finalPhaseDistribution,
  durationP95Sec,
  className,
  compact = false,
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

  // For null crossings (phase never reached on this build), pin to the
  // ceiling so subsequent bands collapse to 0 width rather than NaN.
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

  const bandsAriaLabel =
    "Phase bands: " +
    bands
      .map((b) => {
        const w = clampPct(b.end) - clampPct(b.start);
        return `${PHASE_LABELS[b.phase]} ${Math.round(w)}%`;
      })
      .join(", ");

  const figureClass = ["w-full", className].filter(Boolean).join(" ");

  return (
    <figure className={figureClass} data-testid="phase-trajectory-strip">
      <figcaption className="sr-only">{caption}</figcaption>
      {compact ? (
        <CompactStrip
          bands={bands}
          crossings={crossings}
          clampPct={clampPct}
          bandsAriaLabel={bandsAriaLabel}
        />
      ) : (
        <FullStrip
          bands={bands}
          crossings={crossings}
          ceiling={ceiling}
          clampPct={clampPct}
          bandsAriaLabel={bandsAriaLabel}
          finalPhaseDistribution={finalPhaseDistribution}
          maxFinal={maxFinal}
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
  bandsAriaLabel,
  finalPhaseDistribution,
  maxFinal,
}: {
  bands: BandSpec[];
  crossings: PhaseTrajectoryStripProps["crossings"];
  ceiling: number;
  clampPct: (t: number) => number;
  bandsAriaLabel: string;
  finalPhaseDistribution: Record<Phase, number>;
  maxFinal: number;
}) {
  const tickCount = Math.floor(ceiling / 60) + 1;
  return (
    <div className="relative">
      <div
        className="relative w-full"
        style={{ height: 48 }}
        data-testid="phase-histogram"
      >
        {bands.map((b) => {
          const startPct = clampPct(b.start);
          const widthPct = Math.max(0, clampPct(b.end) - startPct);
          const count = finalPhaseDistribution[b.phase] ?? 0;
          const heightPct = maxFinal > 0 ? (count / maxFinal) * 100 : 0;
          return (
            <div
              key={b.phase}
              className="absolute bottom-0 flex h-full justify-center"
              style={{ left: `${startPct}%`, width: `${widthPct}%` }}
              aria-hidden="true"
            >
              <div
                className="self-end rounded-t"
                title={`${PHASE_LABELS[b.phase]}: ${count} game${
                  count === 1 ? "" : "s"
                } ended here`}
                style={{
                  width: "min(60%, 22px)",
                  height: `${heightPct}%`,
                  background: HIST_COLOR,
                  opacity: count === 0 ? 0 : 0.85,
                }}
                data-testid="phase-final-bar"
                data-phase={b.phase}
                data-count={count}
                data-height-pct={heightPct}
              />
            </div>
          );
        })}
      </div>

      <div
        role="img"
        aria-label={bandsAriaLabel}
        className="relative h-7 w-full overflow-hidden rounded-md border border-border"
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
                background: PHASE_FILLS[b.phase],
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
              className="absolute top-0 h-full w-px"
              style={{ left: `${left}%`, background: CROSSING_COLOR }}
              title={`${label} crossing at ${fmtMinutes(v)}`}
              data-testid="phase-crossing"
              data-key={key}
              data-at-pct={left}
              aria-hidden="true"
            />
          );
        })}
      </div>

      <div
        className="relative mt-1 h-4 w-full text-[10px] tabular-nums text-text-dim"
        data-testid="phase-labels"
      >
        <span className="absolute left-0 whitespace-nowrap" aria-hidden="true">
          0:00
        </span>
        {CROSSING_ORDER.map(({ key, label }) => {
          const v = crossings[key];
          if (v == null) return null;
          const left = clampPct(v);
          return (
            <span
              key={`label-${key}`}
              className="absolute -translate-x-1/2 whitespace-nowrap"
              style={{ left: `${left}%` }}
              title={`${label} crossing`}
            >
              {fmtMinutes(v)}
            </span>
          );
        })}
        <span
          className="absolute right-0 whitespace-nowrap"
          aria-hidden="true"
        >
          {fmtMinutes(ceiling)}
        </span>
      </div>
    </div>
  );
}

function CompactStrip({
  bands,
  crossings,
  clampPct,
  bandsAriaLabel,
}: {
  bands: BandSpec[];
  crossings: PhaseTrajectoryStripProps["crossings"];
  clampPct: (t: number) => number;
  bandsAriaLabel: string;
}) {
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
        return (
          <div
            key={b.phase}
            className="absolute top-0 h-full"
            style={{
              left: `${startPct}%`,
              width: `${widthPct}%`,
              background: PHASE_FILLS[b.phase],
            }}
            data-testid="phase-band"
            data-phase={b.phase}
            data-width-pct={widthPct}
            title={`${PHASE_LABELS[b.phase]} band`}
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
            className="absolute top-0 h-full w-px"
            style={{ left: `${left}%`, background: CROSSING_COLOR }}
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
