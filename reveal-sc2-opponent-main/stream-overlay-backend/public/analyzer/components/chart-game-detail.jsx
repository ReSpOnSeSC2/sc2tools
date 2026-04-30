/**
 * GameDetailModal + GamesTableWithBuildOrder — extracted from index.html.
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



      // =====================================================================
      // GameDetailModal — full-screen view triggered by clicking a game's
      // macro score in GamesTableWithBuildOrder.
      //
      // Hosts the macro breakdown panel + activity (APM/SPM) charts + the
      // resources-over-time chart side-by-side, all sharing the same gameId.
      // The modal is a fixed-position overlay (z-50) with a dim backdrop;
      // ESC and a backdrop click both close it.
      // =====================================================================
      function _gameModalTitle(game) {
        if (!game) return "Game detail";
        const date = fmtDate(game.date);
        const opp = game.opponent || "—";
        const map = game.map || "—";
        const result = game.result || "";
        return `${date} · vs ${opp} · ${map}${result ? ` · ${result}` : ""}`;
      }

      function GameDetailModal({ game, gameId, macroValue, onClose, onScoreChange }) {
        // ESC-to-close. We bind once at mount and explicitly let the
        // dependency list drive re-bind so a new game id doesn't leak the
        // previous handler.
        useEffect(() => {
          const onKey = (e) => {
            if (e.key === "Escape") onClose();
          };
          window.addEventListener("keydown", onKey);
          return () => window.removeEventListener("keydown", onKey);
        }, [onClose]);
        const stop = (e) => e.stopPropagation();
        const myRace = game && (game.my_race || "");
        const oppRace = game && (game.opp_race || "");
        return (
          <div
            className="fixed inset-0 z-50 bg-black/70 flex items-stretch justify-center p-4 sm:p-8 overflow-y-auto"
            onClick={onClose}
            role="dialog"
            aria-modal="true"
            aria-label="Game detail"
          >
            <div
              className="bg-base-800 border border-base-700 rounded-lg shadow-xl w-full max-w-6xl my-auto"
              onClick={stop}
            >
              <div className="flex items-center justify-between px-4 py-3 border-b border-base-700 sticky top-0 bg-base-800 rounded-t-lg z-10">
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] uppercase tracking-wide text-neutral-500">
                    Game detail
                  </div>
                  <div className="text-sm text-neutral-200 truncate">
                    {_gameModalTitle(game)}
                  </div>
                </div>
                <button
                  onClick={onClose}
                  className="ml-3 px-3 py-1 text-xs rounded bg-base-700 hover:bg-base-600 text-neutral-200"
                  aria-label="Close game detail"
                >
                  Close ✕
                </button>
              </div>
              <div className="p-4 space-y-5">
                <section>
                  <div className="text-[11px] uppercase tracking-wide text-neutral-400 mb-2">
                    Macro breakdown
                  </div>
                  <MacroBreakdownPanel
                    gameId={gameId}
                    initialMacro={macroValue}
                    onScoreChange={onScoreChange}
                  />
                </section>
                <section>
                  <div className="text-[11px] uppercase tracking-wide text-neutral-400 mb-2">
                    Activity (APM / SPM)
                  </div>
                  <ActivityOverTimeChart
                    gameId={gameId}
                    myRaceHint={myRace}
                    oppRaceHint={oppRace}
                  />
                </section>
                <section>
                  <ResourcesOverTimeChart gameId={gameId} />
                </section>
              </div>
            </div>
          </div>
        );
      }

      function GamesTableWithBuildOrder({
        games,
        perspective,
        targetGameId,
        targetGameSeq,
      }) {
        // expandedId tracks which row's drawer is open; expandedMode controls
        // whether the drawer shows the build-order timeline ('build') or the
        // macro breakdown ('macro'). Both come from clicks on the same row.
        // `perspective` is forwarded to BuildOrderTimeline so the OpponentProfile
        // can default the drawer to the opponent's build (callers that don't
        // pass it get the user's build, the historical default).
        // `targetGameId` / `targetGameSeq` are an external focus signal: the
        // timings-drilldown 'open game →' link bumps the seq with the gameId
        // it wants to bring into view. We honor it by expanding the row and
        // scrolling the row into view; the seq bump means clicking the same
        // game twice still re-fires the effect.
        const [expandedId, setExpandedId] = useState(null);
        const [expandedMode, setExpandedMode] = useState("build");
        // Open game appears in a full-screen modal (macro breakdown +
        // activity + resources). Set to {game, gameId, macroValue} to open.
        const [modalGame, setModalGame] = useState(null);
        // Live macro_score overrides keyed by gameId. Populated when
        // MacroBreakdownPanel finishes a (re)compute via its
        // onScoreChange prop, then preferred by the macro-column
        // reader so the selection button shows the fresh number even
        // when settings changes invalidated the persisted score.
        const [scoreOverrides, setScoreOverrides] = useState({});
        const tableRef = useRef(null);
        useEffect(() => {
          if (!targetGameId || !tableRef.current) return;
          setExpandedId(targetGameId);
          setExpandedMode("build");
          const el = tableRef.current.querySelector(
            `[data-game-row-id="${CSS && CSS.escape ? CSS.escape(targetGameId) : targetGameId}"]`,
          );
          if (el && typeof el.scrollIntoView === "function") {
            try {
              el.scrollIntoView({ behavior: "smooth", block: "center" });
            } catch (_) {
              el.scrollIntoView();
            }
          }
        }, [targetGameId, targetGameSeq]);
        return (
          <>
          <table ref={tableRef} className="w-full text-sm">
            <thead className="text-neutral-500 text-[11px] uppercase sticky top-0 bg-base-800">
              <tr>
                <th className="text-left py-1 px-2 w-6"></th>
                <th className="text-left py-1 px-2">Date</th>
                <th className="text-left py-1 px-2">Map</th>
                <th className="text-left py-1 px-2">Opponent</th>
                <th className="text-left py-1 px-2">Race</th>
                <th className="text-left py-1 px-2">Strategy</th>
                <th className="text-left py-1 px-2">My Build</th>
                <th className="text-right py-1 px-2">Macro</th>
                <th className="text-right py-1 px-2">Result</th>
              </tr>
            </thead>
            <tbody>
              {games.map((g, i) => {
                // A "real" id is one that came off the actual game record. The
                // synthetic `_idx_N` fallback exists only as a React key; we
                // must NOT use it to fetch /games/:id/build-order or the
                // backend will return 404 "game not found". Rows without a
                // real id are rendered non-interactive (no expand caret, no
                // macro click) instead of producing a broken expand drawer.
                const realId = g.id || g.game_id || null;
                const id = realId || `_idx_${i}`;
                const expandable = !!realId;
                const isOpen = expandable && expandedId === id;
                // Read macro score with defensive fallback — top-level
                // macro_score is the canonical field, but macro_breakdown.score
                // (live recompute payload) and macro_breakdown.macro_score
                // (Python CLI backfill payload) carry the same value. Fall
                // through so a row that lost macro_score in transit still
                // renders the score from whatever shape survived.
                const macro = (() => {
                  // Live overrides win — once the breakdown panel fires
                  // onScoreChange we render the fresh number, even if
                  // g.macro_score on the row predates the recompute.
                  if (typeof scoreOverrides[id] === "number") return scoreOverrides[id];
                  if (typeof g.macro_score === "number") return g.macro_score;
                  const bd = g && g.macro_breakdown;
                  if (bd && typeof bd === "object") {
                    if (typeof bd.score === "number") return bd.score;
                    if (typeof bd.macro_score === "number") return bd.macro_score;
                  }
                  return null;
                })();
                const macroColor =
                  macro == null
                    ? "text-neutral-500"
                    : macro >= 75
                      ? "text-win-500"
                      : macro >= 50
                        ? "text-gold-500"
                        : "text-loss-500";
                const macroOpen = isOpen && expandedMode === "macro";
                return (
                  <Fragment key={id}>
                    <tr
                      data-game-row-id={id}
                      className={
                        "border-t border-base-700 " +
                        (expandable
                          ? "cursor-pointer hover:bg-base-700/40 "
                          : "") +
                        (isOpen ? "bg-base-700/30" : "")
                      }
                      onClick={() => {
                        if (!expandable) return;
                        if (isOpen && expandedMode === "build") {
                          setExpandedId(null);
                        } else {
                          setExpandedId(id);
                          setExpandedMode("build");
                        }
                      }}
                    >
                      <td className="py-1 px-2 text-neutral-500 select-none">
                        {expandable ? (isOpen ? "▾" : "▸") : ""}
                      </td>
                      <td className="py-1 px-2 text-neutral-400 font-mono text-xs">
                        {fmtDate(g.date)}
                      </td>
                      <td className="py-1 px-2 text-neutral-300">
                        {g.map || "—"}
                      </td>
                      <td className="py-1 px-2 text-neutral-300">
                        {g.opponent || "—"}
                      </td>
                      <td className={`py-1 px-2 ${raceClass(g.opp_race)}`}>
                        {(g.opp_race || "?")[0].toUpperCase()}
                      </td>
                      <td className="py-1 px-2 text-neutral-400">
                        {g.opp_strategy || "—"}
                      </td>
                      <td
                        className="py-1 px-2 text-neutral-300"
                        title="The build I played that game"
                      >
                        {g.my_build || "—"}
                      </td>
                      <td className="py-1 px-2 text-right">
                        {macro == null && expandable ? (
                          // Stage 6.2.1: a missing macro score is still
                          // actionable for real-id rows -- clicking opens
                          // the detail modal which auto-recomputes from
                          // the replay file. We pass macroValue=null so
                          // MacroBreakdownPanel can detect the no-score
                          // state and kick the recompute itself.
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setModalGame({
                                game: g,
                                gameId: id,
                                macroValue: null,
                              });
                            }}
                            className="font-semibold tabular-nums text-neutral-500 underline decoration-dotted underline-offset-2 hover:text-neutral-300"
                            title="No macro score yet -- click to recompute from the replay file."
                          >
                            —
                          </button>
                        ) : macro == null ? (
                          <span
                            className="font-semibold tabular-nums text-neutral-500"
                            title="Replay metadata missing - run the analyzer on this replay to enable click-through."
                          >
                            —
                          </span>
                        ) : expandable ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setModalGame({
                                game: g,
                                gameId: id,
                                macroValue: macro,
                              });
                            }}
                            className={`font-semibold tabular-nums underline decoration-dotted underline-offset-2 hover:opacity-80 ${macroColor}`}
                            title="Click to see how this score was calculated"
                          >
                            {macro}
                          </button>
                        ) : (
                          <span
                            className={`font-semibold tabular-nums ${macroColor}`}
                            title="Replay metadata missing - run the analyzer on this replay to enable click-through."
                          >
                            {macro}
                          </span>
                        )}
                      </td>
                      <td
                        className={`py-1 px-2 text-right font-semibold ${g.result === "Win" || g.result === "Victory" ? "text-win-500" : g.result === "Loss" || g.result === "Defeat" ? "text-loss-500" : "text-neutral-500"}`}
                      >
                        {g.result || "—"}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-base-800/40">
                        <td colSpan={9} className="px-2 pb-3">
                          <BuildOrderTimeline
                            gameId={id}
                            perspective={perspective}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {modalGame && (
            <GameDetailModal
              game={modalGame.game}
              gameId={modalGame.gameId}
              macroValue={modalGame.macroValue}
              onClose={() => setModalGame(null)}
              onScoreChange={(score) => {
                if (typeof score !== "number") return;
                const targetId = modalGame.gameId;
                setScoreOverrides((prev) =>
                  Object.assign({}, prev, { [targetId]: score }),
                );
              }}
            />
          )}
          </>
        );
      }

  // Expose to global so inline-block JSX in index.html can render
  // these as bare identifiers.
  Object.assign(window, {
    GameDetailModal,
    GamesTableWithBuildOrder
  });
})();
