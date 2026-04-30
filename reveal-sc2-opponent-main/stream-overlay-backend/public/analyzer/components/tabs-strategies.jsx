/**
 * StrategiesTab + BuildVsStrategyTab — extracted from index.html.
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

      function StrategiesTab({ filters, dbRev }) {
        const { data, loading } = useApi("opp-strategies", filters, [
          JSON.stringify(filters),
          dbRev,
        ]);
        if (loading) return <Skeleton rows={6} />;
        const items = data || [];
        return (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-neutral-200">
                Win rate vs opponent strategies
              </h2>
              <CsvButton kind="opp-strategies" filters={filters} />
            </div>
            {items.length === 0 ? (
              <EmptyState />
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {items.map((s) => (
                  <div
                    key={s.name}
                    className="bg-base-800 ring-soft rounded-lg p-4"
                  >
                    <div
                      className="text-sm font-medium text-neutral-200 truncate"
                      title={s.name}
                    >
                      {s.name}
                    </div>
                    <div className="mt-2 flex items-baseline justify-between">
                      <span
                        className="text-2xl font-semibold tabular-nums"
                        style={{ color: wrColor(s.winRate, s.total) }}
                      >
                        {pct1(s.winRate)}
                      </span>
                      <span className="text-xs text-neutral-500 tabular-nums">
                        {s.wins}W - {s.losses}L
                      </span>
                    </div>
                    <WrBar wins={s.wins} losses={s.losses} />
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      }

      function BuildVsStrategyTab({ filters, dbRev }) {
        const [search, setSearch] = useState("");
        const sort = useSort("total", "desc");
        const { data, loading } = useApi("build-vs-strategy", filters, [
          JSON.stringify(filters),
          dbRev,
        ]);
        const rows = useMemo(() => {
          let r = data || [];
          if (search) {
            const s = search.toLowerCase();
            r = r.filter(
              (x) =>
                x.my_build.toLowerCase().includes(s) ||
                x.opp_strat.toLowerCase().includes(s),
            );
          }
          return sort.sortRows(r, (row, col) => row[col]);
        }, [data, search, sort.sortBy, sort.sortDir]);
        if (loading) return <Skeleton rows={10} />;
        return (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="search build or strategy…"
                className="bg-base-700 ring-soft rounded px-3 py-1.5 text-sm w-72"
              />
              <span className="text-xs text-neutral-500 ml-2">
                click any column header to sort
              </span>
              <CsvButton kind="build-vs-strategy" filters={filters} />
            </div>
            <div className="bg-base-800 ring-soft rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-base-700 text-[11px] uppercase text-neutral-400">
                  <tr>
                    <SortableTh
                      col="my_build"
                      label="My build"
                      {...sort}
                      align="left"
                    />
                    <SortableTh
                      col="opp_strat"
                      label="vs Opponent strategy"
                      {...sort}
                      align="left"
                    />
                    <SortableTh
                      col="wins"
                      label="W"
                      {...sort}
                      align="right"
                      width="5rem"
                    />
                    <SortableTh
                      col="losses"
                      label="L"
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
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan="6">
                        <EmptyState />
                      </td>
                    </tr>
                  ) : (
                    rows.map((r) => (
                      <tr
                        key={`${r.my_build}|${r.opp_strat}`}
                        className="border-t border-base-700 hover:bg-base-700/40"
                      >
                        <td className="py-1.5 px-3 text-neutral-200">
                          {r.my_build}
                        </td>
                        <td className="py-1.5 px-3 text-neutral-300">
                          {r.opp_strat}
                        </td>
                        <td className="py-1.5 px-3 text-right tabular-nums text-win-500">
                          {r.wins}
                        </td>
                        <td className="py-1.5 px-3 text-right tabular-nums text-loss-500">
                          {r.losses}
                        </td>
                        <td className="py-1.5 px-3 text-right tabular-nums text-neutral-300">
                          {r.total}
                        </td>
                        <td
                          className="py-1.5 px-3 text-right tabular-nums"
                          style={{ color: wrColor(r.winRate, r.total) }}
                        >
                          {pct1(r.winRate)}
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

  // Expose to global so inline-block JSX in index.html can render
  // these as bare identifiers.
  Object.assign(window, {
    StrategiesTab,
    BuildVsStrategyTab
  });
})();
