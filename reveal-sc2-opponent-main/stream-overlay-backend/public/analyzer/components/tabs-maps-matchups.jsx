/**
 * BattlefieldTab + back-compat MapsTab/MatchupsTab — extracted from index.html.
 *
 * Loaded from index.html via:
 *   <script type="text/babel" data-presets="react" src="..."></script>
 *
 * Stage UI-revamp-1: consolidates the old "Maps" and "Matchups" tabs
 * into a single "Battlefield" tab. The matchup overview lives at the
 * top (sortable, with last-10 sparkline + streak badge), the map
 * win-rate chart + sortable table sit below it, and a best/worst
 * KPI strip summarises both. MapsTab and MatchupsTab are kept as
 * back-compat wrappers so external callers don't break.
 *
 * DO NOT EDIT THE EXTRACTED BODY HERE WITHOUT ALSO UPDATING THE
 * MATCHING SECTION IN index.html — the two MUST NOT BOTH EXIST.
 */
(function () {
  "use strict";
  const React = window.React;
  const { useState, useEffect, useMemo, useCallback, Fragment } = React;

  const LS_MIN_MAPS = "analyzer.battlefield.maps.minGames";
  const LS_MAP_SORT = "analyzer.battlefield.maps.sort";
  const LS_MU_SORT  = "analyzer.battlefield.matchups.sort";
  const SPARK_MAX   = 10;

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

  // ---------- Sparkline (last-N games) ---------------------------
  // Each game is rendered as a small dot: green = win, red = loss.
  // Order is left -> right = oldest -> newest of the window.
  function FormSparkline({ results, size = 8 }) {
    if (!results || results.length === 0) {
      return <span className="text-[11px] text-neutral-500">no recent games</span>;
    }
    return (
      <div className="flex items-center gap-[3px]">
        {results.map((r, i) => {
          const isWin = r === "win";
          const isLoss = r === "loss";
          const bg = isWin
            ? "var(--clr-win-500, #22c55e)"
            : isLoss
              ? "var(--clr-loss-500, #ef4444)"
              : "rgba(255,255,255,0.18)";
          return (
            <span key={i}
                  title={r}
                  style={{
                    width: size, height: size, borderRadius: 2,
                    background: bg, display: "inline-block",
                  }} />
          );
        })}
      </div>
    );
  }

  // ---------- Streak computation ---------------------------------
  // Walk newest-first, count contiguous same-result run.
  function computeStreak(resultsNewestFirst) {
    if (!resultsNewestFirst || resultsNewestFirst.length === 0) {
      return { kind: null, count: 0 };
    }
    const head = resultsNewestFirst[0];
    if (head !== "win" && head !== "loss") return { kind: null, count: 0 };
    let n = 0;
    for (const r of resultsNewestFirst) {
      if (r === head) n += 1; else break;
    }
    return { kind: head, count: n };
  }

  function StreakBadge({ streak }) {
    if (!streak || !streak.kind || streak.count === 0) return null;
    const isWin = streak.kind === "win";
    const cls = isWin
      ? "bg-win-500/15 text-win-500 ring-1 ring-win-500/30"
      : "bg-loss-500/15 text-loss-500 ring-1 ring-loss-500/30";
    return (
      <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold tabular-nums ${cls}`}
            title={`${streak.count}-game ${isWin ? "winning" : "losing"} streak`}>
        {isWin ? "W" : "L"}{streak.count}
      </span>
    );
  }

  // ---------- Min-games filter (shared style w/ Strategies) ------
  const MIN_STEPS = [1, 3, 5, 10, 20];
  function MinGames({ value, onChange }) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] uppercase text-neutral-500">Min games</span>
        <div className="inline-flex bg-base-700 ring-soft rounded overflow-hidden">
          {MIN_STEPS.map((n) => (
            <button key={n} onClick={() => onChange(n)}
              className={`px-2 py-1 text-xs tabular-nums transition ${
                value === n
                  ? "bg-accent-500/20 text-accent-300"
                  : "text-neutral-400 hover:bg-base-600"
              }`}>{n}</button>
          ))}
        </div>
      </div>
    );
  }

  function bestWorst(rows, minGames) {
    const eligible = (rows || []).filter((r) => (r.total || 0) >= minGames);
    if (eligible.length === 0) return { best: null, worst: null };
    const sorted = [...eligible].sort((a, b) => b.winRate - a.winRate);
    return { best: sorted[0], worst: sorted[sorted.length - 1] };
  }

  // ---------- Recent-form hook -----------------------------------
  // Pulls the last N games once, groups by opp_race so each matchup
  // card can render its own sparkline + streak without N fetches.
  function useRecentForm(filters, dbRev) {
    const [byMatchup, setByMatchup] = useState({});
    useEffect(() => {
      let cancelled = false;
      (async () => {
        try {
          // Use the global `api()` helper from index.html (fetches
          // ${API}/${endpoint}${buildQuery(params)} and parses JSON).
          // It's a top-level function declaration so it's reachable
          // from this module via classic-script lookup.
          const j = await api("games", {
            ...filters, limit: 500, sort: "date_desc",
          });
          if (cancelled) return;
          const games = (j && j.games) || [];
          const by = {};
          for (const g of games) {
            const race = (g.opp_race || "Unknown").charAt(0).toUpperCase();
            const key = `vs ${race === "U" ? "Unknown" : race}`;
            (by[key] = by[key] || []).push(g);
          }
          setByMatchup(by);
        } catch (_e) {
          if (!cancelled) setByMatchup({});
        }
      })();
      return () => { cancelled = true; };
    }, [JSON.stringify(filters), dbRev]);
    return byMatchup;
  }

  function recentResultsFor(games) {
    const out = [];
    for (const g of games || []) {
      const r = String(g.result || "").toLowerCase();
      if (r === "win" || r === "loss") out.push(r);
      if (out.length >= SPARK_MAX) break;
    }
    return out; // newest-first
  }

  // ---------- KPI strip ------------------------------------------
  function KpiCards({ items }) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {items.map((k, i) => (
          <div key={i} className="bg-base-800 ring-soft rounded-lg p-3">
            <div className="text-[10px] uppercase text-neutral-500 truncate">{k.label}</div>
            <div className="mt-1 text-sm font-medium text-neutral-200 truncate"
                 title={k.value || "—"}>{k.value || "—"}</div>
            {k.sub && (
              <div className="mt-0.5 text-[11px] text-neutral-500 tabular-nums">{k.sub}</div>
            )}
          </div>
        ))}
      </div>
    );
  }

  // ---------- Matchups overview section --------------------------
  function MatchupsOverview({ filters, dbRev, recentByMu }) {
    const { data, loading } = useApi("matchups", filters, [
      JSON.stringify(filters), dbRev,
    ]);
    const muSort = useSort("winRate", "desc");
    useEffect(() => {
      const saved = readLs(LS_MU_SORT, null);
      if (saved && saved.col) {
        if (saved.col !== muSort.sortBy) muSort.onSort(saved.col);
        // direction toggle: useSort flips on same-col click; we
        // accept the default direction and let the user re-toggle.
      }
      // intentionally only on mount
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    useEffect(() => {
      writeLs(LS_MU_SORT, { col: muSort.sortBy, dir: muSort.sortDir });
    }, [muSort.sortBy, muSort.sortDir]);

    const items = useMemo(
      () => muSort.sortRows(data || [], (row, col) => row[col]),
      [data, muSort.sortBy, muSort.sortDir]
    );
    if (loading) return <Skeleton rows={3} />;
    if (items.length === 0) return null;

    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-neutral-300">Matchups</h3>
          <SortPills sort={muSort} options={[
            { col: "winRate", label: "Win rate" },
            { col: "total",   label: "Games"    },
            { col: "name",    label: "Name"     },
          ]} />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {items.map((m) => {
            const recents = recentResultsFor(recentByMu[m.name]);
            const streak  = computeStreak(recents);
            return (
              <Card key={m.name}>
                <div className="flex items-start justify-between gap-2">
                  <div className="text-xs uppercase text-neutral-500">{m.name}</div>
                  <StreakBadge streak={streak} />
                </div>
                <div className="mt-2 text-3xl font-semibold tabular-nums"
                     style={{ color: wrColor(m.winRate, m.total) }}>
                  {pct1(m.winRate)}
                </div>
                <div className="mt-1 text-xs text-neutral-500 tabular-nums">
                  {m.wins}W - {m.losses}L · {m.total} games
                </div>
                <div className="mt-3"><WrBar wins={m.wins} losses={m.losses} height={8} /></div>
                <div className="mt-3 flex items-center justify-between gap-2">
                  <span className="text-[10px] uppercase text-neutral-500">Last {SPARK_MAX}</span>
                  <FormSparkline results={recents.slice().reverse()} />
                </div>
              </Card>
            );
          })}
        </div>
      </div>
    );
  }

  // ---------- Sort pills (shared with Strategies) ----------------
  function SortPills({ sort, options }) {
    return (
      <div className="inline-flex items-center gap-1">
        <span className="text-[11px] uppercase text-neutral-500 mr-1">Sort</span>
        <div className="inline-flex bg-base-700 ring-soft rounded overflow-hidden">
          {options.map((o) => {
            const active = sort.sortBy === o.col;
            const arrow = !active ? "" : sort.sortDir === "asc" ? "▲" : "▼";
            return (
              <button key={o.col} onClick={() => sort.onSort(o.col)}
                className={`px-2 py-1 text-xs flex items-center gap-1 transition ${
                  active
                    ? "bg-accent-500/20 text-accent-300"
                    : "text-neutral-400 hover:bg-base-600"
                }`}>
                {o.label}
                {arrow && <span className="text-[9px]">{arrow}</span>}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // ---------- Maps section (table + chart) -----------------------
  function MapsSection({ filters, dbRev }) {
    const sort = useSort("total", "desc");
    const [minGames, setMinGames] = useState(() => readLs(LS_MIN_MAPS, 1));
    useEffect(() => writeLs(LS_MIN_MAPS, minGames), [minGames]);
    const { data, loading } = useApi("maps", filters, [
      JSON.stringify(filters), dbRev,
    ]);

    const filtered = useMemo(() => {
      let r = data || [];
      if (minGames > 1) r = r.filter((x) => (x.total || 0) >= minGames);
      return r;
    }, [data, minGames]);

    const items = useMemo(
      () => sort.sortRows(filtered, (row, col) => row[col]),
      [filtered, sort.sortBy, sort.sortDir]
    );

    const chartData = useMemo(() =>
      [...filtered]
        .sort((a, b) => b.total - a.total)
        .slice(0, 12)
        .map((m) => ({ name: m.name, winRate: m.winRate * 100, games: m.total })),
      [filtered]
    );

    if (loading) return <Skeleton rows={6} />;
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-sm font-semibold text-neutral-300">Maps</h3>
          <MinGames value={minGames} onChange={setMinGames} />
          <div className="ml-auto"><CsvButton kind="maps" filters={filters} /></div>
        </div>
        {items.length === 0 ? <EmptyState /> : (
          <Fragment>
            <Card title={`Top ${chartData.length} by games played (win rate)`}>
              <HBarChart data={chartData} height={320} valueKey="winRate"
                maxValue={100} format={(v) => `${v.toFixed(1)}%`}
                colorFor={(d) => wrColor(d.winRate / 100, d.games)} />
            </Card>
            <div className="bg-base-800 ring-soft rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-base-700 text-[11px] uppercase text-neutral-400">
                  <tr>
                    <SortableTh col="name"    label="Map"       {...sort} align="left" />
                    <SortableTh col="wins"    label="W"         {...sort} align="right" width="5rem" />
                    <SortableTh col="losses"  label="L"         {...sort} align="right" width="5rem" />
                    <SortableTh col="total"   label="Total"     {...sort} align="right" width="5rem" />
                    <SortableTh col="winRate" label="Win rate"  {...sort} align="right" width="6rem" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((m) => (
                    <tr key={m.name} className="border-t border-base-700 hover:bg-base-700/40">
                      <td className="py-1.5 px-3 text-neutral-200">{m.name}</td>
                      <td className="py-1.5 px-3 text-right tabular-nums text-win-500">{m.wins}</td>
                      <td className="py-1.5 px-3 text-right tabular-nums text-loss-500">{m.losses}</td>
                      <td className="py-1.5 px-3 text-right tabular-nums text-neutral-300">{m.total}</td>
                      <td className="py-1.5 px-3 text-right tabular-nums"
                          style={{ color: wrColor(m.winRate, m.total) }}>{pct1(m.winRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Fragment>
        )}
      </div>
    );
  }

  // ---------- Battlefield wrapper --------------------------------
  function BattlefieldTab({ filters, dbRev }) {
    // Pull the underlying matchups + maps once so the KPI strip can
    // summarise both without an extra fetch.
    const muData   = useApi("matchups", filters, [JSON.stringify(filters), dbRev]);
    const mapData  = useApi("maps",     filters, [JSON.stringify(filters), dbRev]);
    const recents  = useRecentForm(filters, dbRev);

    const kpis = useMemo(() => {
      const mu  = muData.data || [];
      const mp  = mapData.data || [];
      const muBW = bestWorst(mu, 5);
      const mpBW = bestWorst(mp, 5);
      return [
        { label: "Strongest matchup",
          value: muBW.best ? muBW.best.name : null,
          sub: muBW.best ? `${pct1(muBW.best.winRate)} · ${muBW.best.total} games` : "Need ≥5 games" },
        { label: "Weakest matchup",
          value: muBW.worst ? muBW.worst.name : null,
          sub: muBW.worst ? `${pct1(muBW.worst.winRate)} · ${muBW.worst.total} games` : "Need ≥5 games" },
        { label: "Best map",
          value: mpBW.best ? mpBW.best.name : null,
          sub: mpBW.best ? `${pct1(mpBW.best.winRate)} · ${mpBW.best.total} games` : "Need ≥5 games" },
        { label: "Worst map",
          value: mpBW.worst ? mpBW.worst.name : null,
          sub: mpBW.worst ? `${pct1(mpBW.worst.winRate)} · ${mpBW.worst.total} games` : "Need ≥5 games" },
      ];
    }, [muData.data, mapData.data]);

    return (
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-neutral-200">Maps</h2>
        </div>
        <KpiCards items={kpis} />
        <MatchupsOverview filters={filters} dbRev={dbRev} recentByMu={recents} />
        <MapsSection filters={filters} dbRev={dbRev} />
      </div>
    );
  }

  // Back-compat: keep MapsTab and MatchupsTab callable. They render
  // the relevant slice of the new Battlefield layout.
  function MapsTab({ filters, dbRev })     { return <MapsSection filters={filters} dbRev={dbRev} />; }
  function MatchupsTab({ filters, dbRev }) {
    const recents = useRecentForm(filters, dbRev);
    return <MatchupsOverview filters={filters} dbRev={dbRev} recentByMu={recents} />;
  }

  Object.assign(window, {
    BattlefieldTab,
    MapsTab,
    MatchupsTab,
  });
})();
