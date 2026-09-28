"use client";

/**
 * The macro timeline (`OfflineMacroChart`: the analyzer's army /
 * workers / income chart with supply blocks and its unit, building and
 * upgrade roster) for one /try game, loaded on demand with next/dynamic
 * so its code is only fetched once a game is shown. A skeleton of the
 * chart's own height holds the space while it loads, so nothing below
 * it jumps. Everything it draws comes from the local payload; it makes
 * no request. An error boundary keeps a chart failure inside the chart:
 * the rest of the report (and its unsaved games) stays usable.
 *
 * Example:
 *   const props = macroChartProps(payload, gameBuilds(payload));
 *   {props ? <LazyMacroChart {...props} /> : null}
 */
import dynamic from "next/dynamic";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import type { OfflineMacroChartProps } from "@/lib/instant/reportGameDetail";

/*
 * Skeleton heights, measured on the real chart (1280 × 800 and 360 × 800):
 * the header wraps to two lines on phones; the chart block is the canvas
 * (`ActiveArmyChart`'s responsive clamp) plus its metric switch and
 * summary; the roster wraps into more rows on phones.
 */
const HEADER_HEIGHT_CLASS = "h-16 sm:h-6";
const CHART_HEIGHT_CLASS = "h-[calc(clamp(180px,28vh,260px)_+_120px)] sm:h-[calc(clamp(260px,44vh,460px)_+_112px)]";
const ROSTER_HEIGHT_CLASS = "h-[40rem] sm:h-[17rem]";
const BLOCK_CLASS = "w-full animate-pulse rounded-lg bg-bg-elevated motion-reduce:animate-none";

/**
 * Placeholder with the chart's footprint (reduced motion: no pulse).
 *
 * Example:
 *   <MacroChartSkeleton />
 */
export function MacroChartSkeleton() {
  return (
    <div role="status" aria-label="Loading the macro timeline" className="space-y-3 px-4 sm:px-0" data-testid="macro-chart-skeleton">
      <div className={["w-48 rounded bg-bg-elevated", HEADER_HEIGHT_CLASS].join(" ")} />
      <div className={[BLOCK_CLASS, CHART_HEIGHT_CLASS].join(" ")} />
      <div className={[BLOCK_CLASS, ROSTER_HEIGHT_CLASS].join(" ")} />
    </div>
  );
}

const OfflineMacroChart = dynamic(() => import("./OfflineMacroChart").then((mod) => mod.OfflineMacroChart), {
  ssr: false,
  loading: () => <MacroChartSkeleton />,
});

/**
 * The macro timeline for one game, code-split and fenced by an error
 * boundary.
 *
 * Example:
 *   <LazyMacroChart samples={samples} oppSamples={oppSamples} leaks={[]} buildOrder={{ events: [] }} />
 */
export function LazyMacroChart(props: OfflineMacroChartProps) {
  return (
    <ErrorBoundary label="the macro timeline">
      <OfflineMacroChart {...props} />
    </ErrorBoundary>
  );
}
