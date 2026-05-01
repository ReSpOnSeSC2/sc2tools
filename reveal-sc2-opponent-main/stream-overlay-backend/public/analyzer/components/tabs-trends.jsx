/**
 * TrendsTab — extracted from index.html.
 *
 * Loaded from index.html via:
 *   <script type="text/babel" data-presets="react" src="..."></script>
 *
 * Stage UI-revamp-1: adds a KPI summary strip (total games, overall
 * win rate, current streak, best/worst period), a rolling win-rate
 * overlay on top of the per-period line, and a small "best/worst
 * period" callout below the chart.
 *
 * DO NOT EDIT THE EXTRACTED BODY HERE WITHOUT ALSO UPDATING THE
 * MATCHING SECTION IN index.html — the two MUST NOT BOTH EXIST.
 */
(function () {
  "use strict";
  const React = window.React;
  const { useState, useEffect, useMemo, useCallback, Fragment } = React;

  const LS_BUCKET  = "analyzer.trends.bucket";
  const LS_ROLL    = "analyzer.trends.rollingOn";
  const ROLL_N     = 4;       // rolling window in periods (e.g. 4 weeks)
  const MIN_PERIOD = 3;       // ignore periods with < 3 games for best/worst

  function readLs(key, fb) {
    try {
      const v = window.localStorage && window.localStorage.getItem(key);
      return v == null ? fb : JSON.parse(v);
    } catch (_e) { return fb; }
  }
  function writeLs(key, v) {
    try { window.localStorage && window.localStorage.setItem(key, JSON.stringify(v)); }
    catch (_e) { /* non-fatal */ }
  }

  // Compute rolling win rate over the previous N periods (inclusive).
  // Returns one rolling value per series row, or null if insufficient
  // window. Mirrors the moving-average rendering in financial UIs.
  function rollingWinRate(series, windowN) {
    const out = [];
    let wins = 0, games = 0;
    const queue = [];
    for (const p of series) {
      queue.push({ wins: p.wins || 0, games: p.games || 0 });
      wins  += p.wins  || 0;
      games += p.games || 0;
      if (queue.length > windowN) {
        const dropped = queue.shift();
        wins  -= dropped.wins;
        games -= dropped.games;
      }
      out.push(games > 0 && queue.length === windowN ? wins / games : null);
    }
    return out;
  }

  // Compute current streak from the daily series. Walk newest-first,
  // pick the first period that has games, then count contiguous
  // periods that are all-W or all-L. (Mixed period stops the streak.)
  function streakFromSeries(series) {
    if (!series || series.length === 0) return { kind: null, count: 0 };
    let kind = null, count = 0;
    for (let i = series.length - 1; i >= 0; i--) {
      const p = series[i];
      const w = p.wins || 0, l = p.losses || 0;
      if (w === 0 && l === 0) continue;
      if (w > 0 && l === 0) {
        if (kind === null) kind = "win";
        if (kind === "win") count += w; else break;
      } else if (l > 0 && w === 0) {
        if (kind === null) kind = "loss";
        if (kind === "loss") count += l; else break;
      } else { break; }
    }
    return { kind, count };
  }

  function bestWorstPeriod(series, minGames) {
    const eligible = (series || []).filter((p) => (p.games || 0) >= minGames);
    if (eligible.length === 0) return { best: null, worst: null };
    const sorted = [...eligible].sort((a, b) => b.winRate - a.winRate);
    return { best: sorted[0], worst: sorted[sorted.length - 1] };
  }

  // ---------- Rolling-WR line overlay ----------------------------
  // Renders a second SVG path on top of the existing LinePath shape.
  // Uses the same yMax=1 mapping; renders only where the rolling
  // value is not null.
  function RollingOverlay({ series, height = 240 }) {
    const widthPct = 100;
    const padX = 8, padY = 12;
    const n = series.length;
    if (n < 2) return null;
    const dx = (widthPct - padX * 2) / (n - 1);
    const path = [];
    let started = false;
    series.forEach((p, i) => {
      const v = p.rolling;
      if (v == null) { started = false; return; }
      const x = padX + i * dx;
      const y = padY + (1 - v) * (height - padY * 2);
      path.push(`${started ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`);
      started = true;
    });
    if (path.length === 0) return null;
    return (
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none"
           className="absolute inset-0 w-full h-full pointer-events-none">
        <path d={path.join(" ")} fill="none"
              stroke="var(--clr-accent-400, #f59e0b)"
              strokeWidth="0.6"
              strokeDasharray="1.4 1.2" />
      </svg>
    );
  }

  function StreakBadge({ streak }) {
    if (!streak || !streak.kind || streak.count === 0) return null;
    const isWin = streak.kind === "win";
    const cls = isWin
      ? "bg-win-500/15 text-win-500 ring-1 ring-win-500/30"
      : "bg-loss-500/15 text-loss-500 ring-1 ring-loss-500/30";
    return (
      <span className={`px-2 py-0.5 rounded text-[11px] font-semibold tabular-nums ${cls}`}>
        {isWin ? "Winning streak" : "Losing streak"} · {streak.count}
      </span>
    );
  }

  // ---------- TrendsTab ------------------------------------------
  function TrendsTab({ filters, dbRev }) {
    const [bucket, setBucket]   = useState(() => readLs(LS_BUCKET, "week"));
    const [rolling, setRolling] = useState(() => readLs(LS_ROLL, true));
    useEffect(() => writeLs(LS_BUCKET, bucket), [bucket]);
    useEffect(() => writeLs(LS_ROLL, rolling), [rolling]);

    const params = useMemo(() => ({ ...filters, bucket }), [filters, bucket]);
    const { data, loading } = useApi("timeseries", params, [
      JSON.stringify(params), dbRev,
    ]);
    const series = data || [];

    const enriched = useMemo(() => {
      const roll = rollingWinRate(series, ROLL_N);
      return series.map((p, i) => ({ ...p, rolling: roll[i] }));
    }, [series]);

    const kpis = useMemo(() => {
      const totalGames = series.reduce((a, p) => a + (p.games  || 0), 0);
      const totalWins  = series.reduce((a, p) => a + (p.wins   || 0), 0);
      const totalLoss  = series.reduce((a, p) => a + (p.losses || 0), 0);
      const wr = totalGames ? totalWins / totalGames : 0;
      const streak = streakFromSeries(series);
      const { best, worst } = bestWorstPeriod(series, MIN_PERIOD);
      return {
        totalGames, totalWins, totalLoss, wr, streak,
        best, worst,
        bestLabel:  best  ? `${best.date} · ${pct1(best.winRate)}`   : "—",
        worstLabel: worst ? `${worst.date} · ${pct1(worst.winRate)}` : "—",
      };
    }, [series]);

    if (loading) return <Skeleton rows={4} />;

    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <h2 className="text-base font-semibold text-neutral-200">Trends</h2>
          <StreakBadge streak={kpis.streak} />
          <div className="ml-auto flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-neutral-400 cursor-pointer">
              <input type="checkbox" checked={rolling}
                     onChange={(e) => setRolling(e.target.checked)} />
              Rolling WR ({ROLL_N})
            </label>
            <span className="text-xs uppercase text-neutral-500">Bucket</span>
            <select value={bucket}
                    onChange={(e) => setBucket(e.target.value)}
                    className="bg-base-700 ring-soft rounded px-2 py-1 text-sm">
              <option value="day">Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
            </select>
          </div>
        </div>

        {/* KPI summary strip */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-base-800 ring-soft rounded-lg p-3">
            <div className="text-[10px] uppercase text-neutral-500">Games</div>
            <div className="mt-1 text-xl font-semibold text-neutral-200 tabular-nums">
              {kpis.totalGames}
            </div>
            <div className="mt-0.5 text-[11px] text-neutral-500 tabular-nums">
              {kpis.totalWins}W - {kpis.totalLoss}L
            </div>
          </div>
          <div className="bg-base-800 ring-soft rounded-lg p-3">
            <div className="text-[10px] uppercase text-neutral-500">Overall WR</div>
            <div className="mt-1 text-xl font-semibold tabular-nums"
                 style={{ color: wrColor(kpis.wr, kpis.totalGames) }}>
              {pct1(kpis.wr)}
            </div>
            <div className="mt-0.5 text-[11px] text-neutral-500">
              over {series.length} periods
            </div>
          </div>
          <div className="bg-base-800 ring-soft rounded-lg p-3">
            <div className="text-[10px] uppercase text-neutral-500">Best period</div>
            <div className="mt-1 text-sm font-medium text-neutral-200 truncate"
                 title={kpis.bestLabel}>{kpis.bestLabel}</div>
            <div className="mt-0.5 text-[11px] text-neutral-500 tabular-nums">
              {kpis.best ? `${kpis.best.games} games` : "Need ≥3 games / period"}
            </div>
          </div>
          <div className="bg-base-800 ring-soft rounded-lg p-3">
            <div className="text-[10px] uppercase text-neutral-500">Worst period</div>
            <div className="mt-1 text-sm font-medium text-neutral-200 truncate"
                 title={kpis.worstLabel}>{kpis.worstLabel}</div>
            <div className="mt-0.5 text-[11px] text-neutral-500 tabular-nums">
              {kpis.worst ? `${kpis.worst.games} games` : "Need ≥3 games / period"}
            </div>
          </div>
        </div>

        {series.length === 0 ? (
          <EmptyState />
        ) : (
          <Fragment>
            <Card title="Games per period (W stacked on L)">
              <StackedBars data={series} height={240} />
            </Card>
            <Card title={rolling
              ? `Win rate trend (orange = rolling ${ROLL_N})`
              : "Win rate trend"}>
              <div className="relative">
                <LinePath data={series} height={240} valueKey="winRate" yMax={1} />
                {rolling && <RollingOverlay series={enriched} height={240} />}
              </div>
            </Card>
          </Fragment>
        )}
      </div>
    );
  }

  Object.assign(window, { TrendsTab });
})();
