/**
 * Builds tab + deep-dive — extracted from index.html for size-rule compliance.
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

      function BuildsTab({ filters, dbRev, onOpen }) {
        const [hideEmpty, setHideEmpty] = useState(true);
        const [search, setSearch] = useState("");
        const sort = useSort("total", "desc");
        const { data, loading } = useApi("builds", filters, [
          JSON.stringify(filters),
          dbRev,
        ]);
        const items = useMemo(() => {
          let r = data || [];
          if (hideEmpty) r = r.filter((b) => b.total > 0);
          if (search)
            r = r.filter((b) =>
              b.name.toLowerCase().includes(search.toLowerCase()),
            );
          return sort.sortRows(r, (row, col) => row[col]);
        }, [data, sort.sortBy, sort.sortDir, hideEmpty, search]);
        if (loading) return <Skeleton rows={10} />;
        return (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="search builds…"
                className="bg-base-700 ring-soft rounded px-3 py-1.5 text-sm w-64"
              />
              <label className="text-xs flex items-center gap-1.5 text-neutral-400">
                <input
                  type="checkbox"
                  checked={hideEmpty}
                  onChange={(e) => setHideEmpty(e.target.checked)}
                  className="accent-accent-500"
                />{" "}
                Hide empty
              </label>
              <span className="text-xs text-neutral-500 ml-2">
                click any column to sort · click a row to open deep dive →
              </span>
              <CsvButton kind="builds" filters={filters} />
            </div>
            <div className="bg-base-800 ring-soft rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-base-700 text-[11px] uppercase text-neutral-400">
                  <tr>
                    <SortableTh
                      col="name"
                      label="Build"
                      {...sort}
                      align="left"
                    />
                    <SortableTh
                      col="wins"
                      label="Wins"
                      {...sort}
                      align="right"
                      width="5rem"
                    />
                    <SortableTh
                      col="losses"
                      label="Losses"
                      {...sort}
                      align="right"
                      width="5rem"
                    />
                    <SortableTh
                      col="total"
                      label="Total"
                      {...sort}
                      align="right"
                      width="5rem"
                    />
                    <SortableTh
                      col="winRate"
                      label="Win rate"
                      {...sort}
                      align="right"
                      width="6rem"
                    />
                    <th className="px-3 w-48">&nbsp;</th>
                    <SortableTh
                      col="lastPlayed"
                      label="Last"
                      {...sort}
                      align="right"
                      width="7rem"
                    />
                    <th className="text-right py-2 px-3 w-12 text-neutral-500">
                      →
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 ? (
                    <tr>
                      <td colSpan="8">
                        {window.BuildsEmptyState
                          ? <window.BuildsEmptyState filters={filters} />
                          : <EmptyState />}
                      </td>
                    </tr>
                  ) : (
                    items.map((b) => (
                      <tr
                        key={b.name}
                        onClick={() => onOpen && onOpen(b.name)}
                        className="border-t border-base-700 hover:bg-accent-500/10 cursor-pointer group"
                      >
                        <td className="py-1.5 px-3 text-neutral-200 group-hover:text-accent-400">
                          {b.name}
                        </td>
                        <td className="py-1.5 px-3 text-right tabular-nums text-win-500">
                          {b.wins}
                        </td>
                        <td className="py-1.5 px-3 text-right tabular-nums text-loss-500">
                          {b.losses}
                        </td>
                        <td className="py-1.5 px-3 text-right tabular-nums text-neutral-300">
                          {b.total}
                        </td>
                        <td
                          className="py-1.5 px-3 text-right tabular-nums"
                          style={{ color: wrColor(b.winRate, b.total) }}
                        >
                          {pct1(b.winRate)}
                        </td>
                        <td className="py-1.5 px-3">
                          <WrBar wins={b.wins} losses={b.losses} />
                        </td>
                        <td className="py-1.5 px-3 text-right text-xs text-neutral-500">
                          {b.lastPlayed ? fmtAgo(b.lastPlayed) : "—"}
                        </td>
                        <td className="py-1.5 px-3 text-right text-neutral-600 group-hover:text-accent-400">
                          →
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        );
      }

      // ============================================================

      // ============================================================
      // BUILD DEEP DIVE  (drill-down from My Builds tab)
      // Server returns games newest-first; we render that order verbatim.
      // ============================================================
      function BuildDeepDive({ buildName, filters, onBack, dbRev }) {
        const { data, loading, error } = useApi(
          `builds/${encodeURIComponent(buildName)}`,
          filters,
          [buildName, JSON.stringify(filters || {}), dbRev],
        );
        if (loading) return <Skeleton rows={6} />;
        if (error || !data)
          return (
            <div>
              <BackBtn onClick={onBack} />
              <EmptyState title="Build not found" sub={buildName} />
            </div>
          );
        const t = data.totals || {};
        const byStrat = Object.entries(data.byOppStrategy || {})
          .map(([name, v]) => ({
            name,
            ...v,
            total: v.wins + v.losses,
            winRate: v.wins + v.losses ? v.wins / (v.wins + v.losses) : 0,
          }))
          .sort((a, b) => b.total - a.total);
        const byMap = Object.entries(data.byMap || {})
          .map(([name, v]) => ({
            name,
            ...v,
            total: v.wins + v.losses,
            winRate: v.wins + v.losses ? v.wins / (v.wins + v.losses) : 0,
          }))
          .sort((a, b) => b.total - a.total);
        const byOpp = Object.entries(data.byOpponent || {})
          .map(([name, v]) => ({
            name,
            ...v,
            total: v.wins + v.losses,
            winRate: v.wins + v.losses ? v.wins / (v.wins + v.losses) : 0,
          }))
          .sort((a, b) => b.total - a.total)
          .slice(0, 12);
        const games = data.games || [];
        return (
          <div className="space-y-5">
            <BackBtn onClick={onBack} />
            <div className="flex items-end justify-between flex-wrap gap-4">
              <div>
                <h1 className="text-2xl font-semibold text-neutral-100">
                  {data.name}
                </h1>
                <div className="text-xs text-neutral-500">
                  Deep dive · {games.length} games (newest first)
                </div>
              </div>
              <div className="grid grid-cols-4 gap-3">
                <Stat label="Games" value={t.total || 0} />
                <Stat label="W" value={t.wins || 0} color="#3ddc97" />
                <Stat label="L" value={t.losses || 0} color="#ef476f" />
                <Stat
                  label="WR"
                  value={pct1(t.winRate)}
                  color={wrColor(t.winRate, t.total)}
                />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <Card title="Vs opponent strategy">
                {byStrat.length === 0 ? (
                  <EmptyState sub="No strategies tagged" />
                ) : (
                  <div className="space-y-2">
                    {byStrat.slice(0, 12).map((s) => (
                      <div key={s.name}>
                        <div className="flex justify-between text-sm">
                          <span className="text-neutral-300">{s.name}</span>
                          <span className="tabular-nums text-neutral-400">
                            {s.wins}-{s.losses} ·{" "}
                            <span
                              style={{ color: wrColor(s.winRate, s.total) }}
                            >
                              {pct(s.winRate)}
                            </span>
                          </span>
                        </div>
                        <WrBar wins={s.wins} losses={s.losses} />
                      </div>
                    ))}
                  </div>
                )}
              </Card>
              <Card title="Vs map">
                {byMap.length === 0 ? (
                  <EmptyState sub="No map data" />
                ) : (
                  <div className="space-y-2">
                    {byMap.slice(0, 12).map((m) => (
                      <div key={m.name}>
                        <div className="flex justify-between text-sm">
                          <span className="text-neutral-300">{m.name}</span>
                          <span className="tabular-nums text-neutral-400">
                            {m.wins}-{m.losses} ·{" "}
                            <span
                              style={{ color: wrColor(m.winRate, m.total) }}
                            >
                              {pct(m.winRate)}
                            </span>
                          </span>
                        </div>
                        <WrBar wins={m.wins} losses={m.losses} />
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>
            <Card title="Top opponents on this build">
              {byOpp.length === 0 ? (
                <EmptyState sub="No opponent data" />
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                  {byOpp.map((o) => (
                    <div
                      key={o.name}
                      className="bg-base-700 ring-soft rounded px-3 py-2 flex items-center justify-between"
                    >
                      <span
                        className="text-sm text-neutral-300 truncate"
                        title={o.name}
                      >
                        {o.name}
                      </span>
                      <span className="tabular-nums text-xs text-neutral-400 ml-3 whitespace-nowrap">
                        {o.wins}-{o.losses} ·{" "}
                        <span style={{ color: wrColor(o.winRate, o.total) }}>
                          {pct(o.winRate)}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
            <Card title={`All games · ${games.length} (newest first)`}>
              <div className="overflow-x-auto -mx-2 max-h-[560px]">
                <GamesTableWithBuildOrder games={games} />
              </div>
            </Card>
          </div>
        );
      }

  // Expose to global so inline-block JSX in index.html can render
  // these as bare identifiers.
  Object.assign(window, {
    BuildsTab,
    BuildDeepDive
  });
})();
