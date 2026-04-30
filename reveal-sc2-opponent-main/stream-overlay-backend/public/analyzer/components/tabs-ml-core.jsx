/**
 * ML / Predict tab core — MlTab + MacroBackfillCard + MlStatusCard — extracted from index.html.
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
      // ML / Predict tab
      //
      // Three panels:
      //   1. Status + train (live progress over Socket.io 'ml_train_progress'
      //      and 'ml_train_complete' events).
      //   2. What-if mid-game predictor (slider-driven; debounced fetch
      //      to /api/analyzer/ml/predict).
      //   3. Pre-game predictor (history-based; calls /ml/pregame, with
      //      a per-component breakdown).
      //
      // The Python ML CLI behind these endpoints is spawned per request by
      // analyzer.js; training is the long-running case and runs detached.
      // ============================================================
      function MlTab({ dbRev }) {
        const [status, setStatus] = useState(null);
        const [statusErr, setStatusErr] = useState("");
        const [opts, setOpts] = useState({
          races: [],
          opponents: [],
          maps: [],
          strategies: [],
        });
        const [training, setTraining] = useState(false);
        const [progress, setProgress] = useState({ done: 0, total: 0, pct: 0 });
        const [trainMsg, setTrainMsg] = useState("");

        const refreshStatus = async () => {
          try {
            const r = await fetch(`${API}/ml/status`);
            const j = await r.json();
            setStatus(j);
            setStatusErr("");
            if (j && j.live && j.live.running) {
              setTraining(true);
              setProgress({
                done: j.live.done | 0,
                total: j.live.total | 0,
                pct: j.live.total
                  ? Math.round((100 * j.live.done) / j.live.total)
                  : 0,
              });
              setTrainMsg(j.live.lastMessage || "");
            }
          } catch (e) {
            setStatusErr(e.message);
          }
        };

        const refreshOptions = async () => {
          try {
            const r = await fetch(`${API}/ml/options`);
            const j = await r.json();
            setOpts(
              j || { races: [], opponents: [], maps: [], strategies: [] },
            );
          } catch (_) {
            /* keep defaults */
          }
        };

        useEffect(() => {
          refreshStatus();
          refreshOptions();
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [dbRev]);

        // Subscribe to live training events.
        useEffect(() => {
          let sock;
          try {
            sock = io({ transports: ["websocket", "polling"] });
            sock.on("ml_train_progress", (p) => {
              setTraining(true);
              setProgress({
                done: p.done | 0,
                total: p.total | 0,
                pct: p.pct | 0,
              });
              setTrainMsg(`Parsing replay ${p.done}/${p.total} (${p.pct}%)`);
            });
            sock.on("ml_train_complete", (p) => {
              setTraining(false);
              setTrainMsg(
                p.message ||
                  (p.code === 0 ? "Training complete." : "Training failed."),
              );
              refreshStatus();
            });
          } catch (_) {}
          return () => {
            try {
              sock && sock.disconnect();
            } catch (_) {}
          };
        }, []);

        const startTraining = async () => {
          if (training) return;
          if (
            !confirm(
              "Train the WP model? This re-parses every replay (1-5 minutes typically).",
            )
          )
            return;
          setTraining(true);
          setTrainMsg("Starting...");
          setProgress({ done: 0, total: 0, pct: 0 });
          try {
            const r = await fetch(`${API}/ml/train`, { method: "POST" });
            const j = await r.json();
            if (!r.ok || !j.ok) {
              setTraining(false);
              setTrainMsg(j.message || "Training rejected.");
            }
          } catch (e) {
            setTraining(false);
            setTrainMsg("Failed: " + e.message);
          }
        };

        return (
          <div className="space-y-4">
            <MlStatusCard
              status={status}
              statusErr={statusErr}
              training={training}
              progress={progress}
              trainMsg={trainMsg}
              onTrain={startTraining}
              onRefresh={refreshStatus}
            />
            <MacroBackfillCard />
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <WhatIfPanel status={status} />
              <PregamePanel opts={opts} />
            </div>
          </div>
        );
      }

      // Card that triggers a bulk macro recompute on the server. Mirrors the
      // "Backfill Macro Scores" button from the desktop SC2ReplayAnalyzer.py
      // sidebar. Subscribes to Socket.io 'macro_backfill_progress' /
      // 'macro_backfill_done' events for live status.
      function MacroBackfillCard() {
        const [state, setState] = useState({
          running: false,
          phase: "idle",
          done: 0,
          total: 0,
          updated: 0,
          errors: 0,
          lastMessage: "",
        });
        const [error, setError] = useState("");
        // When checked, the backend re-parses every reachable replay even if
        // its macro_score/breakdown are already stored. Use after the macro
        // engine itself changes (e.g. fixed chrono/inject/MULE counting) so
        // existing stored breakdowns get refreshed with the new logic.
        const [force, setForce] = useState(false);

        const refresh = async () => {
          try {
            const r = await fetch(`${API}/macro/backfill/status`);
            const j = await r.json();
            if (j && j.ok) setState((s) => Object.assign({}, s, j));
          } catch (_) {
            /* ignore */
          }
        };

        useEffect(() => {
          refresh();
        }, []);
        useEffect(() => {
          let sock;
          try {
            sock = io({ transports: ["websocket", "polling"] });
            sock.on("macro_backfill_progress", (p) => {
              setState((s) =>
                Object.assign({}, s, {
                  running: true,
                  phase: "running",
                  done: p.i || s.done,
                  total: p.total || s.total,
                  updated: s.updated + (p.ok ? 1 : 0),
                  errors: s.errors + (p.ok ? 0 : 1),
                  lastMessage: `${p.i || 0}/${p.total || 0} ${p.file || ""}`,
                }),
              );
            });
            sock.on("macro_backfill_done", (d) => {
              setState((s) =>
                Object.assign({}, s, {
                  running: false,
                  phase: d.phase || "done",
                  lastMessage: `done · updated ${d.updated || 0} · errors ${d.errors || 0}`,
                }),
              );
            });
          } catch (_) {
            /* socket optional */
          }
          return () => {
            try {
              sock && sock.disconnect();
            } catch (_) {}
          };
        }, []);

        const start = async () => {
          setError("");
          try {
            const r = await fetch(`${API}/macro/backfill/start`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ force }),
            });
            const j = await r.json();
            if (!r.ok || !j.ok) {
              setError(j.error || "failed to start");
              return;
            }
            setState((s) =>
              Object.assign({}, s, {
                running: true,
                phase: "running",
                done: 0,
                total: 0,
                updated: 0,
                errors: 0,
                lastMessage: force ? "starting (force re-parse)…" : "starting…",
              }),
            );
          } catch (e) {
            setError(e.message);
          }
        };

        const pct =
          state.total > 0 ? Math.round((100 * state.done) / state.total) : 0;

        return (
          <div className="bg-base-800 ring-soft rounded-xl p-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <h2 className="text-lg font-semibold text-neutral-100">
                  Macro score backfill
                </h2>
                <div className="text-sm text-neutral-400 mt-1">
                  {force ? (
                    <>
                      <span className="text-gold-500 font-semibold">
                        Force mode:
                      </span>{" "}
                      re-parses <em>every</em> reachable replay and overwrites
                      existing macro scores. Use this after the macro engine
                      itself changes (e.g. chrono/inject/MULE fix). Slow.
                    </>
                  ) : (
                    <>
                      Default: only processes replays that don't yet have a
                      macro score. Cheap; runs after every batch of new games.
                      Writes results back to{" "}
                      <code className="text-neutral-300">
                        meta_database.json
                      </code>
                      .
                    </>
                  )}
                </div>
                {error && (
                  <div className="text-sm text-loss-500 mt-1">{error}</div>
                )}
              </div>
              <div className="flex gap-2 items-center">
                <button
                  onClick={refresh}
                  className="text-xs bg-base-700 hover:bg-base-600 ring-soft rounded px-3 py-1.5 text-neutral-300"
                >
                  Refresh
                </button>
                <button
                  onClick={start}
                  disabled={state.running}
                  className="text-sm bg-accent-500 hover:bg-accent-600 disabled:opacity-50 ring-soft rounded px-3 py-1.5 text-white font-semibold"
                >
                  {state.running
                    ? "Running…"
                    : force
                      ? "Force re-parse all"
                      : "Backfill new replays"}
                </button>
              </div>
            </div>

            <div className="mt-2">
              <label
                className="inline-flex items-center gap-2 text-xs text-neutral-500 cursor-pointer select-none"
                title="Edge case: re-parse every reachable replay even if its macro is already stored. Only needed after the macro engine itself changes so old stored breakdowns get refreshed. Leave OFF for the normal incremental backfill."
              >
                <input
                  type="checkbox"
                  checked={force}
                  onChange={(e) => setForce(e.target.checked)}
                  disabled={state.running}
                  className="accent-accent-500"
                />
                Force re-parse all{" "}
                <span className="text-neutral-600">(edge case)</span>
              </label>
            </div>

            {(state.running || state.total > 0) && (
              <div className="mt-3">
                <div className="flex items-center gap-3 text-xs text-neutral-400 mb-1">
                  <span>
                    {state.done}/{state.total} processed
                  </span>
                  <span className="text-win-500">+{state.updated} updated</span>
                  {state.errors > 0 && (
                    <span className="text-loss-500">{state.errors} errors</span>
                  )}
                  <span className="ml-auto truncate">{state.lastMessage}</span>
                </div>
                <div className="h-2 bg-base-700 rounded overflow-hidden">
                  <div
                    className="h-full bg-accent-500"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        );
      }

      function MlStatusCard({
        status,
        statusErr,
        training,
        progress,
        trainMsg,
        onTrain,
        onRefresh,
      }) {
        const trained = status && status.trained;
        const auc =
          trained && status.auc != null ? status.auc.toFixed(3) : "n/a";
        const last = trained ? status.last_trained || "?" : "";
        const need = status && status.needed > 0;
        return (
          <div className="bg-base-800 ring-soft rounded-xl p-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <h2 className="text-lg font-semibold text-neutral-100">
                  Win-Probability model
                </h2>
                {statusErr ? (
                  <div className="text-sm text-loss-500 mt-1">{statusErr}</div>
                ) : !status ? (
                  <div className="text-sm text-neutral-500 mt-1">
                    Loading status...
                  </div>
                ) : trained ? (
                  <div className="text-sm text-neutral-300 mt-1">
                    <span className="text-win-500 font-semibold">Trained</span>
                    {" · "}
                    <span className="tabular-nums">
                      {status.games_used}
                    </span>{" "}
                    games
                    {" · "}
                    <span className="tabular-nums">
                      {status.snapshots}
                    </span>{" "}
                    snapshots
                    {" · AUC "}
                    <b className="tabular-nums">{auc}</b>
                    {" · last trained "}
                    <span className="text-neutral-400">{last}</span>
                  </div>
                ) : (
                  <div className="text-sm text-neutral-300 mt-1">
                    <span className="text-loss-500 font-semibold">
                      Untrained
                    </span>
                    {" · "}
                    {status.message || ""}
                  </div>
                )}
              </div>
              <div className="flex gap-2 items-center">
                <button
                  onClick={onRefresh}
                  className="text-xs bg-base-700 hover:bg-base-600 ring-soft rounded px-3 py-1.5 text-neutral-300"
                >
                  Refresh
                </button>
                <button
                  onClick={onTrain}
                  disabled={training || need}
                  className={
                    "text-sm rounded px-4 py-1.5 transition " +
                    (training || need
                      ? "bg-base-700 text-neutral-500 cursor-not-allowed"
                      : "bg-accent-500 hover:bg-accent-500/90 text-white")
                  }
                >
                  {training
                    ? "Training..."
                    : trained
                      ? "Retrain Model"
                      : "Train Model"}
                </button>
              </div>
            </div>
            {(training || trainMsg) && (
              <div className="mt-3">
                <div className="h-2 bg-base-700 rounded overflow-hidden">
                  <div
                    className="h-full bg-accent-500 transition-all"
                    style={{ width: (progress.pct || 0) + "%" }}
                  />
                </div>
                <div className="text-xs text-neutral-400 mt-1.5">
                  {trainMsg}
                </div>
              </div>
            )}
            <div className="text-[11px] text-neutral-500 mt-2">
              Training spawns the Python ML CLI (<code>scripts/ml_cli.py</code>)
              in the SC2Replay-Analyzer project; live progress streams over
              Socket.io.
            </div>
          </div>
        );
      }

  // Expose to global so inline-block JSX in index.html can render
  // these as bare identifiers.
  Object.assign(window, {
    MlTab,
    MacroBackfillCard,
    MlStatusCard
  });
})();
