/**
 * OpponentsTab + OpponentProfile + BackBtn — extracted from index.html.
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

      function OpponentsTab({ filters, dbRev, onOpen }) {
        const [search, setSearch] = useState("");
        const [minGames, setMinGames] = useState(1);
        // Merge the global filter bar (since/until/race/opp_race/map/mmr/etc.)
        // into the per-tab params before hitting the API. Without this,
        // changing the season filter would refresh every other tab but leave
        // Opponents stuck on the unfiltered, whole-history result set.
        const params = useMemo(
          () =>
            Object.assign({}, filters || {}, {
              search,
              min_games: minGames,
              limit: 1000,
            }),
          [filters, search, minGames],
        );
        const sort = useSort("lastPlayed", "desc");
        const { data, loading } = useApi("opponents", params, [
          JSON.stringify(params),
          dbRev,
        ]);
        const items = useMemo(
          () => sort.sortRows(data || [], (row, col) => row[col]),
          [data, sort.sortBy, sort.sortDir],
        );
        if (loading) return <Skeleton rows={10} />;
        return (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="search opponent name or ID…"
                className="bg-base-700 ring-soft rounded px-3 py-1.5 text-sm w-72"
              />
              <div className="flex items-center gap-2">
                <span className="text-xs uppercase text-neutral-500">
                  Min games
                </span>
                <input
                  type="number"
                  min="1"
                  value={minGames}
                  onChange={(e) => setMinGames(Number(e.target.value) || 1)}
                  className="bg-base-700 ring-soft rounded px-2 py-1 text-sm w-16"
                />
              </div>
              <span className="text-xs text-neutral-500">
                click any column to sort · click a row to open deep dive →
              </span>
              <CsvButton kind="opponents" filters={params} />
            </div>
            <div className="bg-base-800 ring-soft rounded-xl overflow-x-auto">
              <table className="w-full text-sm table-fixed">
                <thead className="bg-base-700 text-[11px] uppercase text-neutral-400">
                  <tr>
                    <SortableTh
                      col="name"
                      label="Opponent"
                      {...sort}
                      align="left"
                    />
                    <SortableTh
                      col="pulseId"
                      label="Pulse ID"
                      {...sort}
                      align="left"
                      width="8rem"
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
                      col="games"
                      label="Games"
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
                    <SortableTh
                      col="lastPlayed"
                      label="Last"
                      {...sort}
                      align="right"
                      width="8rem"
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
                        <EmptyState />
                      </td>
                    </tr>
                  ) : (
                    items.map((o) => (
                      <tr
                        key={o.pulseId}
                        onClick={() => onOpen(o.pulseId)}
                        className="border-t border-base-700 hover:bg-accent-500/10 cursor-pointer group"
                      >
                        <td className="py-1.5 px-3 text-neutral-200 group-hover:text-accent-400 truncate" title={o.name || ""}>
                          {o.name || (
                            <span className="text-neutral-500 italic">
                              unnamed
                            </span>
                          )}
                        </td>
                        <td className="py-1.5 px-3 text-xs text-neutral-500 font-mono truncate" title={o.pulseId}>
                          {o.pulseId}
                        </td>
                        <td className="py-1.5 px-3 text-right tabular-nums text-win-500">
                          {o.wins}
                        </td>
                        <td className="py-1.5 px-3 text-right tabular-nums text-loss-500">
                          {o.losses}
                        </td>
                        <td className="py-1.5 px-3 text-right tabular-nums text-neutral-300">
                          {o.games}
                        </td>
                        <td
                          className="py-1.5 px-3 text-right tabular-nums"
                          style={{ color: wrColor(o.winRate, o.games) }}
                        >
                          {pct1(o.winRate)}
                        </td>
                        <td className="py-1.5 px-3 text-right text-xs text-neutral-500">
                          {o.lastPlayed ? fmtAgo(o.lastPlayed) : "—"}
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

      function OpponentProfile({ pulseId, onBack, dbRev }) {
        const { data, loading, error } = useApi(
          `opponents/${encodeURIComponent(pulseId)}`,
          null,
          [pulseId, dbRev],
        );
        // Lifted state so the timings-drilldown 'open game →' link can
        // ask the games table at the bottom of the page to expand a
        // specific row. Bumping `targetSeq` re-fires the effect that scrolls
        // and expands even if the user clicks the same gameId twice.
        const [targetGameId, setTargetGameId] = useState(null);
        const [targetSeq, setTargetSeq] = useState(0);
        const handleOpenGame = (id) => {
          if (!id) return;
          setTargetGameId(id);
          setTargetSeq((s) => s + 1);
        };
        if (loading) return <Skeleton rows={6} />;
        if (error || !data)
          return (
            <div>
              <BackBtn onClick={onBack} />
              <EmptyState title="Opponent not found" sub={pulseId} />
            </div>
          );
        const t = data.totals || {};
        const byMap = Object.entries(data.byMap || {})
          .map(([k, v]) => ({
            name: k,
            ...v,
            total: v.wins + v.losses,
            winRate: v.wins + v.losses ? v.wins / (v.wins + v.losses) : 0,
          }))
          .sort((a, b) => b.total - a.total);
        const byStrategy = Object.entries(data.byStrategy || {})
          .map(([k, v]) => ({
            name: k,
            ...v,
            total: v.wins + v.losses,
            winRate: v.wins + v.losses ? v.wins / (v.wins + v.losses) : 0,
          }))
          .sort((a, b) => b.total - a.total);
        return (
          <div className="space-y-5">
            <BackBtn onClick={onBack} />
            <div className="flex items-end justify-between flex-wrap gap-4">
              <div>
                <h1 className="text-2xl font-semibold text-neutral-100">
                  {data.name || "unnamed"}
                </h1>
                <div className="text-xs text-neutral-500 font-mono">
                  Pulse ID {data.pulseId}
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
              <Card title="By map">
                {byMap.length === 0 ? (
                  <EmptyState sub="No maps yet" />
                ) : (
                  <div className="space-y-2">
                    {byMap.map((m) => (
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
              <Card title="By strategy">
                {byStrategy.length === 0 ? (
                  <EmptyState sub="No strategies tagged yet" />
                ) : (
                  <div className="space-y-2">
                    {byStrategy.map((s) => (
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
            </div>

            {/* DNA additions: build tendencies, predicted, timings, last 5. */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <Card title="Build tendencies (top 5 strategies)">
                <ErrorBoundary label="Build tendencies">
                  <StrategyTendencyChart
                    strategies={data.topStrategies || []}
                  />
                </ErrorBoundary>
              </Card>
              <Card title="Likely strategies next">
                <ErrorBoundary label="Likely strategies">
                  <PredictedStrategiesList
                    predictions={data.predictedStrategies || []}
                  />
                </ErrorBoundary>
              </Card>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <Card
                title={`Median key timings${data.matchupLabel ? " \u2014 " + data.matchupLabel : ""}`}
              >
                <ErrorBoundary label="Median timings">
                  <MedianTimingsGrid
                    timings={data.medianTimings}
                    order={data.medianTimingsOrder || []}
                    matchupLabel={data.matchupLabel || ""}
                    opponentName={data.name || data.pulseId || ""}
                    matchupCounts={data.matchupCounts || {}}
                    matchupTimings={data.matchupTimings || {}}
                    onOpenGame={handleOpenGame}
                  />
                </ErrorBoundary>
                <div className="text-[10px] text-neutral-600 mt-2">
                  Opponent-tech cards are sourced from{" "}
                  <code className="font-mono">opp_build_log</code> (sc2reader);
                  your-tech cards from your{" "}
                  <code className="font-mono">build_log</code>. Click a card to
                  see the contributing games. '-' means no samples in this
                  matchup.
                </div>
              </Card>
              <Card title="Last 5 games">
                <ErrorBoundary label="Last 5 games">
                  <Last5GamesTimeline games={data.last5Games || []} />
                </ErrorBoundary>
              </Card>
            </div>
            {/* Phase-2 spatial: proxy patterns this opponent has shown vs me. */}
            <Card title="Proxy patterns vs you">
              <ErrorBoundary label="Proxy patterns">
                <OpponentProxyPatterns opponentName={data.name || ""} />
              </ErrorBoundary>
            </Card>

            <Card
              title={`All games (${(data.games || []).length}) · newest first`}
            >
              <div className="overflow-x-auto -mx-2 max-h-[480px]">
                {/* Reuse the build-deep-dive games table so opponent games get
                the same row-click → build order + macro-click → breakdown
                affordances as everywhere else. We pre-normalise field
                casing (Date/date, Map/map, Result/result) so the shared
                table doesn't have to handle the Black-Book schema. */}
                <GamesTableWithBuildOrder
                  targetGameId={targetGameId}
                  targetGameSeq={targetSeq}
                  games={[...(data.games || [])]
                    .map((g) => ({
                      ...g,
                      date: g.date || g.Date,
                      map: g.map || g.Map,
                      result: g.result || g.Result,
                      opponent: g.opponent || data.name || "",
                      // Opponent race resolution -- prefer the meta-DB-enriched
                      // opp_race when present. Otherwise parse the Matchup key,
                      // which is shaped "<MY_RACE>v<OPP_RACE>" (e.g.
                      // "PROTOSSvTERRAN"). The previous version took
                      // charAt(0) of the whole string after stripping a "vs "
                      // prefix, so it returned the USER'S race ("P") instead of
                      // the opponent's ("T"). Now we explicitly take the part
                      // AFTER the "v" separator.
                      opp_race:
                        g.opp_race ||
                        (function () {
                          const mu = g.Matchup || "";
                          if (!mu) return "";
                          const stripped = String(mu).replace(/^vs\s*/i, "");
                          // Split on "v" / " v " / "vs" so both
                          // "PROTOSSvTERRAN" and "PROTOSS vs TERRAN"
                          // resolve to the trailing race.
                          const parts = stripped.split(/\s*v(?:s)?\s*/i);
                          const oppPart =
                            parts.length > 1
                              ? parts[parts.length - 1]
                              : parts[0];
                          return (oppPart || "").charAt(0).toUpperCase();
                        })() ||
                        "",
                      // game id is essential for the /games/:id/build-order
                      // and /games/:id/macro-breakdown endpoints. Enrichment
                      // now copies the meta-DB id; fall back to alt names.
                      id: g.id || g.game_id || g.GameId || g.gameId,
                    }))
                    .sort(
                      (a, b) =>
                        Date.parse(String(b.date || "").replace(" ", "T")) -
                        Date.parse(String(a.date || "").replace(" ", "T")),
                    )}
                  perspective="opponent"
                />
              </div>
            </Card>
          </div>
        );
      }

      function BackBtn({ onClick }) {
        return (
          <button
            onClick={onClick}
            className="text-xs uppercase tracking-wider text-neutral-400 hover:text-neutral-200"
          >
            ← back
          </button>
        );
      }

  // Expose to global so inline-block JSX in index.html can render
  // these as bare identifiers.
  Object.assign(window, {
    OpponentsTab,
    OpponentProfile,
    BackBtn
  });
})();
