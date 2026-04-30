/**
 * Active Army & Workers chart helpers + MacroResourceChart — extracted from index.html.
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
      // Active Army & Workers chart used by MacroBreakdownPanel.
      //
      // Pure-SVG, no chart library. Two players overlaid on the same axes:
      //   - Army supply value  = food_used * ARMY_SUPPLY_PER_FOOD  (left axis)
      //   - Worker count       = food_workers                       (right axis)
      // Lines are drawn solid for army / dashed for workers, with each
      // player getting their own color (green/red defaults; user-adjustable
      // via the two color pickers above the chart).
      //
      // Two thin supply-block lanes sit at the bottom of the plot area —
      // one per player — so neither side's bands overlap the other.
      //
      // Hover anywhere in the chart to scrub through samples: a vertical
      // crosshair locks to the nearest sample, dots highlight all four
      // line values, a tooltip shows raw numbers, and a Unit Roster panel
      // below the chart updates with both players' alive non-worker units
      // (icons + counts).
      // =====================================================================
      const RACE_ACCENT_VAR = {
        Protoss: "var(--color-race-protoss)",
        Terran: "var(--color-race-terran)",
        Zerg: "var(--color-race-zerg)",
      };
      const CHART_WARNING_COLOR = "var(--color-warning)";
      const CHART_GRID_COLOR = "var(--color-border-subtle)";
      const CHART_AXIS_TEXT = "var(--color-text-secondary)";
      const CHART_VIEW_W = 800;
      const CHART_VIEW_H = 240;
      const CHART_PAD_LEFT = 44;
      const CHART_PAD_RIGHT = 44;
      const CHART_PAD_TOP = 12;
      const CHART_PAD_BOTTOM = 36;
      const SUPPLY_LANE_HEIGHT = 4;
      const SUPPLY_LANE_GAP = 2;
      const ARMY_SUPPLY_PER_FOOD = 8;
      const SUPPLY_BLOCK_TOLERANCE = 1;
      const SUPPLY_BAND_OPACITY = 0.55;
      const Y_TICK_FRACTIONS = [0, 0.25, 0.5, 0.75, 1];
      // Static x-axis: a labeled tick every 15 seconds. Hover state gives
      // sub-tick precision (down to the second) — see _hoverInfoFromMouseEvent.
      const X_TICK_STEP = 15;
      const ARMY_AXIS_FLOOR = 8 * ARMY_SUPPLY_PER_FOOD;
      const WORKER_AXIS_FLOOR = 12;
      const DEFAULT_MY_COLOR = "#22c55e";
      const DEFAULT_OPP_COLOR = "#ef4444";

      const UNIT_ICON_BASE = "/static/icons/units/";
      const _CHART_UNIT_NAME_ALIASES = {
        siegetanksieged: "siegetank",
        warpprismphasing: "warpprism",
        banelingburrowed: "baneling",
        roachburrowed: "roach",
        zerglingburrowed: "zergling",
        hydraliskburrowed: "hydralisk",
        infestorburrowed: "infestor",
        lurkerburrowed: "lurker",
        lurkermp: "lurker",
        lurkermpburrowed: "lurker",
        ravagerburrowed: "ravager",
        queenburrowed: "queen",
        swarmhostmp: "swarmhost",
        swarmhostmpburrowed: "swarmhost",
        hellionhellion: "hellion",
        helliontank: "hellbat",
        vikingfighter: "viking",
        vikingassault: "viking",
        thoraap: "thor",
        ling: "zergling",
      };
      function _resolveUnitIcon(rawName) {
        const lc = String(rawName || "").toLowerCase().replace(/\s+/g, "");
        const canon = _CHART_UNIT_NAME_ALIASES[lc] || lc;
        return UNIT_ICON_BASE + canon + ".png";
      }

      function _formatGameClock(totalSeconds) {
        const s = Math.max(0, Math.floor(totalSeconds || 0));
        const m = Math.floor(s / 60);
        const ss = (s % 60).toString().padStart(2, "0");
        return `${m}:${ss}`;
      }

      function _supplyBlockBands(samples) {
        if (!Array.isArray(samples) || samples.length === 0) return [];
        const bands = [];
        let openStart = null;
        let lastTime = 0;
        for (const s of samples) {
          const t = Number(s.time) || 0;
          const used = Number(s.food_used) || 0;
          const made = Number(s.food_made) || 0;
          const blocked = made > 0 && used >= made - SUPPLY_BLOCK_TOLERANCE;
          if (blocked && openStart === null) openStart = t;
          else if (!blocked && openStart !== null) {
            bands.push({ start: openStart, end: t });
            openStart = null;
          }
          lastTime = t;
        }
        if (openStart !== null) bands.push({ start: openStart, end: lastTime });
        return bands;
      }

      function _buildLinePath(points) {
        if (!points.length) return "";
        return points
          .map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`)
          .join(" ");
      }

      function _projectSidePoints(samples, xOf, yArmy, yWorker) {
        const armyPts = [];
        const workerPts = [];
        for (const s of samples) {
          const t = Number(s.time) || 0;
          const armyVal = (Number(s.food_used) || 0) * ARMY_SUPPLY_PER_FOOD;
          armyPts.push([xOf(t), yArmy(armyVal)]);
          workerPts.push([xOf(t), yWorker(Number(s.food_workers) || 0)]);
        }
        return { armyPts, workerPts };
      }

      function _buildChartLayout(mySamples, oppSamples, gameLengthSec) {
        const innerW = CHART_VIEW_W - CHART_PAD_LEFT - CHART_PAD_RIGHT;
        const supplyLanesH = SUPPLY_LANE_HEIGHT * 2 + SUPPLY_LANE_GAP * 2;
        const innerH =
          CHART_VIEW_H - CHART_PAD_TOP - CHART_PAD_BOTTOM - supplyLanesH;
        const all = mySamples.concat(oppSamples);
        const lastT = all.length
          ? Math.max(...all.map((s) => Number(s.time) || 0)) : 0;
        const maxT = Math.max(lastT, Number(gameLengthSec) || 0, 60);
        const armyVals = all.map(
          (s) => (Number(s.food_used) || 0) * ARMY_SUPPLY_PER_FOOD);
        const workerVals = all.map((s) => Number(s.food_workers) || 0);
        const armyMax = Math.max(
          armyVals.length ? Math.max(...armyVals) : 0, ARMY_AXIS_FLOOR);
        const workerMax = Math.max(
          workerVals.length ? Math.max(...workerVals) : 0, WORKER_AXIS_FLOOR);
        const xOf = (t) => CHART_PAD_LEFT + (t / maxT) * innerW;
        const yArmy = (a) => CHART_PAD_TOP + (1 - a / armyMax) * innerH;
        const yWorker = (w) => CHART_PAD_TOP + (1 - w / workerMax) * innerH;
        const my = _projectSidePoints(mySamples, xOf, yArmy, yWorker);
        const opp = _projectSidePoints(oppSamples, xOf, yArmy, yWorker);
        const xTicks = [];
        for (let t = 0; t <= maxT; t += X_TICK_STEP) xTicks.push(t);
        const supplyLanesTop = CHART_PAD_TOP + innerH + SUPPLY_LANE_GAP;
        return { innerW, innerH, maxT, armyMax, workerMax,
                 xOf, yArmy, yWorker, my, opp, xTicks, supplyLanesTop };
      }

      function _renderSupplyBands(bands, layout, color, laneIndex) {
        const y = layout.supplyLanesTop +
          (SUPPLY_LANE_HEIGHT + SUPPLY_LANE_GAP) * laneIndex;
        return bands.map((b, i) => (
          <rect key={`band-${laneIndex}-${i}`}
            x={layout.xOf(b.start)} y={y}
            width={Math.max(1, layout.xOf(b.end) - layout.xOf(b.start))}
            height={SUPPLY_LANE_HEIGHT} fill={color}
            opacity={SUPPLY_BAND_OPACITY} />
        ));
      }

      function _renderYAxes(layout) {
        return Y_TICK_FRACTIONS.map((f, i) => {
          const y = CHART_PAD_TOP + (1 - f) * layout.innerH;
          return (
            <g key={`y-${i}`}>
              <line x1={CHART_PAD_LEFT} y1={y}
                x2={CHART_VIEW_W - CHART_PAD_RIGHT} y2={y}
                stroke={CHART_GRID_COLOR} strokeDasharray="2 4" />
              <text x={CHART_PAD_LEFT - 6} y={y + 3} fontSize="10"
                textAnchor="end" fill={CHART_AXIS_TEXT}>
                {Math.round(f * layout.armyMax)}
              </text>
              <text x={CHART_VIEW_W - CHART_PAD_RIGHT + 6} y={y + 3}
                fontSize="10" textAnchor="start" fill={CHART_AXIS_TEXT}>
                {Math.round(f * layout.workerMax)}
              </text>
            </g>
          );
        });
      }

      function _renderXAxisTicks(layout) {
        // 15-second labeled ticks. The hover state provides per-second
        // precision so the static axis stays uncluttered.
        const baseY = CHART_PAD_TOP + layout.innerH;
        return layout.xTicks.map((t, i) => (
          <g key={`x-${i}`}>
            <line x1={layout.xOf(t)} y1={baseY}
              x2={layout.xOf(t)} y2={baseY + 4}
              stroke={CHART_AXIS_TEXT} strokeOpacity="0.6" />
            <text x={layout.xOf(t)} y={CHART_VIEW_H - 18}
              fontSize="10" textAnchor="middle" fill={CHART_AXIS_TEXT}>
              {_formatGameClock(t)}
            </text>
          </g>
        ));
      }

      function _renderLegendSwatch(color, dashed) {
        return (
          <svg width="14" height="6" aria-hidden="true">
            <line x1="1" y1="3" x2="13" y2="3" stroke={color}
              strokeWidth="2" strokeDasharray={dashed ? "2 2" : ""} />
          </svg>
        );
      }

      function _renderChartLegend(myColor, oppColor) {
        return (
          <div className="flex items-center gap-3 text-[11px] text-neutral-300 flex-wrap">
            <span className="inline-flex items-center gap-1">
              {_renderLegendSwatch(myColor, false)} you army
            </span>
            <span className="inline-flex items-center gap-1">
              {_renderLegendSwatch(myColor, true)} you wkrs
            </span>
            <span className="inline-flex items-center gap-1">
              {_renderLegendSwatch(oppColor, false)} opp army
            </span>
            <span className="inline-flex items-center gap-1">
              {_renderLegendSwatch(oppColor, true)} opp wkrs
            </span>
            <span className="inline-flex items-center gap-1 text-neutral-400">
              <span className="inline-block w-3 h-1"
                style={{ background: CHART_WARNING_COLOR,
                         opacity: SUPPLY_BAND_OPACITY }} />
              supply blocked (per side)
            </span>
          </div>
        );
      }

      function _renderColorControls(myColor, setMyColor, oppColor, setOppColor) {
        return (
          <div className="flex items-center gap-3 text-[11px] text-neutral-400">
            <label className="inline-flex items-center gap-1 cursor-pointer">
              <span>YOU</span>
              <input type="color" value={myColor}
                onChange={(e) => setMyColor(e.target.value)}
                aria-label="Pick the color for your lines"
                className="w-5 h-5 rounded border-0 cursor-pointer bg-transparent" />
            </label>
            <label className="inline-flex items-center gap-1 cursor-pointer">
              <span>OPP</span>
              <input type="color" value={oppColor}
                onChange={(e) => setOppColor(e.target.value)}
                aria-label="Pick the color for opponent lines"
                className="w-5 h-5 rounded border-0 cursor-pointer bg-transparent" />
            </label>
          </div>
        );
      }

      // Resolve a mouse event to {cursorSec, sampleIdx}:
      //   - cursorSec: the cursor's game-time rounded to the nearest second
      //     (this drives the crosshair x and the tooltip label, so the chart
      //     reads as second-precise even though sample data is coarser).
      //   - sampleIdx: index into ``samples`` whose time is nearest to
      //     cursorSec (drives the tooltip values + unit roster — the
      //     PlayerStatsEvent stream samples at ~10s cadence so this is the
      //     most-recent observed state for the cursor's second).
      // Returns null when the cursor is outside the plot area or no
      // ``samples`` exist to anchor the data lookup.
      function _hoverInfoFromMouseEvent(e, svgEl, samples, layout) {
        if (!svgEl || !samples.length) return null;
        const rect = svgEl.getBoundingClientRect();
        if (rect.width <= 0) return null;
        const localX = (e.clientX - rect.left) / rect.width * CHART_VIEW_W;
        if (localX < CHART_PAD_LEFT || localX > CHART_VIEW_W - CHART_PAD_RIGHT) {
          return null;
        }
        const tFloat = (localX - CHART_PAD_LEFT) / layout.innerW * layout.maxT;
        const cursorSec = Math.max(0, Math.min(layout.maxT, Math.round(tFloat)));
        let bestIdx = 0;
        let bestDist = Infinity;
        for (let i = 0; i < samples.length; i++) {
          const d = Math.abs((Number(samples[i].time) || 0) - cursorSec);
          if (d < bestDist) { bestDist = d; bestIdx = i; }
        }
        return { cursorSec, sampleIdx: bestIdx };
      }

      function _renderHoverCrosshair(layout, cursorSec, mySample, oppSample, myColor, oppColor) {
        if (cursorSec == null) return null;
        const xCursor = layout.xOf(cursorSec);
        const dot = (s, color, r) => {
          if (!s) return null;
          const army = (Number(s.food_used) || 0) * ARMY_SUPPLY_PER_FOOD;
          return (
            <g pointerEvents="none">
              <circle cx={xCursor}
                cy={layout.yWorker(Number(s.food_workers) || 0)}
                r={r} fill={color} stroke="#000" strokeOpacity="0.4" />
              <circle cx={xCursor} cy={layout.yArmy(army)}
                r={r} fill={color} stroke="#000" strokeOpacity="0.4" />
            </g>
          );
        };
        return (
          <g pointerEvents="none">
            <line x1={xCursor} y1={CHART_PAD_TOP} x2={xCursor}
              y2={CHART_PAD_TOP + layout.innerH}
              stroke={CHART_AXIS_TEXT} strokeDasharray="2 2" opacity="0.6" />
            {dot(mySample, myColor, 3.5)}
            {dot(oppSample, oppColor, 3)}
          </g>
        );
      }

      function _renderChartLines(layout, myColor, oppColor) {
        return (
          <g>
            <path d={_buildLinePath(layout.opp.workerPts)} fill="none"
              stroke={oppColor} strokeWidth="1.5" strokeDasharray="3 3" />
            <path d={_buildLinePath(layout.my.workerPts)} fill="none"
              stroke={myColor} strokeWidth="1.5" strokeDasharray="3 3" />
            <path d={_buildLinePath(layout.opp.armyPts)} fill="none"
              stroke={oppColor} strokeWidth="1.75" />
            <path d={_buildLinePath(layout.my.armyPts)} fill="none"
              stroke={myColor} strokeWidth="1.75" />
          </g>
        );
      }

      function _renderChartSvg(args) {
        const { layout, myColor, oppColor, myBands, oppBands,
                mySample, oppSample, cursorSec,
                svgRef, onMove, onLeave } = args;
        const baselineY = CHART_PAD_TOP + layout.innerH;
        return (
          <svg ref={svgRef}
            viewBox={`0 0 ${CHART_VIEW_W} ${CHART_VIEW_H}`}
            role="img"
            aria-label="Active army supply value and worker count over game time, both players overlaid"
            className="w-full h-auto cursor-crosshair"
            preserveAspectRatio="none"
            onMouseMove={onMove} onMouseLeave={onLeave}>
            {_renderSupplyBands(myBands, layout, myColor, 0)}
            {_renderSupplyBands(oppBands, layout, oppColor, 1)}
            <line x1={CHART_PAD_LEFT} y1={baselineY}
              x2={CHART_VIEW_W - CHART_PAD_RIGHT} y2={baselineY}
              stroke={CHART_GRID_COLOR} />
            {_renderYAxes(layout)}
            {_renderXAxisTicks(layout)}
            {_renderChartLines(layout, myColor, oppColor)}
            {_renderHoverCrosshair(layout, cursorSec, mySample, oppSample, myColor, oppColor)}
            <text x={CHART_PAD_LEFT - 6} y={CHART_PAD_TOP - 2} fontSize="9"
              textAnchor="end" fill={CHART_AXIS_TEXT}>army</text>
            <text x={CHART_VIEW_W - CHART_PAD_RIGHT + 6} y={CHART_PAD_TOP - 2}
              fontSize="9" textAnchor="start" fill={CHART_AXIS_TEXT}>wkrs</text>
          </svg>
        );
      }

      function _sampleInBlockedBand(sample, bands) {
        if (!sample) return false;
        const t = Number(sample.time) || 0;
        for (const b of bands) if (t >= b.start && t <= b.end) return true;
        return false;
      }

      function _renderTooltipLine(label, color, sample, blocked) {
        if (!sample) return null;
        const army = (Number(sample.food_used) || 0) * ARMY_SUPPLY_PER_FOOD;
        const workers = Number(sample.food_workers) || 0;
        return (
          <div className="flex items-center gap-2 tabular-nums">
            <span className="inline-block w-2 h-2 rounded-full"
              style={{ background: color }} />
            <span className="text-neutral-400 text-[10px] uppercase tracking-wider">
              {label}
            </span>
            <span>army <span className="font-semibold">{army}</span></span>
            <span>wkrs <span className="font-semibold">{workers}</span></span>
            {blocked && (
              <span className="text-[10px]"
                style={{ color: CHART_WARNING_COLOR }}>blocked</span>
            )}
          </div>
        );
      }

      function _renderChartTooltip(args) {
        const { mySample, oppSample, myBands, oppBands, layout,
                myColor, oppColor, cursorSec } = args;
        if (cursorSec == null) return null;
        const t = cursorSec;
        const leftPct = (layout.xOf(t) / CHART_VIEW_W) * 100;
        const onRight = leftPct > 60;
        return (
          <div
            className="pointer-events-none absolute z-10 bg-base-900 ring-soft rounded px-2 py-1 text-[11px] text-neutral-100 shadow-soft"
            style={{
              left: onRight ? "auto" : `calc(${leftPct}% + 8px)`,
              right: onRight ? `calc(${100 - leftPct}% + 8px)` : "auto",
              top: 4,
            }}
          >
            <div className="text-neutral-400 tabular-nums mb-0.5">
              {_formatGameClock(t)}
            </div>
            {_renderTooltipLine("YOU", myColor, mySample,
              _sampleInBlockedBand(mySample, myBands))}
            {_renderTooltipLine("OPP", oppColor, oppSample,
              _sampleInBlockedBand(oppSample, oppBands))}
          </div>
        );
      }

      function _renderUnitChip(name, count, color) {
        return (
          <span key={name}
            className="inline-flex items-center gap-1 bg-base-900 ring-soft rounded px-1.5 py-0.5 text-[11px]"
            title={`${name} x${count}`}>
            <img src={_resolveUnitIcon(name)} alt="" width="16" height="16"
              loading="lazy"
              onError={(e) => { e.currentTarget.style.display = "none"; }} />
            <span className="text-neutral-200">{name}</span>
            <span className="font-semibold tabular-nums" style={{ color }}>
              ×{count}
            </span>
          </span>
        );
      }

      // Names that should NEVER appear in the army-composition roster.
      // Beacon* are click-action markers the SC2 client emits at t=0;
      // WidowMineBurrowed is just the burrowed state of WidowMine and
      // would double-count widow mines as a separate row. Mirrors
      // _skip_for_unit_timeline() in core/event_extractor.py.
      function _isRosterNoise(name) {
        if (!name) return true;
        if (typeof name !== "string") return true;
        if (name.startsWith("Beacon")) return true;
        if (name === "WidowMineBurrowed") return true;
        return false;
      }

      function _renderUnitRosterRow(label, color, units) {
        const entries = Object.entries(units || {})
          .filter(([n]) => !_isRosterNoise(n))
          .sort((a, b) => b[1] - a[1]);
        return (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] uppercase tracking-wider"
              style={{ color, minWidth: 28 }}>{label}</span>
            {entries.length === 0 ? (
              <span className="text-[11px] text-neutral-500">—</span>
            ) : (
              entries.map(([n, c]) => _renderUnitChip(n, c, color))
            )}
          </div>
        );
      }

      function _renderUnitRoster(timelineEntry, myColor, oppColor) {
        if (!timelineEntry) {
          return (
            <div className="text-[11px] text-neutral-500 mt-2">
              Hover the chart to see each side's army composition over time.
            </div>
          );
        }
        return (
          <div className="mt-2 space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-neutral-500">
              Unit roster at {_formatGameClock(timelineEntry.time)}
            </div>
            {_renderUnitRosterRow("YOU", myColor, timelineEntry.my)}
            {_renderUnitRosterRow("OPP", oppColor, timelineEntry.opp)}
          </div>
        );
      }

      function MacroResourceChart(props) {
        const samples = Array.isArray(props.statsEvents) ? props.statsEvents : [];
        const oppSamples = Array.isArray(props.oppStatsEvents) ? props.oppStatsEvents : [];
        const timeline = Array.isArray(props.unitTimeline) ? props.unitTimeline : [];
        const [hoverInfo, setHoverInfo] = useState(null);
        const [myColor, setMyColor] = useState(DEFAULT_MY_COLOR);
        const [oppColor, setOppColor] = useState(DEFAULT_OPP_COLOR);
        const svgRef = useRef(null);
        if (samples.length === 0 && oppSamples.length === 0) {
          return (
            <div className="bg-base-800 ring-soft rounded p-3 text-xs text-neutral-400">
              Resource samples unavailable for this replay.
            </div>
          );
        }
        const layout = _buildChartLayout(samples, oppSamples, props.gameLengthSec);
        const myBands = _supplyBlockBands(samples);
        const oppBands = _supplyBlockBands(oppSamples);
        const onMove = (e) => {
          const info = _hoverInfoFromMouseEvent(e, svgRef.current, samples, layout);
          // Compare via cursorSec so we don't re-render on every pixel —
          // only when the second changes.
          if (info == null) {
            if (hoverInfo != null) setHoverInfo(null);
            return;
          }
          if (!hoverInfo || hoverInfo.cursorSec !== info.cursorSec) {
            setHoverInfo(info);
          }
        };
        const onLeave = () => setHoverInfo(null);
        const cursorSec = hoverInfo ? hoverInfo.cursorSec : null;
        const sIdx = hoverInfo ? hoverInfo.sampleIdx : null;
        const mySample = sIdx != null ? samples[sIdx] : null;
        const oppSample = sIdx != null ? oppSamples[sIdx] : null;
        const timelineEntry = sIdx != null ? timeline[sIdx] : null;
        return (
          <div className="bg-base-800 ring-soft rounded p-3">
            <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
              <div className="text-[11px] uppercase tracking-wider text-neutral-200">
                Active Army &amp; Workers
              </div>
              {_renderColorControls(myColor, setMyColor, oppColor, setOppColor)}
            </div>
            <div className="mb-2">{_renderChartLegend(myColor, oppColor)}</div>
            <div className="relative">
              {_renderChartSvg({ layout, myColor, oppColor, myBands, oppBands,
                                  mySample, oppSample, cursorSec,
                                  svgRef, onMove, onLeave })}
              {cursorSec != null && _renderChartTooltip({
                mySample, oppSample, myBands, oppBands, layout,
                myColor, oppColor, cursorSec })}
            </div>
            {_renderUnitRoster(timelineEntry, myColor, oppColor)}
          </div>
        );
      }

  // Expose to global so inline-block JSX in index.html can render
  // these as bare identifiers.
  Object.assign(window, {
    MacroResourceChart
  });
})();
