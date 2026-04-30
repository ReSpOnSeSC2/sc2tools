/**
 * ChronoAllocationPanel + SpendingEfficiencyChart — extracted from index.html.
 *
 * Loaded from index.html via:
 *   <script type="text/babel" data-presets="react" src="..."></script>
 *
 * Babel-standalone compiles JSX in this file before execution.
 * The IIFE wrapper isolates lexical scope from the inline block in
 * index.html (which has its own `const { useState, ... } = React;`),
 * preventing redeclaration errors. Each exported component / helper
 * is attached to `window` at the bottom so the inline block's bare
 * JSX identifiers (e.g. `<FooBar />`) resolve via the global object
 * at render time.
 *
 * DO NOT EDIT THE EXTRACTED BODY HERE WITHOUT ALSO UPDATING THE
 * MATCHING SECTION IN index.html — the two MUST NOT BOTH EXIST.
 */
(function () {
  "use strict";
  const React = window.React;
  const { useState, useEffect, useMemo, useCallback, useRef, Fragment } = React;


      // Renders a click-to-expand macro breakdown panel for one game. Reuses
      // the /games/:id/build-order payload (which now includes top_3_leaks and
      // macro_breakdown). For games without a stored breakdown, offers a
      // ChronoAllocationPanel — Protoss-only donut + table that
      // shows where each chrono boost landed by target building.
      // Reads ``raw.chrono_targets`` (emitted by macro_score for
      // race=="Protoss") which is a list of {building_name, count}
      // sorted by count desc. Donut renders top-5 + an "Other"
      // bucket aggregating the long tail; the table shows EVERY
      // row so absolute counts always reconcile to the chrono total.
      // Targets sc2reader could not resolve bucket as "Unknown" —
      // we never invent a name (preamble hard rule #1: real data only).
      function ChronoAllocationPanel({ targets }) {
        if (!Array.isArray(targets) || targets.length === 0) return null;
        const total = targets.reduce(
          (s, t) => s + (Number(t && t.count) || 0), 0);
        if (total <= 0) return null;

        // Top-5 head, "Other" bucket for the tail in the donut.
        const TOP_N = 5;
        const tableRows = targets.map((t) => ({
          building_name: String(t.building_name || "Unknown"),
          count: Number(t.count) || 0,
          pct: (100 * (Number(t.count) || 0)) / total,
        }));
        const head = tableRows.slice(0, TOP_N);
        const tail = tableRows.slice(TOP_N);
        const tailCount = tail.reduce((s, r) => s + r.count, 0);
        const donutSlices = head.slice();
        if (tail.length > 0 && tailCount > 0) {
          donutSlices.push({
            building_name: "Other",
            count: tailCount,
            pct: (100 * tailCount) / total,
          });
        }

        // Color map keyed by building name. Unrecognized buildings
        // (e.g. ShieldBattery, Pylon) fall back to "other"; the
        // explicit "Unknown" sc2reader-couldn't-resolve bucket
        // gets its own neutral grey so it reads as distinct from
        // small-volume known targets.
        const COLOR_TOKENS = {
          Nexus:             "var(--color-chrono-probe)",
          Gateway:           "var(--color-chrono-gateway)",
          WarpGate:          "var(--color-chrono-gateway)",
          RoboticsFacility:  "var(--color-chrono-robo)",
          RoboticsBay:       "var(--color-chrono-robo)",
          Stargate:          "var(--color-chrono-stargate)",
          FleetBeacon:       "var(--color-chrono-stargate)",
          Forge:             "var(--color-chrono-forge)",
          CyberneticsCore:   "var(--color-chrono-forge)",
          TwilightCouncil:   "var(--color-chrono-tech)",
          TemplarArchive:    "var(--color-chrono-tech)",
          DarkShrine:        "var(--color-chrono-tech)",
          Other:             "var(--color-chrono-other)",
          Unknown:           "var(--color-chrono-unknown)",
        };
        const colorFor = (name) =>
          COLOR_TOKENS[name] || "var(--color-chrono-other)";

        // SVG donut geometry. 100x100 viewBox, radius 36, stroke 18.
        // Slices stack via stroke-dasharray + dashoffset accumulation;
        // rotate(-90) puts the start at 12 o'clock. No transitions or
        // animations, so prefers-reduced-motion is satisfied by default.
        const RADIUS = 36;
        const STROKE_WIDTH = 18;
        const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
        let cumulative = 0;
        const svgSlices = donutSlices.map((s, idx) => {
          const dash = (s.pct / 100) * CIRCUMFERENCE;
          const gap = CIRCUMFERENCE - dash;
          const offset = -((cumulative / 100) * CIRCUMFERENCE);
          cumulative += s.pct;
          return (
            <circle
              key={idx}
              cx="50" cy="50" r={RADIUS}
              fill="none"
              stroke={colorFor(s.building_name)}
              strokeWidth={STROKE_WIDTH}
              strokeDasharray={`${dash} ${gap}`}
              strokeDashoffset={offset}
              transform="rotate(-90 50 50)"
            />
          );
        });

        return (
          <div
            className="bg-base-800 rounded p-3"
            role="region"
            aria-label="Chrono Boost allocation by target building"
          >
            <div className="text-[11px] uppercase tracking-wider text-neutral-500 mb-2">
              Chrono allocation
            </div>
            <div className="text-xs text-neutral-400 mb-3">
              Where your {total} chrono cast{total === 1 ? "" : "s"} landed.
              Buildings under construction count under their final name;
              targets sc2reader could not resolve bucket as
              <span className="text-neutral-300"> Unknown</span>.
            </div>
            <div className="flex flex-col md:flex-row gap-4 items-center md:items-start">
              <div className="flex-shrink-0" aria-hidden="true">
                <svg
                  viewBox="0 0 100 100"
                  width="160"
                  height="160"
                  style={{ display: "block" }}
                >
                  <circle
                    cx="50" cy="50" r={RADIUS}
                    fill="none"
                    stroke="var(--color-border-subtle)"
                    strokeWidth={STROKE_WIDTH}
                  />
                  {svgSlices}
                  <text
                    x="50" y="48"
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill="var(--color-text-primary)"
                    style={{
                      fontSize: "14px",
                      fontWeight: 700,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {total}
                  </text>
                  <text
                    x="50" y="60"
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill="var(--color-text-muted)"
                    style={{ fontSize: "7px", letterSpacing: "0.05em" }}
                  >
                    CHRONOS
                  </text>
                </svg>
              </div>
              <div className="flex-1 w-full">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wider text-neutral-500">
                      <th className="text-left py-1 font-normal">Target</th>
                      <th className="text-right py-1 font-normal w-16">% share</th>
                      <th className="text-right py-1 font-normal w-12">#</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-base-700">
                    {tableRows.map((row, i) => (
                      <tr key={i}>
                        <td className="py-1 text-neutral-200">
                          <span
                            aria-hidden="true"
                            style={{
                              display: "inline-block",
                              width: "8px",
                              height: "8px",
                              borderRadius: "2px",
                              background: colorFor(row.building_name),
                              marginRight: "8px",
                              verticalAlign: "middle",
                            }}
                          />
                          {row.building_name}
                        </td>
                        <td className="py-1 text-right tabular-nums text-neutral-300">
                          {row.pct.toFixed(1)}%
                        </td>
                        <td className="py-1 text-right tabular-nums text-neutral-200">
                          {row.count}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        );
      }

      // =====================================================================
      // Spending Efficiency over time (Stage 6.5).
      //
      // Pure SVG line chart of the player's smoothed Spending Quotient (SQ)
      // sampled per PlayerStatsEvent and centered-mean-smoothed by the macro
      // engine. Red bands overlay every "leak window" — contiguous 30s
      // stretches where smoothed_sq < 50 AND avg_unspent > 600. Clicking a
      // band fires window event 'sc2:focus-build-order' (consumed by
      // BuildOrderTimeline) so the matching build-order events scroll into
      // view and highlight.
      //
      // Real data only: when stats_events is empty (older replay or
      // PlayerStatsEvent stream missing), the chart renders an em-dash
      // placeholder with a tooltip explaining why.
      // =====================================================================
      const SQ_CHART_VIEW_W = 800;
      const SQ_CHART_VIEW_H = 200;
      const SQ_CHART_PAD_LEFT = 40;
      const SQ_CHART_PAD_RIGHT = 16;
      const SQ_CHART_PAD_TOP = 12;
      const SQ_CHART_PAD_BOTTOM = 28;
      // SQ axis bounds. Real-world SQ is ~30..115 but we hard-clamp the
      // visible range so a single warmup spike doesn't crush the curve.
      const SQ_AXIS_MIN = 0;
      const SQ_AXIS_MAX = 120;
      const SQ_LEAK_THRESHOLD = 50;
      const SQ_TICK_VALUES = [0, 25, 50, 75, 100];

      function _sqYProject(value, plotTop, plotBottom) {
        const v = Math.max(SQ_AXIS_MIN, Math.min(SQ_AXIS_MAX, Number(value) || 0));
        const range = SQ_AXIS_MAX - SQ_AXIS_MIN;
        const pct = range > 0 ? (v - SQ_AXIS_MIN) / range : 0;
        return plotBottom - pct * (plotBottom - plotTop);
      }

      function _sqXProject(timeSec, gameLengthSec, plotLeft, plotRight) {
        const denom = Math.max(1, Number(gameLengthSec) || 1);
        const t = Math.max(0, Math.min(denom, Number(timeSec) || 0));
        return plotLeft + (t / denom) * (plotRight - plotLeft);
      }

      function _sqLinePoints(samples, gameLengthSec, plotLeft, plotRight, plotTop, plotBottom) {
        if (!Array.isArray(samples) || samples.length === 0) return [];
        const out = [];
        for (const s of samples) {
          const sm = s && (s.smoothed_sq != null ? s.smoothed_sq : s.instantaneous_sq);
          if (sm == null) continue;
          out.push([
            _sqXProject(s.time, gameLengthSec, plotLeft, plotRight),
            _sqYProject(sm, plotTop, plotBottom),
          ]);
        }
        return out;
      }

      function _sqPathD(points) {
        if (!points.length) return "";
        return points
          .map(
            (p, i) =>
              `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`,
          )
          .join(" ");
      }

      function SpendingEfficiencyChart({
        gameId,
        statsEvents,
        oppStatsEvents,
        leakWindows,
        oppLeakWindows,
        gameLengthSec,
        myColor,
        oppColor,
      }) {
        const mySamples = Array.isArray(statsEvents) ? statsEvents : [];
        const oppSamples = Array.isArray(oppStatsEvents) ? oppStatsEvents : [];
        const myLeaks = Array.isArray(leakWindows) ? leakWindows : [];
        const oppLeaks = Array.isArray(oppLeakWindows) ? oppLeakWindows : [];

        // Empty state — real data only, never synthesize.
        const haveMine = mySamples.some((s) => s && s.smoothed_sq != null);
        const haveOpp = oppSamples.some((s) => s && s.smoothed_sq != null);
        if (!haveMine && !haveOpp) {
          return (
            <div
              className="bg-base-900 ring-soft rounded-lg p-3 my-2 border border-base-700 text-xs text-neutral-500"
              title="PlayerStatsEvent samples not available for this replay — instantaneous SQ cannot be computed."
            >
              <span className="text-[11px] uppercase tracking-wider text-neutral-500 mr-2">
                Spending efficiency over time
              </span>
              <span className="font-mono text-neutral-400">—</span>
            </div>
          );
        }

        // Game length: prefer the prop, fall back to the latest sample time.
        const inferredEnd = Math.max(
          ...mySamples.map((s) => Number(s.time) || 0),
          ...oppSamples.map((s) => Number(s.time) || 0),
          1,
        );
        const gl = Number(gameLengthSec) > 0 ? Number(gameLengthSec) : inferredEnd;

        const plotLeft = SQ_CHART_PAD_LEFT;
        const plotRight = SQ_CHART_VIEW_W - SQ_CHART_PAD_RIGHT;
        const plotTop = SQ_CHART_PAD_TOP;
        const plotBottom = SQ_CHART_VIEW_H - SQ_CHART_PAD_BOTTOM;

        const myPoints = _sqLinePoints(mySamples, gl, plotLeft, plotRight, plotTop, plotBottom);
        const oppPoints = _sqLinePoints(oppSamples, gl, plotLeft, plotRight, plotTop, plotBottom);

        const myStroke = myColor || "var(--color-success)";
        const oppStroke = oppColor || "var(--color-text-muted)";
        const leakFill = "var(--color-danger)";

        const handleLeakClick = (window_, isMine) => {
          if (!isMine) return; // only my leaks deep-link to my build order
          try {
            window.dispatchEvent(
              new CustomEvent("sc2:focus-build-order", {
                detail: {
                  gameId,
                  start: Number(window_.start) || 0,
                  end: Number(window_.end) || 0,
                },
              }),
            );
          } catch (_e) {
            // Older browsers / sandboxed iframes that disallow CustomEvent
            // construction silently no-op rather than throwing into the
            // React tree and crashing the whole panel.
          }
        };

        const formatClock = (sec) => {
          const s = Math.max(0, Math.floor(Number(sec) || 0));
          return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
        };

        return (
          <div className="bg-base-900 ring-soft rounded-lg p-3 my-2 border border-base-700">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <span className="text-[11px] uppercase tracking-wider text-neutral-500">
                Spending efficiency over time
              </span>
              <span className="text-[11px] text-neutral-500">
                Smoothed SQ • red bands = leak windows
              </span>
              {myLeaks.length > 0 && (
                <span className="ml-auto text-[11px] text-loss-500 tabular-nums">
                  {myLeaks.length} leak{myLeaks.length === 1 ? "" : "s"}
                </span>
              )}
            </div>
            <svg
              viewBox={`0 0 ${SQ_CHART_VIEW_W} ${SQ_CHART_VIEW_H}`}
              className="w-full"
              style={{ maxHeight: SQ_CHART_VIEW_H }}
              role="img"
              aria-label="Spending efficiency over time"
            >
              {/* Leak threshold reference line at SQ=50. */}
              <line
                x1={plotLeft}
                x2={plotRight}
                y1={_sqYProject(SQ_LEAK_THRESHOLD, plotTop, plotBottom)}
                y2={_sqYProject(SQ_LEAK_THRESHOLD, plotTop, plotBottom)}
                stroke="var(--color-border-subtle)"
                strokeWidth="1"
                strokeDasharray="4 3"
              />
              {/* Y-axis ticks. */}
              {SQ_TICK_VALUES.map((tv) => (
                <g key={`ytick-${tv}`}>
                  <line
                    x1={plotLeft - 3}
                    x2={plotLeft}
                    y1={_sqYProject(tv, plotTop, plotBottom)}
                    y2={_sqYProject(tv, plotTop, plotBottom)}
                    stroke="var(--color-text-muted)"
                    strokeWidth="1"
                  />
                  <text
                    x={plotLeft - 6}
                    y={_sqYProject(tv, plotTop, plotBottom) + 3}
                    textAnchor="end"
                    fontSize="10"
                    fill="var(--color-text-secondary)"
                  >
                    {tv}
                  </text>
                </g>
              ))}
              {/* Opponent leak bands: dimmed, non-interactive. */}
              {oppLeaks.map((lk, i) => {
                const x1 = _sqXProject(lk.start, gl, plotLeft, plotRight);
                const x2 = _sqXProject(lk.end, gl, plotLeft, plotRight);
                return (
                  <rect
                    key={`opp-leak-${i}`}
                    x={x1}
                    y={plotTop}
                    width={Math.max(1, x2 - x1)}
                    height={plotBottom - plotTop}
                    fill={leakFill}
                    fillOpacity="0.10"
                  />
                );
              })}
              {/* My leak bands: clickable, brighter. */}
              {myLeaks.map((lk, i) => {
                const x1 = _sqXProject(lk.start, gl, plotLeft, plotRight);
                const x2 = _sqXProject(lk.end, gl, plotLeft, plotRight);
                const w = Math.max(2, x2 - x1);
                return (
                  <g
                    key={`my-leak-${i}`}
                    style={{ cursor: "pointer" }}
                    onClick={() => handleLeakClick(lk, true)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleLeakClick(lk, true);
                      }
                    }}
                    aria-label={`Leak window from ${formatClock(lk.start)} to ${formatClock(lk.end)}, click to focus build order`}
                  >
                    <title>{`Leak ${formatClock(lk.start)}-${formatClock(lk.end)} • avg unspent ${Math.round(lk.avg_unspent || 0)} • avg income ${Math.round(lk.avg_income || 0)}/min — click to focus build order`}</title>
                    <rect
                      x={x1}
                      y={plotTop}
                      width={w}
                      height={plotBottom - plotTop}
                      fill={leakFill}
                      fillOpacity="0.22"
                    />
                    <rect
                      x={x1}
                      y={plotBottom - 3}
                      width={w}
                      height={3}
                      fill={leakFill}
                      fillOpacity="0.95"
                    />
                  </g>
                );
              })}
              {/* Opponent line (dimmed) under my line. */}
              {oppPoints.length > 1 && (
                <path
                  d={_sqPathD(oppPoints)}
                  fill="none"
                  stroke={oppStroke}
                  strokeWidth="1.5"
                  strokeOpacity="0.55"
                />
              )}
              {/* My line. */}
              {myPoints.length > 1 && (
                <path
                  d={_sqPathD(myPoints)}
                  fill="none"
                  stroke={myStroke}
                  strokeWidth="2"
                />
              )}
              {/* X axis baseline. */}
              <line
                x1={plotLeft}
                x2={plotRight}
                y1={plotBottom}
                y2={plotBottom}
                stroke="var(--color-border-default)"
                strokeWidth="1"
              />
              {/* X axis: minute ticks. */}
              {(() => {
                const ticks = [];
                const stepSec = 60;
                for (let t = 0; t <= gl; t += stepSec) {
                  const x = _sqXProject(t, gl, plotLeft, plotRight);
                  ticks.push(
                    <g key={`xtick-${t}`}>
                      <line
                        x1={x}
                        x2={x}
                        y1={plotBottom}
                        y2={plotBottom + 3}
                        stroke="var(--color-text-muted)"
                        strokeWidth="1"
                      />
                      <text
                        x={x}
                        y={plotBottom + 14}
                        textAnchor="middle"
                        fontSize="10"
                        fill="var(--color-text-secondary)"
                      >
                        {formatClock(t)}
                      </text>
                    </g>,
                  );
                }
                return ticks;
              })()}
              {/* Y axis title. */}
              <text
                x={plotLeft - 30}
                y={plotTop + (plotBottom - plotTop) / 2}
                fontSize="9"
                fill="var(--color-text-muted)"
                transform={`rotate(-90 ${plotLeft - 30} ${plotTop + (plotBottom - plotTop) / 2})`}
                textAnchor="middle"
              >
                SQ
              </text>
            </svg>
            {myLeaks.length === 0 && haveMine && (
              <div className="text-[10px] text-neutral-500 mt-1">
                No leak windows detected — sustained spending efficiency throughout.
              </div>
            )}
          </div>
        );
      }

  // Expose to global so inline-block JSX in index.html can render
  // these as bare identifiers.
  Object.assign(window, {
    ChronoAllocationPanel,
    SpendingEfficiencyChart
  });
})();
