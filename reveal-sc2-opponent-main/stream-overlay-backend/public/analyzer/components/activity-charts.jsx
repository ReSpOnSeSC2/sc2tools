/**
 * Activity / APM-SPM charts + race-dot + category-badge constants — extracted from index.html.
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


      // ============================================================
      // BUILD-ORDER TIMELINE  (per-game, click-to-expand)
      // ============================================================
      // Color-classify build-order events by race so the timeline reads at a
      // glance. Tailwind classes are duplicated from the .race-X CSS at top
      // of the file but applied per-event.
      const RACE_DOT_CLASS = {
        Protoss: "bg-amber-400",
        Terran: "bg-blue-400",
        Zerg: "bg-purple-400",
        Neutral: "bg-neutral-500",
      };
      const CATEGORY_BADGE_CLASS = {
        townhall: "bg-yellow-700/60 text-yellow-200",
        builder: "bg-blue-700/60 text-blue-200",
        tech: "bg-purple-700/60 text-purple-200",
        defense: "bg-red-700/60 text-red-200",
        supply: "bg-cyan-700/60 text-cyan-200",
        worker: "bg-neutral-700/60 text-neutral-300",
        army: "bg-orange-700/60 text-orange-200",
        caster: "bg-fuchsia-700/60 text-fuchsia-200",
        air: "bg-sky-700/60 text-sky-200",
        detector: "bg-emerald-700/60 text-emerald-200",
        transport: "bg-teal-700/60 text-teal-200",
        hero: "bg-rose-700/60 text-rose-200",
        spawn: "bg-neutral-700/40 text-neutral-400",
        upgrade: "bg-indigo-700/60 text-indigo-200",
        unknown: "bg-neutral-700/40 text-neutral-500",
      };

      // =====================================================================
      // Activity-over-time chart used inside BuildOrderTimeline.
      //
      // Two stacked area charts (APM above, SPM below), x-axis = game
      // seconds, sourced from /games/:id/apm-curve. Both players are
      // overlaid at 0.5 opacity, colored by race using the design-token
      // accents (Protoss=amber, Zerg=purple, Terran=blue, fallback grey).
      //
      // Pure-SVG, no chart library. If the endpoint reports has_data=false
      // (corrupt replay, no command/selection events) we render the
      // "Activity data unavailable" notice instead of empty axes.
      // =====================================================================
      const ACTIVITY_RACE_COLOR = {
        Protoss: "var(--color-race-protoss)",
        Terran: "var(--color-race-terran)",
        Zerg: "var(--color-race-zerg)",
      };
      const ACTIVITY_FALLBACK_COLOR = "var(--color-race-random)";
      const ACTIVITY_VIEW_W = 800;
      const ACTIVITY_VIEW_H = 140;
      const ACTIVITY_PAD_LEFT = 36;
      const ACTIVITY_PAD_RIGHT = 12;
      const ACTIVITY_PAD_TOP = 8;
      const ACTIVITY_PAD_BOTTOM = 22;
      const ACTIVITY_AREA_OPACITY = 0.5;
      const ACTIVITY_LINE_OPACITY = 0.9;
      const ACTIVITY_X_TICK_SEC = 60;
      const ACTIVITY_Y_TICK_FRACTIONS = [0, 0.5, 1];

      function _activityFmtClock(totalSeconds) {
        const s = Math.max(0, Math.floor(totalSeconds || 0));
        const m = Math.floor(s / 60);
        const ss = (s % 60).toString().padStart(2, "0");
        return `${m}:${ss}`;
      }

      function _activityRaceColor(race) {
        return ACTIVITY_RACE_COLOR[race] || ACTIVITY_FALLBACK_COLOR;
      }

      function _activityBuildAreaPath(values, plotW, plotH, padLeft, padTop, yMax) {
        if (!values || values.length === 0 || yMax <= 0) return "";
        const last = values.length - 1;
        if (last === 0) return "";
        const xAt = (i) => padLeft + (i / last) * plotW;
        const yAt = (v) => padTop + plotH - (Math.min(v, yMax) / yMax) * plotH;
        let d = `M ${xAt(0).toFixed(2)} ${(padTop + plotH).toFixed(2)}`;
        for (let i = 0; i < values.length; i += 1) {
          d += ` L ${xAt(i).toFixed(2)} ${yAt(values[i]).toFixed(2)}`;
        }
        d += ` L ${xAt(last).toFixed(2)} ${(padTop + plotH).toFixed(2)} Z`;
        return d;
      }

      function _activityBuildLinePath(values, plotW, plotH, padLeft, padTop, yMax) {
        if (!values || values.length === 0 || yMax <= 0) return "";
        const last = values.length - 1;
        if (last === 0) return "";
        const xAt = (i) => padLeft + (i / last) * plotW;
        const yAt = (v) => padTop + plotH - (Math.min(v, yMax) / yMax) * plotH;
        let d = `M ${xAt(0).toFixed(2)} ${yAt(values[0]).toFixed(2)}`;
        for (let i = 1; i < values.length; i += 1) {
          d += ` L ${xAt(i).toFixed(2)} ${yAt(values[i]).toFixed(2)}`;
        }
        return d;
      }

      function _activityYAxisMax(playerSeries) {
        let m = 0;
        for (const series of playerSeries) {
          for (const v of series || []) if (v > m) m = v;
        }
        if (m <= 0) return 100;
        // Round up to a friendly tick (50, 100, 150, 200, 250, 300, 400, 600...).
        const steps = [50, 100, 150, 200, 250, 300, 400, 500, 600, 800, 1000];
        for (const s of steps) if (m <= s) return s;
        return Math.ceil(m / 100) * 100;
      }

      function ActivityChartPanel({ title, players, valueKey, gameLengthSec }) {
        const plotW = ACTIVITY_VIEW_W - ACTIVITY_PAD_LEFT - ACTIVITY_PAD_RIGHT;
        const plotH = ACTIVITY_VIEW_H - ACTIVITY_PAD_TOP - ACTIVITY_PAD_BOTTOM;
        const series = players.map((p) => p[valueKey] || []);
        const yMax = _activityYAxisMax(series);
        const xTicks = [];
        const totalSec = gameLengthSec || 0;
        for (let t = 0; t <= totalSec; t += ACTIVITY_X_TICK_SEC) xTicks.push(t);
        return (
          <div className="bg-base-900/40 rounded p-2">
            <div className="flex items-center justify-between mb-1 px-1">
              <div className="text-[11px] uppercase tracking-wide text-neutral-400">
                {title}
              </div>
              <div className="flex items-center gap-3">
                {players.map((p, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <span
                      className="inline-block w-3 h-2 rounded-sm"
                      style={{
                        background: _activityRaceColor(p.race),
                        opacity: ACTIVITY_AREA_OPACITY,
                      }}
                    />
                    <span className="text-[10px] text-neutral-300">
                      {p.name || `P${p.pid}`}
                      {p.race ? ` (${p.race[0]})` : ""}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <svg
              viewBox={`0 0 ${ACTIVITY_VIEW_W} ${ACTIVITY_VIEW_H}`}
              preserveAspectRatio="none"
              className="w-full h-[140px]"
              role="img"
              aria-label={`${title} chart`}
            >
              {ACTIVITY_Y_TICK_FRACTIONS.map((frac, i) => {
                const y = ACTIVITY_PAD_TOP + plotH - frac * plotH;
                const v = Math.round(yMax * frac);
                return (
                  <g key={`y${i}`}>
                    <line
                      x1={ACTIVITY_PAD_LEFT}
                      y1={y}
                      x2={ACTIVITY_VIEW_W - ACTIVITY_PAD_RIGHT}
                      y2={y}
                      stroke="var(--color-border-subtle)"
                      strokeWidth="1"
                    />
                    <text
                      x={ACTIVITY_PAD_LEFT - 4}
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
                const x = ACTIVITY_PAD_LEFT + (totalSec > 0 ? (t / totalSec) * plotW : 0);
                return (
                  <g key={`x${i}`}>
                    <line
                      x1={x}
                      y1={ACTIVITY_PAD_TOP + plotH}
                      x2={x}
                      y2={ACTIVITY_PAD_TOP + plotH + 3}
                      stroke="var(--color-text-secondary)"
                      strokeWidth="1"
                    />
                    <text
                      x={x}
                      y={ACTIVITY_PAD_TOP + plotH + 14}
                      textAnchor="middle"
                      fontSize="9"
                      fill="var(--color-text-secondary)"
                    >
                      {_activityFmtClock(t)}
                    </text>
                  </g>
                );
              })}
              {players.map((p, i) => {
                const color = _activityRaceColor(p.race);
                const values = p[valueKey] || [];
                const areaD = _activityBuildAreaPath(
                  values, plotW, plotH,
                  ACTIVITY_PAD_LEFT, ACTIVITY_PAD_TOP, yMax,
                );
                const lineD = _activityBuildLinePath(
                  values, plotW, plotH,
                  ACTIVITY_PAD_LEFT, ACTIVITY_PAD_TOP, yMax,
                );
                return (
                  <g key={`p${i}`}>
                    {areaD && (
                      <path
                        d={areaD}
                        fill={color}
                        opacity={ACTIVITY_AREA_OPACITY}
                      />
                    )}
                    {lineD && (
                      <path
                        d={lineD}
                        fill="none"
                        stroke={color}
                        strokeWidth="1.25"
                        opacity={ACTIVITY_LINE_OPACITY}
                      />
                    )}
                  </g>
                );
              })}
            </svg>
          </div>
        );
      }

      function ActivityOverTimeChart({ gameId, myRaceHint, oppRaceHint }) {
        const [data, setData] = useState(null);
        const [loading, setLoading] = useState(true);
        const [error, setError] = useState(null);

        useEffect(() => {
          let cancelled = false;
          setLoading(true);
          setError(null);
          fetch(`${API}/games/${encodeURIComponent(gameId)}/apm-curve`)
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
            <div className="text-xs text-neutral-500 px-3 py-2">
              loading activity…
            </div>
          );
        }
        if (error) {
          return (
            <div className="text-xs text-loss-500 px-3 py-2">
              activity unavailable: {error}
            </div>
          );
        }
        if (!data || !data.has_data || !Array.isArray(data.players)
            || data.players.length === 0) {
          return (
            <div className="text-xs text-neutral-500 px-3 py-3 italic">
              Activity data unavailable
            </div>
          );
        }
        // Hint races onto players that came back without one (older
        // replays where sc2reader couldn't resolve play_race for the
        // observer slot). Best-effort; defaults to the neutral fallback
        // color downstream.
        const players = data.players.map((p, i) => {
          if (p.race) return p;
          if (i === 0 && myRaceHint) return Object.assign({}, p, { race: myRaceHint });
          if (i === 1 && oppRaceHint) return Object.assign({}, p, { race: oppRaceHint });
          return p;
        });
        return (
          <div className="mt-3 border-t border-base-700 pt-3">
            <div className="text-[11px] text-neutral-500 mb-2 px-1">
              Activity over time — {data.window_sec || 30}s sliding window.
              Both players overlaid; color = race.
            </div>
            <div className="space-y-2">
              <ActivityChartPanel
                title="APM (actions per minute)"
                players={players}
                valueKey="apm"
                gameLengthSec={data.game_length_sec || 0}
              />
              <ActivityChartPanel
                title="SPM (selections per minute)"
                players={players}
                valueKey="spm"
                gameLengthSec={data.game_length_sec || 0}
              />
            </div>
          </div>
        );
      }



  // Expose to global so inline-block JSX in index.html can render
  // these as bare identifiers.
  Object.assign(window, {
    RACE_DOT_CLASS,
    CATEGORY_BADGE_CLASS,
    ACTIVITY_RACE_COLOR,
    ACTIVITY_FALLBACK_COLOR,
    ACTIVITY_VIEW_W,
    ACTIVITY_VIEW_H,
    ACTIVITY_PAD_LEFT,
    ACTIVITY_PAD_RIGHT,
    ACTIVITY_PAD_TOP,
    ACTIVITY_PAD_BOTTOM,
    ACTIVITY_AREA_OPACITY,
    ACTIVITY_LINE_OPACITY,
    ACTIVITY_X_TICK_SEC,
    ACTIVITY_Y_TICK_FRACTIONS,
    _activityFmtClock,
    _activityRaceColor,
    _activityBuildAreaPath,
    _activityBuildLinePath,
    _activityYAxisMax,
    ActivityChartPanel,
    ActivityOverTimeChart
  });
})();
