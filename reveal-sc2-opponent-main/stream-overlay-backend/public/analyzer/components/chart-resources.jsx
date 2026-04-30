/**
 * Resources-over-time chart (ResourcesChartSvg + ResourcesOverTimeChart) — extracted from index.html.
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



      // =====================================================================
      // Resources-over-time chart (sibling to MacroBreakdownPanel inside the
      // GameDetailModal).
      //
      // Three lines per player on a shared time axis:
      //   - Income rate     = minerals_collection_rate + vespene_collection_rate
      //   - Unspent         = minerals_current + vespene_current
      //   - Used in progress = minerals_used_in_progress + vespene_used_in_progress
      //
      // Line style encodes ownership: dotted = me, solid = opp. Color encodes
      // which series. X-axis ticks every 60s. Right-side y-axis shows the
      // "good band" — income target = 60-80 minerals per worker per minute —
      // overlaid as a translucent green polygon at [60*workers, 80*workers]
      // on the user's worker count over time.
      //
      // Empty stats_events (older replays whose tracker stream had no
      // PlayerStatsEvent rows) → renders the "too old" placeholder. Never
      // synthesizes values.
      // =====================================================================
      const RES_VIEW_W = 800;
      const RES_VIEW_H = 260;
      const RES_PAD_LEFT = 56;
      const RES_PAD_RIGHT = 60;
      const RES_PAD_TOP = 12;
      const RES_PAD_BOTTOM = 30;
      const RES_X_TICK_SEC = 60;
      const RES_LINE_OPACITY = 0.95;
      const RES_BAND_OPACITY = 0.18;
      const RES_INCOME_PER_WORKER_LOW = 60;
      const RES_INCOME_PER_WORKER_HIGH = 80;
      // Three independent series colors; we keep them race-neutral because
      // both players already share one chart and we differentiate ownership
      // via dash style.
      const RES_SERIES_COLOR = {
        income: "var(--color-success)",
        unspent: "var(--color-warning)",
        in_progress: "var(--color-info)",
      };
      const RES_SERIES_LABEL = {
        income: "Income",
        unspent: "Unspent",
        in_progress: "In progress",
      };
      const RES_BAND_COLOR = "var(--color-success)";

      function _resSampleIncome(s) {
        return (Number(s.minerals_collection_rate) || 0)
             + (Number(s.vespene_collection_rate) || 0);
      }
      function _resSampleUnspent(s) {
        return (Number(s.minerals_current) || 0)
             + (Number(s.vespene_current) || 0);
      }
      function _resSampleInProgress(s) {
        return (Number(s.minerals_used_in_progress) || 0)
             + (Number(s.vespene_used_in_progress) || 0);
      }

      function _resSeries(samples) {
        if (!Array.isArray(samples) || samples.length === 0) return null;
        const t = samples.map((s) => Number(s.time) || 0);
        return {
          time: t,
          income: samples.map(_resSampleIncome),
          unspent: samples.map(_resSampleUnspent),
          in_progress: samples.map(_resSampleInProgress),
          workers: samples.map((s) => Number(s.food_workers) || 0),
        };
      }

      function _resYAxisMax(seriesList) {
        let m = 0;
        for (const s of seriesList) {
          if (!s) continue;
          for (const arr of [s.income, s.unspent, s.in_progress]) {
            for (const v of arr) if (v > m) m = v;
          }
          // Account for the band ceiling (80 * max workers) so the band
          // never extends past the visible plot.
          for (const w of s.workers) {
            const ceiling = w * RES_INCOME_PER_WORKER_HIGH;
            if (ceiling > m) m = ceiling;
          }
        }
        if (m <= 0) return 1000;
        const steps = [500, 1000, 1500, 2000, 3000, 4000, 5000, 7500, 10000];
        for (const s of steps) if (m <= s) return s;
        return Math.ceil(m / 1000) * 1000;
      }

      function _resXMax(seriesList) {
        let m = 0;
        for (const s of seriesList) {
          if (!s || !s.time.length) continue;
          const last = s.time[s.time.length - 1];
          if (last > m) m = last;
        }
        return m;
      }

      function _resPathFor(times, values, plotW, plotH, padLeft, padTop, xMax, yMax) {
        if (!values || values.length === 0 || yMax <= 0 || xMax <= 0) return "";
        const xAt = (t) => padLeft + (t / xMax) * plotW;
        const yAt = (v) => padTop + plotH - (Math.min(v, yMax) / yMax) * plotH;
        let d = "";
        for (let i = 0; i < values.length; i += 1) {
          d += (i === 0 ? "M " : " L ")
            + xAt(times[i]).toFixed(2) + " "
            + yAt(values[i]).toFixed(2);
        }
        return d;
      }

      function _resBandPolygonPath(times, workers, plotW, plotH,
                                   padLeft, padTop, xMax, yMax,
                                   perWorkerLow, perWorkerHigh) {
        if (!workers || workers.length === 0) return "";
        const xAt = (t) => padLeft + (t / xMax) * plotW;
        const yAt = (v) => padTop + plotH - (Math.min(v, yMax) / yMax) * plotH;
        let upper = "";
        for (let i = 0; i < workers.length; i += 1) {
          upper += (i === 0 ? "M " : " L ")
            + xAt(times[i]).toFixed(2) + " "
            + yAt(workers[i] * perWorkerHigh).toFixed(2);
        }
        let lower = "";
        for (let i = workers.length - 1; i >= 0; i -= 1) {
          lower += " L " + xAt(times[i]).toFixed(2) + " "
            + yAt(workers[i] * perWorkerLow).toFixed(2);
        }
        return upper + lower + " Z";
      }

      function ResourcesChartSvg({ mySeries, oppSeries, xMax, yMax }) {
        const plotW = RES_VIEW_W - RES_PAD_LEFT - RES_PAD_RIGHT;
        const plotH = RES_VIEW_H - RES_PAD_TOP - RES_PAD_BOTTOM;
        const xTicks = [];
        for (let t = 0; t <= xMax; t += RES_X_TICK_SEC) xTicks.push(t);
        const yTickFracs = [0, 0.25, 0.5, 0.75, 1];
        const SERIES_KEYS = ["income", "unspent", "in_progress"];
        const renderPaths = (series, dasharray) => {
          if (!series) return null;
          return SERIES_KEYS.map((k) => {
            const d = _resPathFor(
              series.time, series[k],
              plotW, plotH, RES_PAD_LEFT, RES_PAD_TOP, xMax, yMax,
            );
            if (!d) return null;
            return (
              <path
                key={k}
                d={d}
                fill="none"
                stroke={RES_SERIES_COLOR[k]}
                strokeWidth="1.5"
                strokeDasharray={dasharray}
                opacity={RES_LINE_OPACITY}
              />
            );
          });
        };
        const bandSource = mySeries || oppSeries;
        const bandPath = bandSource
          ? _resBandPolygonPath(
              bandSource.time, bandSource.workers,
              plotW, plotH, RES_PAD_LEFT, RES_PAD_TOP, xMax, yMax,
              RES_INCOME_PER_WORKER_LOW, RES_INCOME_PER_WORKER_HIGH,
            )
          : "";
        return (
          <svg
            viewBox={`0 0 ${RES_VIEW_W} ${RES_VIEW_H}`}
            preserveAspectRatio="none"
            className="w-full h-[260px]"
            role="img"
            aria-label="Resources over time chart"
          >
            {bandPath && (
              <path
                d={bandPath}
                fill={RES_BAND_COLOR}
                opacity={RES_BAND_OPACITY}
              />
            )}
            {yTickFracs.map((frac, i) => {
              const y = RES_PAD_TOP + plotH - frac * plotH;
              const v = Math.round(yMax * frac);
              return (
                <g key={`y${i}`}>
                  <line
                    x1={RES_PAD_LEFT}
                    y1={y}
                    x2={RES_VIEW_W - RES_PAD_RIGHT}
                    y2={y}
                    stroke="var(--color-border-subtle)"
                    strokeWidth="1"
                  />
                  <text
                    x={RES_PAD_LEFT - 4}
                    y={y + 3}
                    textAnchor="end"
                    fontSize="9"
                    fill="var(--color-text-secondary)"
                  >
                    {v}
                  </text>
                </g>
              );
            })}
            {xTicks.map((t, i) => {
              const x = RES_PAD_LEFT + (xMax > 0 ? (t / xMax) * plotW : 0);
              return (
                <g key={`x${i}`}>
                  <line
                    x1={x}
                    y1={RES_PAD_TOP + plotH}
                    x2={x}
                    y2={RES_PAD_TOP + plotH + 3}
                    stroke="var(--color-text-secondary)"
                    strokeWidth="1"
                  />
                  <text
                    x={x}
                    y={RES_PAD_TOP + plotH + 14}
                    textAnchor="middle"
                    fontSize="9"
                    fill="var(--color-text-secondary)"
                  >
                    {Math.floor(t / 60)}:{String(t % 60).padStart(2, "0")}
                  </text>
                </g>
              );
            })}
            <text
              x={RES_VIEW_W - RES_PAD_RIGHT + 6}
              y={RES_PAD_TOP + 10}
              fontSize="9"
              fill={RES_BAND_COLOR}
              opacity="0.85"
            >
              good band
            </text>
            <text
              x={RES_VIEW_W - RES_PAD_RIGHT + 6}
              y={RES_PAD_TOP + 22}
              fontSize="8"
              fill="var(--color-text-secondary)"
            >
              {RES_INCOME_PER_WORKER_LOW}-{RES_INCOME_PER_WORKER_HIGH}
            </text>
            <text
              x={RES_VIEW_W - RES_PAD_RIGHT + 6}
              y={RES_PAD_TOP + 32}
              fontSize="8"
              fill="var(--color-text-secondary)"
            >
              min/wkr/min
            </text>
            {renderPaths(mySeries, "3 3")}
            {renderPaths(oppSeries, "0")}
          </svg>
        );
      }

      function _resLegend(label, dasharray) {
        return (
          <div className="flex items-center gap-3">
            <span className="text-[10px] uppercase tracking-wide text-neutral-500">
              {label}:
            </span>
            {Object.keys(RES_SERIES_COLOR).map((k) => (
              <span key={k} className="flex items-center gap-1">
                <svg width="22" height="6">
                  <line
                    x1="0"
                    y1="3"
                    x2="22"
                    y2="3"
                    stroke={RES_SERIES_COLOR[k]}
                    strokeWidth="2"
                    strokeDasharray={dasharray}
                  />
                </svg>
                <span className="text-[10px] text-neutral-300">
                  {RES_SERIES_LABEL[k]}
                </span>
              </span>
            ))}
          </div>
        );
      }

      function ResourcesOverTimeChart({ gameId }) {
        const [data, setData] = useState(null);
        const [loading, setLoading] = useState(true);
        const [error, setError] = useState(null);

        useEffect(() => {
          let cancelled = false;
          setLoading(true);
          setError(null);
          // Reuse /macro-breakdown — stats_events comes back in the same
          // payload, so we don't double-spawn macro_cli for the modal.
          fetch(`${API}/games/${encodeURIComponent(gameId)}/macro-breakdown`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          })
            .then((r) =>
              r.ok ? r.json() : r.json().then((j) => Promise.reject(j)),
            )
            .then((j) => {
              if (!cancelled) {
                setData(j);
                setLoading(false);
              }
            })
            .catch((e) => {
              if (!cancelled) {
                setError((e && e.error) || "fetch failed");
                setLoading(false);
              }
            });
          return () => {
            cancelled = true;
          };
        }, [gameId]);

        if (loading) {
          return (
            <div className="text-xs text-neutral-500 px-3 py-3">
              loading resources…
            </div>
          );
        }
        if (error) {
          return (
            <div className="text-xs text-loss-500 px-3 py-3">
              resources unavailable: {error}
            </div>
          );
        }
        const myRaw = (data && data.stats_events) || [];
        const oppRaw = (data && data.opp_stats_events) || [];
        if (myRaw.length === 0 && oppRaw.length === 0) {
          return (
            <div className="bg-base-900/40 rounded p-4 text-center">
              <div className="text-xs text-neutral-400 italic">
                Replay too old to have resource samples (no PlayerStatsEvent
                rows in the tracker stream).
              </div>
            </div>
          );
        }
        const mySeries = _resSeries(myRaw);
        const oppSeries = _resSeries(oppRaw);
        const xMax = _resXMax([mySeries, oppSeries]);
        const yMax = _resYAxisMax([mySeries, oppSeries]);
        return (
          <div className="bg-base-900/40 rounded p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs uppercase tracking-wide text-neutral-300">
                Resources over time
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                {_resLegend("me (dotted)", "3 3")}
                {_resLegend("opp (solid)", "0")}
              </div>
            </div>
            <ResourcesChartSvg
              mySeries={mySeries}
              oppSeries={oppSeries}
              xMax={xMax}
              yMax={yMax}
            />
            <div className="text-[10px] text-neutral-500 mt-1 px-1">
              Income = minerals + vespene per minute. Unspent = current bank.
              In progress = mineral+gas cost of units/buildings/upgrades still
              being built. Green band = income range you should be in given
              your worker count (60-80 minerals per worker per minute).
            </div>
          </div>
        );
      }

  // Expose to global so inline-block JSX in index.html can render
  // these as bare identifiers.
  Object.assign(window, {
    ResourcesChartSvg,
    ResourcesOverTimeChart
  });
})();
