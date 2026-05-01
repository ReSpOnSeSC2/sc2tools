/**
 * StrategiesTab + Build x Strategy heatmap/table — extracted from index.html.
 *
 * Loaded from index.html via:
 *   <script type="text/babel" data-presets="react" src="..."></script>
 *
 * Stage UI-revamp-1: consolidates the old "Opp Strategies" and
 * "Build vs Strategy" tabs into a single "Strategies" tab with two
 * sub-views toggleable at the top, plus a Build x Strategy heatmap.
 *
 * Stage UI-revamp-2: opponent-strategy cards, BvS heatmap cells, and
 * BvS table rows are clickable. Click drills down into a games list
 * (/api/analyzer/games?opp_strategy=&build=) rendered with the same
 * GamesTableWithBuildOrder used on the Opponents tab — row click =
 * build order, macro click = breakdown panel, modal = full game
 * detail. Mirrors the "All games" affordance from OpponentProfile.
 *
 * DO NOT EDIT THE EXTRACTED BODY HERE WITHOUT ALSO UPDATING THE
 * MATCHING SECTION IN index.html — the two MUST NOT BOTH EXIST.
 */
(function () {
  "use strict";
  const React = window.React;
  const { useState, useEffect, useMemo, useCallback, useRef, Fragment } = React;

  // ---------- localStorage keys ----------------------------------
  const LS_VIEW    = "analyzer.strategies.view";       // "opp" | "bvs"
  const LS_MIN     = "analyzer.strategies.minGames";   // number
  const LS_BVS_VW  = "analyzer.strategies.bvs.view";   // "heatmap" | "table"

  // Min-games filter: shared steps so all grids feel the same.
  const MIN_STEPS = [1, 3, 5, 10, 20];

  function readLs(key, fallback) {
    try {
      const v = window.localStorage && window.localStorage.getItem(key);
      if (v == null) return fallback;
      return JSON.parse(v);
    } catch (_e) { return fallback; }
  }
  function writeLs(key, value) {
    try { window.localStorage && window.localStorage.setItem(key, JSON.stringify(value)); }
    catch (_e) { /* non-fatal */ }
  }

  // ---------- small primitives -----------------------------------
  function MinGamesFilter({ value, onChange }) {
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
              }`}
              title={`Hide rows with fewer than ${n} games`}>{n}</button>
          ))}
        </div>
      </div>
    );
  }

  function KpiStrip({ items }) {
    if (!items || items.length === 0) return null;
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

  function bestWorst(rows, minGames) {
    const eligible = (rows || []).filter((r) => (r.total || 0) >= minGames);
    if (eligible.length === 0) return { best: null, worst: null };
    const sorted = [...eligible].sort((a, b) => b.winRate - a.winRate);
    return { best: sorted[0], worst: sorted[sorted.length - 1] };
  }

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

  // ---------- View 1: by Opponent Strategy -----------------------
  function ByOppStrategyView({ filters, dbRev, onOpenStrategy }) {
    const { data, loading } = useApi("opp-strategies", filters, [
      JSON.stringify(filters), dbRev,
    ]);
    const [search, setSearch] = useState("");
    const sort = useSort("winRate", "desc");
    const [minGames, setMinGames] = useState(() => readLs(LS_MIN, 3));
    useEffect(() => writeLs(LS_MIN, minGames), [minGames]);

    const rows = useMemo(() => {
      let r = data || [];
      const s = search.trim().toLowerCase();
      if (s) r = r.filter((x) => (x.name || "").toLowerCase().includes(s));
      if (minGames > 1) r = r.filter((x) => (x.total || 0) >= minGames);
      return sort.sortRows(r, (row, col) => row[col]);
    }, [data, search, minGames, sort.sortBy, sort.sortDir]);

    const kpis = useMemo(() => {
      const all = data || [];
      const totalGames = all.reduce((a, x) => a + (x.total || 0), 0);
      const totalWins  = all.reduce((a, x) => a + (x.wins || 0), 0);
      const wr = totalGames ? totalWins / totalGames : 0;
      const mostPlayed = [...all].sort((a, b) => b.total - a.total)[0] || null;
      const { best, worst } = bestWorst(all, minGames);
      return [
        { label: "Strategies tracked", value: String(all.length),
          sub: `${totalGames} games · ${pct1(wr)} overall` },
        { label: "Most played",
          value: mostPlayed ? mostPlayed.name : null,
          sub: mostPlayed ? `${mostPlayed.total} games · ${pct1(mostPlayed.winRate)}` : null },
        { label: "Best vs (≥" + minGames + ")",
          value: best ? best.name : null,
          sub: best ? `${pct1(best.winRate)} · ${best.total} games` : "Not enough data" },
        { label: "Worst vs (≥" + minGames + ")",
          value: worst ? worst.name : null,
          sub: worst ? `${pct1(worst.winRate)} · ${worst.total} games` : "Not enough data" },
      ];
    }, [data, minGames]);

    if (loading) return <Skeleton rows={6} />;

    return (
      <div className="space-y-4">
        <KpiStrip items={kpis} />
        <div className="flex flex-wrap items-center gap-3">
          <input type="text" value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="search strategy name…"
            className="bg-base-700 ring-soft rounded px-3 py-1.5 text-sm w-72" />
          <MinGamesFilter value={minGames} onChange={setMinGames} />
          <div className="ml-auto flex items-center gap-2">
            <SortPills sort={sort} options={[
              { col: "winRate", label: "Win rate" },
              { col: "total",   label: "Games"    },
              { col: "name",    label: "Name"     },
            ]} />
            <CsvButton kind="opp-strategies" filters={filters} />
          </div>
        </div>
        <div className="text-[11px] text-neutral-500">
          Click any card to see the games where you faced that strategy.
        </div>
        {rows.length === 0 ? (
          <EmptyState sub={(data || []).length > 0
            ? `No strategies match your filter (search / min games ${minGames}).`
            : undefined} />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {rows.map((s) => (
              <button key={s.name} type="button"
                onClick={() => onOpenStrategy && onOpenStrategy(s.name)}
                className="text-left bg-base-800 ring-soft rounded-lg p-4
                           hover:bg-base-700/60 hover:ring-accent-500/40
                           focus:outline-none focus-visible:ring-2
                           focus-visible:ring-accent-500 transition">
                <div className="text-sm font-medium text-neutral-200 truncate"
                     title={s.name}>{s.name}</div>
                <div className="mt-2 flex items-baseline justify-between">
                  <span className="text-2xl font-semibold tabular-nums"
                        style={{ color: wrColor(s.winRate, s.total) }}>
                    {pct1(s.winRate)}
                  </span>
                  <span className="text-xs text-neutral-500 tabular-nums">
                    {s.wins}W - {s.losses}L
                  </span>
                </div>
                <WrBar wins={s.wins} losses={s.losses} />
                <div className="mt-2 flex items-center justify-between text-[11px] text-neutral-500 tabular-nums">
                  <span>{s.total} games</span>
                  <span className="opacity-0 group-hover:opacity-100">view games →</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ---------- View 2: Build x Strategy ---------------------------
  function BuildXStrategyView({ filters, dbRev, onOpenBvs }) {
    const [search, setSearch] = useState("");
    const sort = useSort("total", "desc");
    const [minGames, setMinGames] = useState(() => readLs(LS_MIN, 3));
    const [view, setView] = useState(() => readLs(LS_BVS_VW, "heatmap"));
    useEffect(() => writeLs(LS_BVS_VW, view), [view]);
    useEffect(() => writeLs(LS_MIN, minGames), [minGames]);

    const { data, loading } = useApi("build-vs-strategy", filters, [
      JSON.stringify(filters), dbRev,
    ]);

    const filtered = useMemo(() => {
      let r = data || [];
      const s = search.trim().toLowerCase();
      if (s) r = r.filter((x) =>
        x.my_build.toLowerCase().includes(s) ||
        x.opp_strat.toLowerCase().includes(s));
      if (minGames > 1) r = r.filter((x) => (x.total || 0) >= minGames);
      return r;
    }, [data, search, minGames]);

    const rows = useMemo(
      () => sort.sortRows(filtered, (row, col) => row[col]),
      [filtered, sort.sortBy, sort.sortDir]
    );

    if (loading) return <Skeleton rows={10} />;

    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <input type="text" value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="search build or strategy…"
            className="bg-base-700 ring-soft rounded px-3 py-1.5 text-sm w-72" />
          <MinGamesFilter value={minGames} onChange={setMinGames} />
          <div className="inline-flex bg-base-700 ring-soft rounded overflow-hidden">
            {["heatmap", "table"].map((v) => (
              <button key={v} onClick={() => setView(v)}
                className={`px-3 py-1 text-xs capitalize transition ${
                  view === v
                    ? "bg-accent-500/20 text-accent-300"
                    : "text-neutral-400 hover:bg-base-600"
                }`}>{v}</button>
            ))}
          </div>
          <div className="ml-auto"><CsvButton kind="build-vs-strategy" filters={filters} /></div>
        </div>
        <div className="text-[11px] text-neutral-500">
          Click any cell or row to see the games for that build × strategy combo.
        </div>
        {rows.length === 0 ? <EmptyState /> : (
          view === "heatmap"
            ? <BvsHeatmap rows={filtered} onOpenBvs={onOpenBvs} />
            : <BvsTable rows={rows} sort={sort} onOpenBvs={onOpenBvs} />
        )}
      </div>
    );
  }

  // ---------- Heatmap component (Build x Strategy) ---------------
  function BvsHeatmap({ rows, onOpenBvs }) {
    const grid = useMemo(() => {
      const builds  = [...new Set(rows.map((r) => r.my_build))].sort();
      const strats  = [...new Set(rows.map((r) => r.opp_strat))].sort();
      const lookup  = new Map(rows.map((r) =>
        [`${r.my_build}|${r.opp_strat}`, r]));
      return { builds, strats, lookup };
    }, [rows]);
    if (grid.builds.length === 0 || grid.strats.length === 0) return <EmptyState />;
    const maxGames = Math.max(...rows.map((r) => r.total || 0), 1);
    return (
      <div className="bg-base-800 ring-soft rounded-xl p-3 overflow-auto">
        <table className="text-xs border-collapse">
          <thead>
            <tr>
              <th className="sticky left-0 bg-base-800 px-2 py-1 text-left text-neutral-500">
                My build ↓ / vs →
              </th>
              {grid.strats.map((s) => (
                <th key={s} className="px-1 py-1 text-neutral-400 align-bottom"
                    style={{ minWidth: "5.5rem", maxWidth: "8rem" }}>
                  <div className="truncate" title={s}>{s}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.builds.map((b) => (
              <tr key={b}>
                <td className="sticky left-0 bg-base-800 px-2 py-1 text-neutral-300 truncate"
                    style={{ maxWidth: "12rem" }} title={b}>{b}</td>
                {grid.strats.map((s) => {
                  const cell = grid.lookup.get(`${b}|${s}`);
                  if (!cell) {
                    return (
                      <td key={s} className="px-0.5 py-0.5">
                        <div className="rounded bg-base-700/40 h-9" />
                      </td>
                    );
                  }
                  const intensity = 0.35 + 0.65 * (cell.total / maxGames);
                  return (
                    <td key={s} className="px-0.5 py-0.5">
                      <button type="button"
                        onClick={() => onOpenBvs && onOpenBvs(b, s)}
                        className="w-full rounded h-9 flex items-center justify-center
                                   text-[11px] tabular-nums font-semibold
                                   ring-1 ring-inset ring-black/30 cursor-pointer
                                   hover:ring-2 hover:ring-accent-400/80
                                   focus:outline-none focus-visible:ring-2
                                   focus-visible:ring-accent-500 transition"
                        style={{
                          background: wrColor(cell.winRate, cell.total),
                          opacity: intensity,
                          color: "#0c0c0c",
                        }}
                        title={`${b} vs ${s}\n${cell.wins}W - ${cell.losses}L · ${cell.total} games · ${pct1(cell.winRate)}\nClick to see the games.`}>
                        {pct1(cell.winRate).replace(".0", "")}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-2 text-[10px] text-neutral-500">
          Cell color = win rate. Cell opacity = sample size. Click a cell to see the games.
        </div>
      </div>
    );
  }

  // ---------- Table component (Build x Strategy) -----------------
  function BvsTable({ rows, sort, onOpenBvs }) {
    return (
      <div className="bg-base-800 ring-soft rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-base-700 text-[11px] uppercase text-neutral-400">
            <tr>
              <SortableTh col="my_build"  label="My build" {...sort} align="left" />
              <SortableTh col="opp_strat" label="vs Opponent strategy" {...sort} align="left" />
              <SortableTh col="wins"      label="W"        {...sort} align="right" width="5rem" />
              <SortableTh col="losses"    label="L"        {...sort} align="right" width="5rem" />
              <SortableTh col="total"     label="Total"    {...sort} align="right" width="5rem" />
              <SortableTh col="winRate"   label="Win rate" {...sort} align="right" width="6rem" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.my_build}|${r.opp_strat}`}
                  onClick={() => onOpenBvs && onOpenBvs(r.my_build, r.opp_strat)}
                  className="border-t border-base-700 hover:bg-base-700/40 cursor-pointer"
                  title="Click to see the games">
                <td className="py-1.5 px-3 text-neutral-200">{r.my_build}</td>
                <td className="py-1.5 px-3 text-neutral-300">{r.opp_strat}</td>
                <td className="py-1.5 px-3 text-right tabular-nums text-win-500">{r.wins}</td>
                <td className="py-1.5 px-3 text-right tabular-nums text-loss-500">{r.losses}</td>
                <td className="py-1.5 px-3 text-right tabular-nums text-neutral-300">{r.total}</td>
                <td className="py-1.5 px-3 text-right tabular-nums"
                    style={{ color: wrColor(r.winRate, r.total) }}>{pct1(r.winRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // ---------- Drill-down: games list view ------------------------
  // Mirrors the "All games" affordance from OpponentProfile. Fetches
  // /api/analyzer/games merging the parent filters with the strategy
  // (and optionally build) filter, normalises field names so the
  // shared GamesTableWithBuildOrder accepts the rows, and renders
  // the same row-click → build order, macro-click → breakdown UX.
  function StrategyGamesView({ openFilter, parentFilters, dbRev, onBack }) {
    const [state, setState] = useState({ loading: true, error: null, games: [] });
    const queryParams = useMemo(() => {
      const params = { ...(parentFilters || {}), ...openFilter };
      // The server's parseFilters applies build + opp_strategy
      // server-side, so the cached aggregator returns the filtered
      // rows directly. Belt + suspenders: we also filter again
      // client-side below to defend against schema drift.
      return params;
    }, [openFilter, parentFilters]);

    useEffect(() => {
      let cancelled = false;
      setState({ loading: true, error: null, games: [] });
      (async () => {
        try {
          const j = await api("games", { ...queryParams, limit: 5000, sort: "date_desc" });
          if (cancelled) return;
          const raw = (j && j.games) || [];
          // Defensive client-side filter so a server that ignored an
          // unknown query param can't leak unrelated games into the
          // drill-down. Both fields are present on /games rows.
          const wantStrat = openFilter && openFilter.opp_strategy;
          const wantBuild = openFilter && openFilter.build;
          const filtered = raw.filter((g) => {
            if (wantStrat && (g.opp_strategy || "Unknown") !== wantStrat) return false;
            if (wantBuild && g.build !== wantBuild) return false;
            return true;
          });
          setState({ loading: false, error: null, games: filtered });
        } catch (err) {
          if (!cancelled) setState({ loading: false, error: err.message, games: [] });
        }
      })();
      return () => { cancelled = true; };
    }, [JSON.stringify(queryParams), dbRev]);

    const tableRows = useMemo(
      () => state.games.map((g) => ({
        ...g,
        // GamesTableWithBuildOrder reads `g.my_build` for the "My
        // Build" column; /games returns it as `build`. Keep both so
        // legacy/extended consumers stay happy.
        my_build: g.build || g.my_build || "",
      })),
      [state.games]
    );

    const titleText = useMemo(() => {
      if (openFilter && openFilter.build && openFilter.opp_strategy) {
        return `${openFilter.build}  vs  ${openFilter.opp_strategy}`;
      }
      if (openFilter && openFilter.opp_strategy) {
        return `vs ${openFilter.opp_strategy}`;
      }
      return "Games";
    }, [openFilter]);

    const summary = useMemo(() => {
      const total = tableRows.length;
      let wins = 0, losses = 0;
      for (const g of tableRows) {
        const r = String(g.result || "").toLowerCase();
        if (r === "win" || r === "victory") wins++;
        else if (r === "loss" || r === "defeat") losses++;
      }
      const wr = total ? wins / total : 0;
      return { total, wins, losses, wr };
    }, [tableRows]);

    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3 flex-wrap">
          <button onClick={onBack}
            className="text-xs uppercase tracking-wider text-neutral-400 hover:text-neutral-200">
            ← back to strategies
          </button>
          <h2 className="text-base font-semibold text-neutral-200 truncate">
            {titleText}
          </h2>
          {!state.loading && summary.total > 0 && (
            <div className="ml-auto text-xs text-neutral-500 tabular-nums">
              <span className="text-neutral-400">{summary.total}</span> games ·{" "}
              <span className="text-win-500">{summary.wins}W</span> -{" "}
              <span className="text-loss-500">{summary.losses}L</span> ·{" "}
              <span style={{ color: wrColor(summary.wr, summary.total) }}>
                {pct1(summary.wr)}
              </span>
            </div>
          )}
        </div>
        {state.loading ? (
          <Skeleton rows={6} />
        ) : state.error ? (
          <EmptyState title="Couldn't load games" sub={state.error} />
        ) : tableRows.length === 0 ? (
          <EmptyState sub="No games match this filter combination." />
        ) : (
          <Card title={`All games (${tableRows.length}) · newest first`}>
            <div className="overflow-x-auto -mx-2 max-h-[640px]">
              <GamesTableWithBuildOrder games={tableRows} perspective="self" />
            </div>
          </Card>
        )}
      </div>
    );
  }

  // ---------- Tab shell with sub-view toggle ---------------------
  function StrategiesTab({ filters, dbRev }) {
    const [view, setView] = useState(() => readLs(LS_VIEW, "opp"));
    // openFilter shape:
    //   { opp_strategy: "..." }              -- from a card click
    //   { opp_strategy: "...", build: "..." } -- from a heatmap cell / row click
    //   null                                  -- normal aggregate views
    const [openFilter, setOpenFilter] = useState(null);
    useEffect(() => writeLs(LS_VIEW, view), [view]);

    // If parent filters change (race split, season selector, etc.),
    // close the drill-down so the user isn't staring at stale rows.
    const filtersKey = JSON.stringify(filters);
    useEffect(() => { setOpenFilter(null); }, [filtersKey]);

    if (openFilter) {
      return (
        <StrategyGamesView openFilter={openFilter}
                           parentFilters={filters}
                           dbRev={dbRev}
                           onBack={() => setOpenFilter(null)} />
      );
    }

    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-neutral-200">
            {view === "opp"
              ? "Win rate vs opponent strategies"
              : "My build × Their strategy"}
          </h2>
          <div className="inline-flex bg-base-700 ring-soft rounded overflow-hidden">
            <button onClick={() => setView("opp")}
              className={`px-3 py-1.5 text-xs transition ${
                view === "opp"
                  ? "bg-accent-500/20 text-accent-300"
                  : "text-neutral-400 hover:bg-base-600"
              }`}>By opponent strategy</button>
            <button onClick={() => setView("bvs")}
              className={`px-3 py-1.5 text-xs transition ${
                view === "bvs"
                  ? "bg-accent-500/20 text-accent-300"
                  : "text-neutral-400 hover:bg-base-600"
              }`}>Build × Strategy</button>
          </div>
        </div>
        {view === "opp" ? (
          <ByOppStrategyView
            filters={filters} dbRev={dbRev}
            onOpenStrategy={(name) => setOpenFilter({ opp_strategy: name })} />
        ) : (
          <BuildXStrategyView
            filters={filters} dbRev={dbRev}
            onOpenBvs={(my_build, opp_strat) =>
              setOpenFilter({ build: my_build, opp_strategy: opp_strat })} />
        )}
      </div>
    );
  }

  // Back-compat: still expose BuildVsStrategyTab as a thin wrapper
  // around the dedicated view, in case any caller still references
  // it directly. The TABS array no longer routes to it.
  function BuildVsStrategyTab({ filters, dbRev }) {
    return <BuildXStrategyView filters={filters} dbRev={dbRev}
                               onOpenBvs={() => { /* no-op outside StrategiesTab */ }} />;
  }

  Object.assign(window, {
    StrategiesTab,
    BuildVsStrategyTab,
    SortPills,
    MinGamesFilter,
    KpiStrip,
  });
})();
