/**
 * ML Predict — WhatIfPanel + PregamePanel + CsvButton — extracted from index.html.
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

      // -- What-if predictor (mid-game snapshot)
      function WhatIfPanel({ status }) {
        const FEATS = [
          {
            key: "minute",
            label: "Game minute",
            min: 0,
            max: 30,
            step: 1,
            def: 8,
          },
          {
            key: "supply_diff",
            label: "Supply diff (you-opp)",
            min: -100,
            max: 100,
            step: 1,
            def: 0,
          },
          {
            key: "army_value_diff",
            label: "Army value diff",
            min: -5000,
            max: 5000,
            step: 50,
            def: 0,
          },
          {
            key: "income_min_diff",
            label: "Mineral income diff /min",
            min: -3000,
            max: 3000,
            step: 25,
            def: 0,
          },
          {
            key: "income_gas_diff",
            label: "Gas income diff /min",
            min: -2000,
            max: 2000,
            step: 25,
            def: 0,
          },
          {
            key: "nexus_count_diff",
            label: "Base count diff",
            min: -5,
            max: 5,
            step: 1,
            def: 0,
          },
          {
            key: "tech_score_self",
            label: "Your tech score",
            min: 0,
            max: 30,
            step: 1,
            def: 5,
          },
          {
            key: "tech_score_opp",
            label: "Opp tech score",
            min: 0,
            max: 30,
            step: 1,
            def: 5,
          },
        ];
        const initial = Object.fromEntries(FEATS.map((f) => [f.key, f.def]));
        const [vals, setVals] = useState(initial);
        const [matchup, setMatchup] = useState("");
        const [pred, setPred] = useState(null);
        const [predErr, setPredErr] = useState("");
        const trained = status && status.trained;
        const fetchPred = useRef(null);

        useEffect(() => {
          if (!trained) {
            setPred(null);
            setPredErr("");
            return;
          }
          if (fetchPred.current) clearTimeout(fetchPred.current);
          fetchPred.current = setTimeout(async () => {
            const q = new URLSearchParams();
            Object.entries(vals).forEach(([k, v]) => q.set(k, v));
            if (matchup) q.set("matchup", matchup);
            try {
              const r = await fetch(`${API}/ml/predict?${q.toString()}`);
              const j = await r.json();
              if (!j.ok) {
                setPred(null);
                setPredErr(j.message || "");
              } else {
                setPred(j.p_win);
                setPredErr("");
              }
            } catch (e) {
              setPredErr(e.message);
            }
          }, 200);
          return () => {
            if (fetchPred.current) clearTimeout(fetchPred.current);
          };
        }, [vals, matchup, trained]);

        const pct = pred != null ? pred * 100 : null;
        return (
          <div className="bg-base-800 ring-soft rounded-xl p-4">
            <h3 className="text-base font-semibold text-neutral-100">
              What-if predictor (mid-game)
            </h3>
            <p className="text-xs text-neutral-500 mt-0.5">
              Set the relative state; the model returns p(Win) for that
              snapshot.
            </p>
            {!trained ? (
              <EmptyState
                title="Train the model first"
                sub="The what-if predictor needs a fitted WP model."
              />
            ) : (
              <Fragment>
                <div className="grid grid-cols-2 gap-3 mt-3">
                  {FEATS.map((f) => (
                    <div key={f.key}>
                      <label className="block text-[11px] text-neutral-400">
                        {f.label}
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          type="range"
                          min={f.min}
                          max={f.max}
                          step={f.step}
                          value={vals[f.key]}
                          onChange={(e) =>
                            setVals((v) => ({
                              ...v,
                              [f.key]: Number(e.target.value),
                            }))
                          }
                          className="flex-1"
                        />
                        <span className="tabular-nums w-14 text-right text-xs text-neutral-300">
                          {vals[f.key]}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-3">
                  <label className="block text-[11px] text-neutral-400">
                    Matchup (optional)
                  </label>
                  <select
                    value={matchup}
                    onChange={(e) => setMatchup(e.target.value)}
                    className="bg-base-700 ring-soft rounded px-2 py-1 text-sm"
                  >
                    <option value="">(unspecified)</option>
                    <option value="PvT">PvT</option>
                    <option value="PvZ">PvZ</option>
                    <option value="PvP">PvP</option>
                  </select>
                </div>
                <div className="mt-4 bg-base-700 rounded-lg p-3 text-center">
                  <div className="text-[11px] uppercase tracking-wider text-neutral-500">
                    Predicted p(Win)
                  </div>
                  <div
                    className="text-3xl font-semibold tabular-nums mt-1"
                    style={{
                      color:
                        pct == null
                          ? "#9ca3af"
                          : pct >= 50
                            ? "#66BB6A"
                            : "#EF5350",
                    }}
                  >
                    {pct == null ? "—" : pct.toFixed(0) + "%"}
                  </div>
                  <div className="h-2 bg-base-800 rounded mt-2 overflow-hidden">
                    <div
                      className="h-full transition-all"
                      style={{
                        width:
                          pct == null
                            ? "0%"
                            : Math.max(0, Math.min(100, pct)) + "%",
                        background:
                          pct == null
                            ? "#404040"
                            : pct >= 50
                              ? "#66BB6A"
                              : "#EF5350",
                      }}
                    />
                  </div>
                  {predErr && (
                    <div className="text-xs text-loss-500 mt-2">{predErr}</div>
                  )}
                </div>
              </Fragment>
            )}
          </div>
        );
      }

      // -- Pre-game predictor (history-based)
      function PregamePanel({ opts }) {
        const [filters, setFilters] = useState({});
        const [result, setResult] = useState(null);
        const [err, setErr] = useState("");
        const set = (k, v) => setFilters((f) => ({ ...f, [k]: v }));

        const run = async () => {
          const q = new URLSearchParams();
          Object.entries(filters).forEach(([k, v]) => {
            if (v) q.set(k, v);
          });
          try {
            const r = await fetch(`${API}/ml/pregame?${q.toString()}`);
            const j = await r.json();
            if (!j.ok) {
              setResult(null);
              setErr(j.message || "No data.");
            } else {
              setResult(j);
              setErr("");
            }
          } catch (e) {
            setErr(e.message);
          }
        };

        const pct = result && result.p_win != null ? result.p_win * 100 : null;
        return (
          <div className="bg-base-800 ring-soft rounded-xl p-4">
            <h3 className="text-base font-semibold text-neutral-100">
              Pre-game predictor (history-based)
            </h3>
            <p className="text-xs text-neutral-500 mt-0.5">
              Historical win-rate against this matchup / opponent / map /
              strategy.
            </p>
            <div className="grid grid-cols-2 gap-3 mt-3">
              <div>
                <label className="block text-[11px] text-neutral-400">
                  Your race
                </label>
                <select
                  value={filters.myrace || ""}
                  onChange={(e) => set("myrace", e.target.value)}
                  className="bg-base-700 ring-soft rounded px-2 py-1 text-sm w-full"
                >
                  <option value="">(any)</option>
                  {(opts.races || []).map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-neutral-400">
                  Opp race
                </label>
                <select
                  value={filters.opprace || ""}
                  onChange={(e) => set("opprace", e.target.value)}
                  className="bg-base-700 ring-soft rounded px-2 py-1 text-sm w-full"
                >
                  <option value="">(any)</option>
                  {(opts.races || []).map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-neutral-400">
                  Opponent
                </label>
                <select
                  value={filters.opponent || ""}
                  onChange={(e) => set("opponent", e.target.value)}
                  className="bg-base-700 ring-soft rounded px-2 py-1 text-sm w-full"
                >
                  <option value="">(any)</option>
                  {(opts.opponents || []).slice(0, 500).map((o) => (
                    <option key={o} value={o}>
                      {o.length > 40 ? o.slice(0, 40) + "..." : o}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-neutral-400">
                  Map
                </label>
                <select
                  value={filters.map || ""}
                  onChange={(e) => set("map", e.target.value)}
                  className="bg-base-700 ring-soft rounded px-2 py-1 text-sm w-full"
                >
                  <option value="">(any)</option>
                  {(opts.maps || []).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-span-2">
                <label className="block text-[11px] text-neutral-400">
                  Opp strategy
                </label>
                <select
                  value={filters.strategy || ""}
                  onChange={(e) => set("strategy", e.target.value)}
                  className="bg-base-700 ring-soft rounded px-2 py-1 text-sm w-full"
                >
                  <option value="">(any)</option>
                  {(opts.strategies || []).map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <button
              onClick={run}
              className="mt-3 text-sm bg-accent-500 hover:bg-accent-500/90 text-white rounded px-4 py-1.5"
            >
              Predict
            </button>
            <div className="mt-4 bg-base-700 rounded-lg p-3">
              <div className="text-[11px] uppercase tracking-wider text-neutral-500 text-center">
                Predicted p(Win)
              </div>
              <div
                className="text-3xl font-semibold tabular-nums mt-1 text-center"
                style={{
                  color:
                    pct == null ? "#9ca3af" : pct >= 50 ? "#66BB6A" : "#EF5350",
                }}
              >
                {pct == null ? "—" : pct.toFixed(0) + "%"}
              </div>
              <div className="h-2 bg-base-800 rounded mt-2 overflow-hidden">
                <div
                  className="h-full transition-all"
                  style={{
                    width:
                      pct == null
                        ? "0%"
                        : Math.max(0, Math.min(100, pct)) + "%",
                    background:
                      pct == null
                        ? "#404040"
                        : pct >= 50
                          ? "#66BB6A"
                          : "#EF5350",
                  }}
                />
              </div>
              {result && (
                <div className="text-xs text-neutral-400 mt-3">
                  {result.total > 0 ? (
                    <Fragment>
                      Joint match:{" "}
                      <b>
                        {result.wins}-{result.total - result.wins}
                      </b>
                      {" (" +
                        (result.raw_win_rate * 100).toFixed(0) +
                        "% raw, smoothed to " +
                        (result.p_win * 100).toFixed(0) +
                        "%)"}
                    </Fragment>
                  ) : (
                    <Fragment>{result.method}</Fragment>
                  )}
                  {result.components && result.components.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {result.components.map((c, i) => (
                        <li key={i} className="flex justify-between gap-3">
                          <span>{c.label}</span>
                          <span className="tabular-nums">
                            <b>
                              {c.wins}-{c.total - c.wins}
                            </b>
                            {" · "}
                            <span
                              style={{
                                color:
                                  c.win_rate >= 0.5 ? "#66BB6A" : "#EF5350",
                              }}
                            >
                              {(c.win_rate * 100).toFixed(0)}%
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {err && <div className="text-xs text-loss-500 mt-2">{err}</div>}
            </div>
          </div>
        );
      }

      function CsvButton({ kind, filters }) {
        const href = `${API}/export.csv?kind=${kind}${buildQuery(filters).replace("?", "&")}`;
        return (
          <a
            href={href}
            target="_blank"
            rel="noopener"
            className="text-xs bg-base-700 hover:bg-base-600 ring-soft rounded px-3 py-1.5 text-neutral-300"
          >
            &#x2913; Export CSV
          </a>
        );
      }

  // Expose to global so inline-block JSX in index.html can render
  // these as bare identifiers.
  Object.assign(window, {
    WhatIfPanel,
    PregamePanel,
    CsvButton
  });
})();
