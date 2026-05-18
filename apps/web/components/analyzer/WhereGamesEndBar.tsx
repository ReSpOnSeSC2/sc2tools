"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * Stacked outcome bar showing what phase games against an opponent
 * ended in. Click (or tap) a sliver to highlight it and surface a
 * popover with the exact game count and percentage; click outside,
 * click the sliver again, or press Escape to dismiss.
 *
 * The popover anchor is clamped to the bar's bounds at measure time
 * so it never bleeds past the card; the callout arrow tracks the
 * actual sliver center so the connection stays legible even on
 * narrow viewports.
 */

type Phase = "early" | "earlyMid" | "mid" | "midLate" | "late";

const PHASE_ORDER: Phase[] = ["early", "earlyMid", "mid", "midLate", "late"];
const PHASE_LABEL: Record<Phase, string> = {
  early: "Early",
  earlyMid: "Early/Mid",
  mid: "Mid",
  midLate: "Mid/Late",
  late: "Late",
};
const PHASE_DIST_COLOR: Record<Phase, string> = {
  early: "rgb(var(--danger))",
  earlyMid: "rgb(var(--warning))",
  mid: "rgb(var(--accent))",
  midLate: "rgb(var(--accent-cyan))",
  late: "rgb(var(--success))",
};
const PHASE_DIST_COLOR_SOFT: Record<Phase, string> = {
  early: "rgb(var(--danger) / 0.35)",
  earlyMid: "rgb(var(--warning) / 0.35)",
  mid: "rgb(var(--accent) / 0.35)",
  midLate: "rgb(var(--accent-cyan) / 0.35)",
  late: "rgb(var(--success) / 0.35)",
};

export interface WhereGamesEndBarProps {
  finalPhaseDistribution?: Partial<Record<Phase, number>>;
}

type Segment = {
  phase: Phase;
  count: number;
  pct: number;
  start: number;
  center: number;
};

type PopoverGeom = {
  popoverLeft: number;
  arrowLeft: number;
};

