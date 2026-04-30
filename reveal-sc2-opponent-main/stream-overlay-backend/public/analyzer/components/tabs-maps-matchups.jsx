/**
 * MapsTab + MatchupsTab — extracted from index.html.
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

      function MapsTab({ filters, dbRev }) {
        const sort = useSort("total", "desc");
        const { data, loading } = useApi("maps", filters, [
          JSON.stringify(filters),
          dbRev,
        ]);
        const items = useMemo(
          () => sort.sortRows(data || [], (row, col) => row[col]),
          [data, sort.sortBy, sort.sortDir],
        );
        if (loading) return <Skeleton rows={8} />;
        const chartData = (data || [])
          .slice(0, 12)
          .map((m) => ({
            name: m.name,
            winRate: m.winRate * 100,
            games: m.total,
          }));
        return (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-neutral-200">
                Win rate by map
              </h2>
              <CsvButton kind="maps" filters={filters} />
            </div>
            {items.length === 0 ? (
              <EmptyState />
            ) : (
              <Fragment>
                <Card title="Top 12 by games played (win rate)">
                  <HBarChart
                    data={chartData}
                    height={320}
                    valueKey="winRate"
                    maxValue={100}
                    format={(v) => `${v.toFixed(1)}%`}
                    colorFor={(d) => wrColor(d.winRate / 100, d.games)}
                  />
                </Card>
                <div className="bg-base-800 ring-soft rounded-xl overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-base-700 text-[11px] uppercase text-neutral-400">
                      <tr>
                        <SortableTh
                          col="name"
                          label="Map"
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
                      {items.map((m) => (
                        <tr
                          key={m.name}
                          className="border-t border-base-700 hover:bg-base-700/40"
                        >
                          <td className="py-1.5 px-3 text-neutral-200">
                            {m.name}
                          </td>
                          <td className="py-1.5 px-3 text-right tabular-nums text-win-500">
                            {m.wins}
                          </td>
                          <td className="py-1.5 px-3 text-right tabular-nums text-loss-500">
                            {m.losses}
                          </td>
                          <td className="py-1.5 px-3 text-right tabular-nums text-neutral-300">
                            {m.total}
                          </td>
                          <td
                            className="py-1.5 px-3 text-right tabular-nums"
                            style={{ color: wrColor(m.winRate, m.total) }}
                          >
                            {pct1(m.winRate)}
                          </td>
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

      function MatchupsTab({ filters, dbRev }) {
        const { data, loading } = useApi("matchups", filters, [
          JSON.stringify(filters),
          dbRev,
        ]);
        if (loading) return <Skeleton rows={4} />;
        const items = data || [];
        return (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-neutral-200">
                Matchup overview
              </h2>
              <CsvButton kind="matchups" filters={filters} />
            </div>
            {items.length === 0 ? (
              <EmptyState />
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {items.map((m) => (
                  <Card key={m.name}>
                    <div className="text-xs uppercase text-neutral-500">
                      {m.name}
                    </div>
                    <div
                      className="mt-2 text-3xl font-semibold tabular-nums"
                      style={{ color: wrColor(m.winRate, m.total) }}
                    >
                      {pct1(m.winRate)}
                    </div>
                    <div className="mt-1 text-xs text-neutral-500 tabular-nums">
                      {m.wins}W - {m.losses}L · {m.total} games
                    </div>
                    <div className="mt-3">
                      <WrBar wins={m.wins} losses={m.losses} height={8} />
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>
        );
      }

  // Expose to global so inline-block JSX in index.html can render
  // these as bare identifiers.
  Object.assign(window, {
    MapsTab,
    MatchupsTab
  });
})();
