/**
 * Map Intel — MapIntelTab + pickStatsAtTime + MapIntelResourceCell/Row/Bar — extracted from index.html.
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
      // (Removed) MAP INTEL TAB
      //
      // The standalone map-intel heatmaps view was removed at the user's
      // request - building/proxy/battle/death-zone heatmap rendering and the
      // viridis/RdYlGn_r colormaps lived here. The opponent-profile page's
      // "Proxy patterns vs you" widget (OpponentProxyPatterns below) still
      // hits /spatial/opponent-proxies, so that endpoint remains live; the
      // other /spatial/* endpoints can be retired in a future cleanup if no
      // other consumer adopts them.
      // ============================================================

      // ============================================================
      // MAP INTEL COMPONENTS
      // ============================================================

      function MapIntelTab({ dbRev, onOpenReplay }) {
        // Replay selection UI for the Map Intel / Replay Viewer.
        //
        // Behaviour:
        //   * Loads the full list of openable replays from /api/analyzer/games
        //     once per dbRev. No replay is auto-opened.
        //   * Search box filters the list as you type (opponent / map / build /
        //     opp_strategy).
        //   * Sort dropdown re-orders client-side.
        //   * Race chips filter by opponent race; result chips filter by W/L.
        //   * The list is rendered as cards with a "Watch" button on the right.
        //     The first 200 matches are shown; "Show more" reveals further
        //     matches in chunks of 200 to keep the DOM responsive.
        const [games, setGames] = useState(null);   // null = not yet loaded
        const [err, setErr] = useState(null);
        const [loading, setLoading] = useState(false);
        const [search, setSearch] = useState("");
        const [sort, setSort] = useState("date_desc");
        const [raceFilter, setRaceFilter] = useState("all");   // all | P | T | Z
        const [resultFilter, setResultFilter] = useState("all"); // all | win | loss
        const [visibleCount, setVisibleCount] = useState(200);
        const [selectedId, setSelectedId] = useState(null);

        useEffect(() => {
          let cancelled = false;
          setLoading(true);
          setErr(null);
          fetch(`${API}/games?limit=10000`)
            .then(r => r.json())
            .then(j => {
              if (cancelled) return;
              if (j && j.ok && Array.isArray(j.games)) {
                setGames(j.games);
              } else {
                setErr(j?.error || "Could not load replay list.");
              }
              setLoading(false);
            })
            .catch(e => {
              if (cancelled) return;
              setErr(String(e));
              setLoading(false);
            });
          return () => { cancelled = true; };
        }, [dbRev]);

        // Reset paging when the filter window changes so we don't sit at
        // page 5 of a list that just shrunk to 12 items.
        useEffect(() => { setVisibleCount(200); }, [search, sort, raceFilter, resultFilter]);

        const norm = (s) => String(s || "").toLowerCase();
        const isWin = (g) => norm(g.result) === "win" || norm(g.result) === "victory";
        const isLoss = (g) => norm(g.result) === "loss" || norm(g.result) === "defeat";

        const filtered = React.useMemo(() => {
          if (!games) return [];
          const q = search.trim().toLowerCase();
          let out = games.filter(g => {
            if (raceFilter !== "all") {
              const r = (g.opp_race || "").charAt(0).toUpperCase();
              if (r !== raceFilter) return false;
            }
            if (resultFilter === "win" && !isWin(g)) return false;
            if (resultFilter === "loss" && !isLoss(g)) return false;
            if (q) {
              const hay = `${g.opponent || ""} ${g.map || ""} ${g.build || ""} ${g.opp_strategy || ""}`.toLowerCase();
              if (!hay.includes(q)) return false;
            }
            return true;
          });
          const cmps = {
            date_desc:    (a, b) => new Date(b.date || 0) - new Date(a.date || 0),
            date_asc:     (a, b) => new Date(a.date || 0) - new Date(b.date || 0),
            opponent_asc: (a, b) => String(a.opponent || "").localeCompare(String(b.opponent || "")),
            opponent_desc:(a, b) => String(b.opponent || "").localeCompare(String(a.opponent || "")),
            map_asc:      (a, b) => String(a.map || "").localeCompare(String(b.map || "")),
            map_desc:     (a, b) => String(b.map || "").localeCompare(String(a.map || "")),
            length_desc:  (a, b) => (b.game_length || 0) - (a.game_length || 0),
            length_asc:   (a, b) => (a.game_length || 0) - (b.game_length || 0),
          };
          out = out.slice().sort(cmps[sort] || cmps.date_desc);
          return out;
        }, [games, search, sort, raceFilter, resultFilter]);

        const visible = filtered.slice(0, visibleCount);
        const remaining = Math.max(0, filtered.length - visibleCount);

        const fmtDate = (d) => {
          if (!d) return "Unknown";
          const dt = new Date(d);
          if (isNaN(dt.getTime())) return String(d).slice(0, 10);
          return dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
        };
        const fmtLen = (s) => {
          const n = Number(s);
          if (!Number.isFinite(n) || n <= 0) return "—";
          const m = Math.floor(n / 60);
          const sec = String(Math.floor(n % 60)).padStart(2, '0');
          return `${m}:${sec}`;
        };
        const raceColor = (r) => {
          const c = (r || "").charAt(0).toUpperCase();
          if (c === "P") return "text-blue-400";
          if (c === "T") return "text-red-400";
          if (c === "Z") return "text-purple-400";
          return "text-neutral-400";
        };
        const Chip = ({ active, onClick, children, title }) => (
          <button
            type="button"
            onClick={onClick}
            title={title}
            className={
              "px-2.5 py-1 rounded-full text-xs font-medium border transition-colors " +
              (active
                ? "bg-accent-600 border-accent-500 text-white"
                : "bg-base-800 border-base-700 text-neutral-300 hover:bg-base-700")
            }
          >{children}</button>
        );

        const totalCount = games ? games.length : 0;
        const matchCount = filtered.length;

        return (
          <div className="space-y-5">
            <div>
              <h2 className="text-xl font-semibold">Map Intel / Replay Viewer</h2>
              <div className="text-sm text-neutral-400 max-w-2xl mt-1">
                Watch interactive playback of any recent game directly from the browser.
                Features full timeline, building and unit placement using high-res icons,
                and post-game stats analysis.
              </div>
            </div>

            {/* How-to-use blurb */}
            <div className="bg-base-800/60 border border-base-700 rounded p-3 text-xs text-neutral-300 max-w-3xl">
              <span className="font-semibold text-neutral-100">How to use:&nbsp;</span>
              Search by opponent, map, build, or strategy. Use the sort and filter
              chips to narrow the list, then click <span className="text-accent-400 font-medium">Watch</span>
              &nbsp;on any row to load that replay in the playback viewer.
            </div>

            {/* Controls row */}
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex-1 min-w-[220px] max-w-md relative">
                <input
                  type="text"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search opponent, map, build, strategy..."
                  className="w-full bg-base-800 border border-base-700 rounded pl-8 pr-3 py-2 text-sm text-neutral-100 placeholder-neutral-500 focus:outline-none focus:border-accent-500"
                />
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500 text-sm">&#x1F50D;</span>
                {search && (
                  <button
                    onClick={() => setSearch("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-200 text-xs"
                    title="Clear search"
                  >&#x2715;</button>
                )}
              </div>

              <div className="flex items-center gap-2">
                <label className="text-xs text-neutral-400">Sort</label>
                <select
                  value={sort}
                  onChange={e => setSort(e.target.value)}
                  className="bg-base-800 border border-base-700 rounded px-2 py-1.5 text-sm text-neutral-100 focus:outline-none focus:border-accent-500"
                >
                  <option value="date_desc">Newest first</option>
                  <option value="date_asc">Oldest first</option>
                  <option value="opponent_asc">Opponent A - Z</option>
                  <option value="opponent_desc">Opponent Z - A</option>
                  <option value="map_asc">Map A - Z</option>
                  <option value="map_desc">Map Z - A</option>
                  <option value="length_desc">Longest first</option>
                  <option value="length_asc">Shortest first</option>
                </select>
              </div>

              <div className="flex items-center gap-1.5">
                <span className="text-xs text-neutral-400 mr-1">Race</span>
                <Chip active={raceFilter === "all"} onClick={() => setRaceFilter("all")}>All</Chip>
                <Chip active={raceFilter === "P"} onClick={() => setRaceFilter("P")} title="Protoss">P</Chip>
                <Chip active={raceFilter === "T"} onClick={() => setRaceFilter("T")} title="Terran">T</Chip>
                <Chip active={raceFilter === "Z"} onClick={() => setRaceFilter("Z")} title="Zerg">Z</Chip>
              </div>

              <div className="flex items-center gap-1.5">
                <span className="text-xs text-neutral-400 mr-1">Result</span>
                <Chip active={resultFilter === "all"} onClick={() => setResultFilter("all")}>All</Chip>
                <Chip active={resultFilter === "win"} onClick={() => setResultFilter("win")}>Wins</Chip>
                <Chip active={resultFilter === "loss"} onClick={() => setResultFilter("loss")}>Losses</Chip>
              </div>
            </div>

            {/* Status row */}
            <div className="text-xs text-neutral-500">
              {loading && <span className="animate-pulse">Loading replays...</span>}
              {!loading && games && (
                <span>
                  Showing <span className="text-neutral-300">{Math.min(visible.length, matchCount)}</span> of{" "}
                  <span className="text-neutral-300">{matchCount.toLocaleString()}</span>{" "}
                  {matchCount !== totalCount && (<>(filtered from <span className="text-neutral-300">{totalCount.toLocaleString()}</span>) </>)}
                  replays
                </span>
              )}
            </div>

            {err && (
              <div className="bg-loss-500/10 border border-loss-500/40 text-loss-400 rounded px-3 py-2 text-sm">
                {err}
              </div>
            )}

            {/* Replay list */}
            {!loading && games && (
              <div className="bg-base-800 rounded border border-base-700 overflow-hidden">
                {visible.length === 0 ? (
                  <div className="py-10 text-center text-neutral-500 text-sm">
                    {totalCount === 0
                      ? "No replays found in your library yet. Play a game and the parser will pick it up."
                      : "No replays match the current filters."}
                  </div>
                ) : (
                  <ul className="divide-y divide-base-700/60">
                    {visible.map((g, i) => {
                      const win = isWin(g);
                      const isSel = selectedId === (g.id || `${g.file_path}|${i}`);
                      const rowKey = g.id || `${g.file_path}|${i}`;
                      return (
                        <li
                          key={rowKey}
                          className={
                            "flex items-center gap-3 px-4 py-2.5 hover:bg-base-700/40 transition-colors " +
                            (isSel ? "bg-base-700/60" : "")
                          }
                          onClick={() => setSelectedId(rowKey)}
                        >
                          <div className="w-24 shrink-0 text-xs text-neutral-400 whitespace-nowrap">
                            {fmtDate(g.date)}
                          </div>
                          <div className="w-48 shrink-0 truncate text-sm text-gold-400" title={g.map}>
                            {g.map || "Unknown map"}
                          </div>
                          <div className="flex-1 min-w-0 truncate text-sm font-medium text-neutral-100" title={g.opponent}>
                            {g.opponent || "Unknown"}
                            {g.opp_race && (
                              <span className={"ml-2 text-xs " + raceColor(g.opp_race)}>
                                ({(g.opp_race || "").charAt(0).toUpperCase()})
                              </span>
                            )}
                          </div>
                          <div className="hidden md:block w-40 shrink-0 truncate text-xs text-neutral-500" title={g.build}>
                            {g.build || ""}
                          </div>
                          <div className="w-12 shrink-0 text-xs text-neutral-400 text-right tabular-nums">
                            {fmtLen(g.game_length)}
                          </div>
                          <div className="w-16 shrink-0 text-right">
                            <span className={
                              "text-xs font-semibold " +
                              (win ? "text-win-500" : isLoss(g) ? "text-loss-500" : "text-neutral-500")
                            }>
                              {win ? "Win" : isLoss(g) ? "Loss" : (g.result || "—")}
                            </span>
                          </div>
                          <div className="w-20 shrink-0 text-right">
                            <button
                              className="bg-accent-600 hover:bg-accent-500 text-white px-3 py-1 rounded text-xs transition-colors shadow-sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                onOpenReplay({ path: g.file_path, player: g.me_name || "" });
                              }}
                            >
                              Watch
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {remaining > 0 && (
                  <div className="border-t border-base-700 bg-base-900/40 px-4 py-2 flex items-center justify-between">
                    <span className="text-xs text-neutral-500">
                      {remaining.toLocaleString()} more match{remaining === 1 ? "" : "es"} hidden
                    </span>
                    <button
                      onClick={() => setVisibleCount(c => c + 200)}
                      className="text-xs text-accent-400 hover:text-accent-300 font-medium"
                    >
                      Show more &#8595;
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      }

      function pickStatsAtTime(stats, t) {
        if (!Array.isArray(stats) || stats.length === 0) return null;
        let lo = 0, hi = stats.length - 1, idx = 0;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (stats[mid].time <= t) { idx = mid; lo = mid + 1; }
          else { hi = mid - 1; }
        }
        return stats[idx];
      }

      function MapIntelResourceCell({ label, value, color }) {
        return (
          <div style={{
            display: "flex", flexDirection: "column",
            minWidth: "62px", padding: "2px 6px",
          }}>
            <span style={{
              fontSize: "10px", textTransform: "uppercase",
              letterSpacing: "0.05em", color: "#94a3b8",
            }}>{label}</span>
            <span style={{
              fontFamily: "var(--font-family-mono)",
              fontSize: "13px", color: color || "#e6e9ef",
              fontWeight: 600,
            }}>{value}</span>
          </div>
        );
      }

      function MapIntelResourceRow({ name, stats, accent }) {
        const fmt = (n) => (typeof n === "number") ? n.toLocaleString("en-US") : "—";
        const s = stats || {};
        return (
          <div style={{
            display: "flex", alignItems: "center", gap: "8px",
            padding: "4px 8px", background: "rgba(20,24,32,0.85)",
            borderRadius: "6px",
          }}>
            <div style={{
              minWidth: "100px", maxWidth: "140px",
              color: accent, fontWeight: 700,
              overflow: "hidden", textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}>{name}</div>
            <MapIntelResourceCell label="Min"     value={fmt(s.minerals)}  color="#7dd3fc" />
            <MapIntelResourceCell label="Gas"     value={fmt(s.vespene)}   color="#86efac" />
            <MapIntelResourceCell label="Supply"
              value={(s.food_used != null && s.food_made != null)
                ? `${s.food_used}/${s.food_made}` : "—"} />
            <MapIntelResourceCell label="Workers" value={fmt(s.workers)} />
            <MapIntelResourceCell label="Army"
              value={s.army_val != null ? Math.round(s.army_val) : "—"} />
            <MapIntelResourceCell label="Lost"
              value={fmt(s.lost)} color="#FCA5A5" />
            <MapIntelResourceCell label="Killed"
              value={fmt(s.killed)} color="#FDE68A" />
          </div>
        );
      }

      function MapIntelResourceBar({ data, time }) {
        if (!data) return null;
        const me = pickStatsAtTime(data.my_stats, time) || {};
        const opp = pickStatsAtTime(data.opp_stats, time) || {};
        const meName = data.me_name || "You";
        const oppName = data.opp_name || "Opponent";
        return (
          <div style={{
            display: "flex", justifyContent: "center", alignItems: "stretch",
            gap: "12px", padding: "8px 16px",
            background: "rgba(11,13,17,0.95)",
            borderBottom: "1px solid rgba(255,255,255,0.06)",
            flexShrink: 0,
          }}>
            <MapIntelResourceRow name={meName}  stats={me}  accent="#66BB6A" />
            <MapIntelResourceRow name={oppName} stats={opp} accent="#EF5350" />
          </div>
        );
      }

  // Expose to global so inline-block JSX in index.html can render
  // these as bare identifiers.
  Object.assign(window, {
    MapIntelTab,
    pickStatsAtTime,
    MapIntelResourceCell,
    MapIntelResourceRow,
    MapIntelResourceBar
  });
})();