export function WhereGamesEndBar({
  finalPhaseDistribution,
}: WhereGamesEndBarProps) {
  const dist = finalPhaseDistribution || {};
  const total = PHASE_ORDER.reduce((acc, p) => acc + (dist[p] || 0), 0);
  const [selected, setSelected] = useState<Phase | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const popoverId = useId();

  const segments = useMemo<Segment[]>(() => {
    if (total <= 0) return [];
    let cum = 0;
    const out: Segment[] = [];
    for (const p of PHASE_ORDER) {
      const v = dist[p] || 0;
      if (v <= 0) continue;
      const pct = (v / total) * 100;
      out.push({
        phase: p,
        count: v,
        pct,
        start: cum,
        center: cum + pct / 2,
      });
      cum += pct;
    }
    return out;
  }, [dist, total]);

  const selectedSeg = useMemo(
    () => segments.find((s) => s.phase === selected) ?? null,
    [segments, selected],
  );

  useEffect(() => {
    if (!selected) return;
    function onPointerDown(e: PointerEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) {
        setSelected(null);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setSelected(null);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [selected]);

  // Drop a selection that no longer maps to a visible segment (e.g.,
  // upstream data refresh).
  useEffect(() => {
    if (selected && !segments.some((s) => s.phase === selected)) {
      setSelected(null);
    }
  }, [segments, selected]);

  const [geom, setGeom] = useState<PopoverGeom | null>(null);

  const measure = useCallback(() => {
    const bar = barRef.current;
    const pop = popoverRef.current;
    if (!selectedSeg || !bar || !pop) return;
    const barW = bar.clientWidth;
    if (barW <= 0) return;
    const popW = pop.offsetWidth;
    const sliverCenterPx = (selectedSeg.center / 100) * barW;
    const halfPop = popW / 2;
    const PAD = 4;
    let popoverLeft: number;
    if (popW + PAD * 2 >= barW) {
      popoverLeft = barW / 2;
    } else {
      popoverLeft = Math.max(
        halfPop + PAD,
        Math.min(barW - halfPop - PAD, sliverCenterPx),
      );
    }
    const rawArrow = sliverCenterPx - (popoverLeft - halfPop);
    const arrowLeft = Math.max(10, Math.min(popW - 10, rawArrow));
    setGeom((prev) =>
      prev &&
      Math.abs(prev.popoverLeft - popoverLeft) < 0.5 &&
      Math.abs(prev.arrowLeft - arrowLeft) < 0.5
        ? prev
        : { popoverLeft, arrowLeft },
    );
  }, [selectedSeg]);

  useLayoutEffect(() => {
    if (!selectedSeg) {
      setGeom(null);
      return;
    }
    measure();
    const target = wrapperRef.current;
    if (typeof ResizeObserver === "undefined" || !target) return;
    const ro = new ResizeObserver(measure);
    ro.observe(target);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [selectedSeg, measure]);

  if (total === 0) return null;

  const selectedColor = selectedSeg
    ? PHASE_DIST_COLOR[selectedSeg.phase]
    : null;

  return (
    <div ref={wrapperRef} className="space-y-1.5">
      <div className="flex items-center justify-end text-caption text-text-dim">
        <span>{total} games</span>
      </div>

      <div className="relative py-1.5">
        <div
          ref={barRef}
          className="relative flex h-3 w-full rounded-full border border-border bg-bg-surface"
          role="group"
          aria-label="Phase the game ended in, across all matches"
        >
          {segments.map((seg, i) => {
            const isFirst = i === 0;
            const isLast = i === segments.length - 1;
            const isSelected = selected === seg.phase;
            const isDimmed = selected !== null && !isSelected;
            const color = PHASE_DIST_COLOR[seg.phase];
            const soft = PHASE_DIST_COLOR_SOFT[seg.phase];
            return (
              <button
                key={seg.phase}
                type="button"
                onClick={() => setSelected(isSelected ? null : seg.phase)}
                aria-pressed={isSelected}
                aria-controls={isSelected ? popoverId : undefined}
                aria-label={`${PHASE_LABEL[seg.phase]}: ${seg.count} game${
                  seg.count === 1 ? "" : "s"
                }, ${Math.round(seg.pct)} percent`}
                title={`${PHASE_LABEL[seg.phase]}: ${seg.count} game${
                  seg.count === 1 ? "" : "s"
                } (${Math.round(seg.pct)}%)`}
                data-testid="phase-final-bar"
                data-phase={seg.phase}
                data-selected={isSelected ? "1" : "0"}
                className="relative h-full cursor-pointer transition-[opacity,box-shadow,filter] duration-200 hover:brightness-110"
                style={{
                  width: `${seg.pct}%`,
                  backgroundColor: color,
                  opacity: isDimmed ? 0.32 : 1,
                  borderTopLeftRadius: isFirst ? 9999 : 0,
                  borderBottomLeftRadius: isFirst ? 9999 : 0,
                  borderTopRightRadius: isLast ? 9999 : 0,
                  borderBottomRightRadius: isLast ? 9999 : 0,
                  zIndex: isSelected ? 2 : 1,
                  boxShadow: isSelected
                    ? `0 0 0 2px rgb(var(--bg-surface)), 0 0 0 4px ${color}, 0 0 22px 2px ${soft}`
                    : "none",
                }}
              >
                {/* Pointer-events extender. Stretches the tap target
                 *  downward by 12px and a hair upward (within the
                 *  wrapper's py-1.5 cushion, so it never reaches the
                 *  "N games" label above). Pointer events bubble to
                 *  the button. */}
                <span
                  aria-hidden
                  className="absolute -bottom-3 -top-1 left-0 right-0"
                />
              </button>
            );
          })}
        </div>

        {selectedSeg && selectedColor ? (
          <div
            id={popoverId}
            role="status"
            aria-live="polite"
            className="pointer-events-none absolute left-0 right-0 top-full z-20"
            style={{ marginTop: 10 }}
          >
            <div
              ref={popoverRef}
              className="pointer-events-auto absolute transition-[left] duration-150"
              style={{
                left: geom ? `${geom.popoverLeft}px` : "50%",
                transform: "translateX(-50%)",
                maxWidth: "calc(100% - 8px)",
                visibility: geom ? "visible" : "hidden",
              }}
            >
              <div
                className="relative flex items-center gap-2 rounded-lg border border-border bg-bg-surface px-3 py-1.5 shadow-[var(--shadow-card)]"
                style={{
                  boxShadow: `0 0 0 1px ${selectedColor}, 0 0 24px ${PHASE_DIST_COLOR_SOFT[selectedSeg.phase]}`,
                }}
              >
                <span
                  aria-hidden
                  className="block h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: selectedColor }}
                />
                <span className="text-caption font-semibold uppercase tracking-wider text-text">
                  {PHASE_LABEL[selectedSeg.phase]}
                </span>
                <span className="font-mono tabular-nums text-text">
                  <span className="text-sm font-semibold">
                    {selectedSeg.count}
                  </span>
                  <span className="ml-1 text-caption text-text-muted">
                    game{selectedSeg.count === 1 ? "" : "s"}
                  </span>
                  <span className="ml-1.5 text-caption text-text-dim">
                    · {Math.round(selectedSeg.pct)}%
                  </span>
                </span>
                <span
                  aria-hidden
                  className="absolute -top-1 h-2 w-2 rotate-45 bg-bg-surface transition-[left] duration-150"
                  style={{
                    left: geom ? `${geom.arrowLeft}px` : "50%",
                    marginLeft: -4,
                    boxShadow: `-1px -1px 0 0 ${selectedColor}`,
                  }}
                />
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-x-2 gap-y-1 text-caption text-text-dim">
        {segments.map((seg) => {
          const isSelected = selected === seg.phase;
          return (
            <button
              key={seg.phase}
              type="button"
              onClick={() => setSelected(isSelected ? null : seg.phase)}
              aria-pressed={isSelected}
              className={[
                "inline-flex min-h-[28px] items-center gap-1.5 rounded-md px-2 py-1",
                "tabular-nums transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                isSelected
                  ? "bg-bg-elevated text-text"
                  : "hover:bg-bg-elevated",
              ].join(" ")}
            >
              <span
                aria-hidden
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: PHASE_DIST_COLOR[seg.phase] }}
              />
              <span>{PHASE_LABEL[seg.phase]}</span>
              <span className="text-text">{seg.count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
