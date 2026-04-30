/**
 * MacroBreakdownPanel — extracted from index.html.
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


      // "Recompute" button that POSTs to /games/:id/macro-breakdown to re-parse
      // the replay file.
      function MacroBreakdownPanel({ gameId, initialMacro, onScoreChange }) {
        const [data, setData] = useState(null);
        const [loading, setLoading] = useState(true);
        const [error, setError] = useState(null);
        const [recomputing, setRecomputing] = useState(false);

        useEffect(() => {
          let cancelled = false;
          setLoading(true);
          setError(null);
          fetch(`${API}/games/${encodeURIComponent(gameId)}/build-order`)
            .then((r) =>
              r.ok ? r.json() : r.json().then((j) => Promise.reject(j)),
            )
            .then((j) => {
              if (cancelled) return;
              setData(j);
              setLoading(false);
              // Auto-recompute when the stored macro_breakdown is the
              // SLIM shape (post-migration: no stats_events / opp_stats_
              // events / unit_timeline persisted to disk). The existing
              // Active Army & Workers chart needs those arrays, so we
              // hit /macro-breakdown POST in the background. The chart
              // shows a brief "computing samples..." indicator.
              const bd = j && j.macro_breakdown;
              const hasSamples = bd && Array.isArray(bd.stats_events)
                && bd.stats_events.length > 0;
              // Stage 6.2.1: also auto-recompute when there's no stored
              // macro_score yet -- the modal was likely opened from a
              // table dash cell to do exactly this.
              const hasScore = typeof j.macro_score === "number";
              const needsRecompute = !hasScore || (bd && !hasSamples);
              if (needsRecompute) {
                setRecomputing(true);
                fetch(`${API}/games/${encodeURIComponent(gameId)}/macro-breakdown`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({}),
                })
                  .then((r) =>
                    r.ok ? r.json() : r.json().then((jj) => Promise.reject(jj)),
                  )
                  .then((fresh) => {
                    if (cancelled) return;
                    setData((d) =>
                      Object.assign({}, d, {
                        macro_score: fresh.macro_score,
                        top_3_leaks: fresh.top_3_leaks || [],
                        macro_breakdown: {
                          score: fresh.score,
                          race: fresh.race,
                          game_length_sec: fresh.game_length_sec,
                          raw: fresh.raw || {},
                          all_leaks: fresh.all_leaks || [],
                          top_3_leaks: fresh.top_3_leaks || [],
                          stats_events: Array.isArray(fresh.stats_events)
                            ? fresh.stats_events : [],
                          opp_stats_events: Array.isArray(fresh.opp_stats_events)
                            ? fresh.opp_stats_events : [],
                          unit_timeline: Array.isArray(fresh.unit_timeline)
                            ? fresh.unit_timeline : [],
                        },
                      }),
                    );
                    setRecomputing(false);
                    if (typeof onScoreChange === "function") onScoreChange(fresh.macro_score);
                  })
                  .catch(() => {
                    // Best-effort. Manual "Recompute" button still works.
                    if (!cancelled) setRecomputing(false);
                  });
              }
            })
            .catch((e) => {
              if (!cancelled) {
                setError(e.error || "fetch failed");
                setLoading(false);
              }
            });
          return () => {
            cancelled = true;
          };
        }, [gameId]);

        const recompute = () => {
          setRecomputing(true);
          setError(null);
          fetch(`${API}/games/${encodeURIComponent(gameId)}/macro-breakdown`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          })
            .then((r) =>
              r.ok ? r.json() : r.json().then((j) => Promise.reject(j)),
            )
            .then((j) => {
              // Merge fresh breakdown into local data for instant rerender.
              setData((d) =>
                Object.assign({}, d, {
                  macro_score: j.macro_score,
                  top_3_leaks: j.top_3_leaks || [],
                  macro_breakdown: {
                    score: j.score,
                    race: j.race,
                    game_length_sec: j.game_length_sec,
                    raw: j.raw || {},
                    all_leaks: j.all_leaks || [],
                    top_3_leaks: j.top_3_leaks || [],
                    // PlayerStatsEvent samples for the army/workers chart.
                    stats_events: Array.isArray(j.stats_events) ? j.stats_events : [],
                    // Opponent samples + alive-unit timeline for the dual-
                    // player chart and the unit roster panel.
                    opp_stats_events: Array.isArray(j.opp_stats_events) ? j.opp_stats_events : [],
                    unit_timeline: Array.isArray(j.unit_timeline) ? j.unit_timeline : [],
                  },
                }),
              );
              setRecomputing(false);
              if (typeof onScoreChange === "function") onScoreChange(j.macro_score);
            })
            .catch((e) => {
              setError(e.error || "recompute failed");
              setRecomputing(false);
            });
        };

        if (loading)
          return (
            <div className="text-xs text-neutral-500 px-3 py-2">
              loading macro breakdown…
            </div>
          );
        if (error)
          return (
            <div className="text-xs text-loss-500 px-3 py-2">
              macro unavailable: {error}
            </div>
          );
        if (!data) return null;

        const score =
          typeof data.macro_score === "number"
            ? data.macro_score
            : initialMacro;
        const breakdown = data.macro_breakdown || null;
        const raw = (breakdown && breakdown.raw) || {};
        const leaks =
          breakdown &&
          Array.isArray(breakdown.all_leaks) &&
          breakdown.all_leaks.length > 0
            ? breakdown.all_leaks
            : Array.isArray(data.top_3_leaks)
              ? data.top_3_leaks
              : [];
        const race = (breakdown && breakdown.race) || "";

        // Effective race: prefer the explicit race the backend tagged
        // (analytics/macro_score.py reads my_race from the parser). For
        // older breakdowns or when the user is Random, fall back to the
        // exclusive discipline field that was populated — macro_score
        // only writes ONE of injects/chronos/mules per game so the
        // non-null field is the authoritative race signal.
        const effectiveRace =
          race === "Zerg" || race === "Protoss" || race === "Terran"
            ? race
            : raw.injects_actual != null
              ? "Zerg"
              : raw.chronos_actual != null
                ? "Protoss"
                : raw.mules_actual != null
                  ? "Terran"
                  : "";

        // Per-race section descriptor used by the discipline panel and
        // the "What you did well" copy. The glyph string drives the
        // .race-Z / .race-P / .race-T CSS class (defined at the top of
        // this file) so the small letter next to each heading paints
        // in the right accent. unitPlural is rendered alongside the
        // actual/expected count in the discipline panel.
        const RACE_SECTIONS = {
          Zerg: {
            glyph: "Z",
            title: "Inject Efficiency",
            actualKey: "injects_actual",
            expectedKey: "injects_expected",
            unitPlural: "injects",
            winCopy: "Inject cadence kept up with hatchery uptime.",
          },
          Protoss: {
            glyph: "P",
            title: "Chrono Efficiency",
            actualKey: "chronos_actual",
            expectedKey: "chronos_expected",
            unitPlural: "chronos",
            winCopy: "Chrono usage matched nexus uptime.",
          },
          Terran: {
            glyph: "T",
            title: "MULE Efficiency",
            actualKey: "mules_actual",
            expectedKey: "mules_expected",
            unitPlural: "MULEs",
            winCopy: "MULE drops kept pace with orbital energy.",
          },
        };
        const raceSection = RACE_SECTIONS[effectiveRace] || null;

        const headlineColor =
          typeof score !== "number"
            ? "text-neutral-500"
            : score >= 75
              ? "text-win-500"
              : score >= 50
                ? "text-gold-500"
                : "text-loss-500";

        const wins = [];
        if (raw && (raw.supply_block_penalty || 0) <= 0)
          wins.push("No meaningful supply block - production never stalled.");
        if (raw && (raw.race_penalty || 0) <= 0 && raceSection)
          wins.push(raceSection.winCopy);
        if (raw && (raw.float_penalty || 0) <= 0)
          wins.push("Bank stayed under control - no sustained float.");
        if (typeof raw.sq === "number" && raw.sq >= 80)
          wins.push(
            `Spending Quotient ${raw.sq.toFixed(0)} - Master/Pro-tier macro pacing.`,
          );
        else if (typeof raw.sq === "number" && raw.sq >= 70)
          wins.push(
            `Spending Quotient ${raw.sq.toFixed(0)} - solid Diamond-tier macro pacing.`,
          );

        const racePenaltyLabel =
          effectiveRace === "Zerg"
            ? "Inject penalty"
            : effectiveRace === "Protoss"
              ? "Chrono penalty"
              : effectiveRace === "Terran"
                ? "MULE penalty"
                : "Race-mechanic penalty";

        return (
          <div className="bg-base-900 ring-soft rounded-lg p-3 my-2 border border-base-700">
            <div className="flex items-center gap-3 mb-3 flex-wrap">
              <span className="text-[11px] uppercase tracking-wider text-neutral-500">
                Macro Breakdown
              </span>
              <span
                className={`text-2xl font-bold tabular-nums ${headlineColor}`}
              >
                {typeof score === "number" ? score : "—"}
                <span className="text-sm text-neutral-500 font-normal">
                  {" "}
                  / 100
                </span>
              </span>
              <div className="ml-auto">
                <button
                  onClick={recompute}
                  disabled={recomputing}
                  className="px-2.5 py-1 text-xs rounded bg-base-700 hover:bg-base-600 text-neutral-200 disabled:opacity-50"
                  title="Re-parse the replay file to (re)compute the macro breakdown."
                >
                  {recomputing ? "Recomputing…" : "Recompute"}
                </button>
              </div>
            </div>

            {breakdown ? (
              <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {/* How it was calculated */}
                <div className="bg-base-800 rounded p-3">
                  <div className="text-[11px] uppercase tracking-wider text-neutral-500 mb-2">
                    How this number was calculated
                  </div>
                  <div className="text-xs text-neutral-400 mb-2">
                    Headline = Spending Quotient (SQ) - 5, then small penalties
                    for the SC2-specific macro disciplines (clamped 0..100).
                  </div>
                  <table className="w-full text-xs">
                    <tbody className="divide-y divide-base-700">
                      {typeof raw.sq === "number" && (
                        <tr>
                          <td className="py-1 text-neutral-300">
                            Spending Quotient (SQ)
                          </td>
                          <td className="py-1 text-right tabular-nums text-neutral-200">
                            {raw.sq.toFixed(1)}
                          </td>
                        </tr>
                      )}
                      {typeof raw.base_score === "number" && (
                        <tr>
                          <td className="py-1 text-neutral-300">
                            Base score (SQ - 5)
                          </td>
                          <td className="py-1 text-right tabular-nums text-neutral-200">
                            {raw.base_score.toFixed(1)}
                          </td>
                        </tr>
                      )}
                      <tr>
                        <td className="py-1 text-neutral-300">
                          Supply-block penalty
                        </td>
                        <td
                          className={`py-1 text-right tabular-nums ${(raw.supply_block_penalty || 0) > 0 ? "text-loss-500" : "text-win-500"}`}
                        >
                          -{Number(raw.supply_block_penalty || 0).toFixed(1)}
                        </td>
                      </tr>
                      <tr>
                        <td className="py-1 text-neutral-300">
                          {racePenaltyLabel}
                        </td>
                        <td
                          className={`py-1 text-right tabular-nums ${(raw.race_penalty || 0) > 0 ? "text-loss-500" : "text-win-500"}`}
                        >
                          -{Number(raw.race_penalty || 0).toFixed(1)}
                        </td>
                      </tr>
                      <tr>
                        <td className="py-1 text-neutral-300">
                          Mineral-float penalty
                        </td>
                        <td
                          className={`py-1 text-right tabular-nums ${(raw.float_penalty || 0) > 0 ? "text-loss-500" : "text-win-500"}`}
                        >
                          -{Number(raw.float_penalty || 0).toFixed(1)}
                        </td>
                      </tr>
                      <tr className="font-semibold">
                        <td className="py-1 text-neutral-200">
                          Final score (clamped)
                        </td>
                        <td
                          className={`py-1 text-right tabular-nums ${headlineColor}`}
                        >
                          {typeof score === "number" ? score : "—"}
                        </td>
                      </tr>
                    </tbody>
                  </table>

                  {/* Race-specific discipline panel. Backend writes
                      exactly one of injects/chronos/mules per game
                      (driven by my_race in analytics/macro_score.py),
                      so we render the section for the effective race
                      and leave the others off the DOM entirely. The
                      glyph next to the heading uses the .race-Z /
                      .race-P / .race-T accent classes already declared
                      in the stylesheet. */}
                  {raceSection &&
                    raw[raceSection.actualKey] != null &&
                    raw[raceSection.expectedKey] != null && (
                      <div className="mt-3 bg-base-900 rounded p-2">
                        <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1 flex items-center gap-1.5">
                          <span
                            className={`race-${raceSection.glyph} font-bold`}
                            aria-hidden="true"
                          >
                            {raceSection.glyph}
                          </span>
                          <span>{raceSection.title}</span>
                        </div>
                        <div className="text-xs text-accent-400">
                          {raw[raceSection.actualKey]} of ~
                          {raw[raceSection.expectedKey]} expected (
                          {Math.round(
                            (100 * raw[raceSection.actualKey]) /
                              Math.max(1, raw[raceSection.expectedKey]),
                          )}
                          % {raceSection.unitPlural})
                        </div>
                      </div>
                    )}

                  {/* Race-agnostic discipline metrics (apply to every
                      race). Rendered separately from the race section
                      so the per-race heading stays clean. */}
                  {(raw.supply_blocked_seconds != null ||
                    raw.mineral_float_spikes != null) && (
                    <div className="mt-2 text-xs text-accent-400">
                      <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1">
                        Discipline metrics
                      </div>
                      {raw.supply_blocked_seconds != null && (
                        <div>
                          Supply-blocked:{" "}
                          {Math.round(raw.supply_blocked_seconds)}s total
                        </div>
                      )}
                      {raw.mineral_float_spikes != null && (
                        <div>
                          Mineral float spikes (&gt;800 after 4:00):{" "}
                          {raw.mineral_float_spikes} sample(s)
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* What you did well + leaks */}
                <div className="bg-base-800 rounded p-3 space-y-3">
                  {wins.length > 0 && (
                    <div>
                      <div className="text-[11px] uppercase tracking-wider text-win-500 mb-1">
                        What you did well
                      </div>
                      <ul className="text-xs text-neutral-200 space-y-1 list-disc pl-4">
                        {wins.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-loss-500 mb-1">
                      Where you lost economy
                    </div>
                    {leaks.length === 0 ? (
                      <div className="text-xs text-neutral-500">
                        No notable leaks detected.
                      </div>
                    ) : (
                      <ul className="space-y-2">
                        {leaks.map((lk, i) => (
                          <li key={i} className="bg-base-900 rounded p-2">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-semibold text-neutral-100">
                                {lk.name}
                              </span>
                              {typeof lk.penalty === "number" &&
                                lk.penalty > 0 && (
                                  <span className="ml-auto text-[11px] font-semibold text-loss-500 tabular-nums">
                                    -{lk.penalty.toFixed(1)} pts
                                  </span>
                                )}
                            </div>
                            <div className="text-[11px] text-neutral-400 mt-0.5">
                              {lk.detail || ""}
                            </div>
                            {typeof lk.mineral_cost === "number" &&
                              lk.mineral_cost > 0 && (
                                <div className="text-[11px] text-gold-500 mt-0.5">
                                  ~{lk.mineral_cost} min lost
                                </div>
                              )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </div>
              {/* Macro detail flow (top -> bottom):
                    1. Active Army & Workers   — headline economy/army snapshot,
                                                  always rendered when stats_events present.
                    2. Chrono allocation       — Protoss-only deep-dive on where
                                                  chronos landed; renders below the
                                                  headline so race-specific detail
                                                  reads as a refinement, not a header.
                    3. Spending efficiency     — over-time SQ curve with leak windows;
                                                  ties back to BuildOrderTimeline via
                                                  the sc2:focus-build-order event.
                  Each section uses an mt-4 wrapper for a consistent vertical
                  rhythm; each chart owns its own card chrome and header. */}
              <div className="mt-4">
                <MacroResourceChart
                  statsEvents={breakdown && breakdown.stats_events}
                  oppStatsEvents={breakdown && breakdown.opp_stats_events}
                  unitTimeline={breakdown && breakdown.unit_timeline}
                  race={race}
                  gameLengthSec={breakdown && breakdown.game_length_sec}
                />
              </div>
              {effectiveRace === "Protoss" &&
                Array.isArray(raw.chrono_targets) &&
                raw.chrono_targets.length > 0 && (
                <div className="mt-4">
                  <ChronoAllocationPanel targets={raw.chrono_targets} />
                </div>
              )}
              <div className="mt-4">
                <SpendingEfficiencyChart
                  gameId={gameId}
                  statsEvents={breakdown && breakdown.stats_events}
                  oppStatsEvents={breakdown && breakdown.opp_stats_events}
                  leakWindows={raw.leak_windows}
                  oppLeakWindows={raw.opp_leak_windows}
                  gameLengthSec={breakdown && breakdown.game_length_sec}
                />
              </div>
              </>
            ) : leaks.length > 0 ? (
              /* Older games without macro_breakdown but with top_3_leaks: show summary only. */
              <div className="bg-base-800 rounded p-3">
                <div className="text-[11px] uppercase tracking-wider text-loss-500 mb-2">
                  Top leaks
                </div>
                <ul className="space-y-2">
                  {leaks.map((lk, i) => (
                    <li key={i} className="bg-base-900 rounded p-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-neutral-100">
                          {lk.name}
                        </span>
                        {typeof lk.penalty === "number" && lk.penalty > 0 && (
                          <span className="ml-auto text-[11px] font-semibold text-loss-500 tabular-nums">
                            -{Number(lk.penalty).toFixed(1)} pts
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-neutral-400 mt-0.5">
                        {lk.detail || ""}
                      </div>
                      {typeof lk.mineral_cost === "number" &&
                        lk.mineral_cost > 0 && (
                          <div className="text-[11px] text-gold-500 mt-0.5">
                            ~{lk.mineral_cost} min lost
                          </div>
                        )}
                    </li>
                  ))}
                </ul>
                <div className="text-[11px] text-neutral-500 mt-2">
                  Detailed breakdown not stored for this game. Click "Recompute"
                  to re-parse the replay.
                </div>
              </div>
            ) : (
              <div className="bg-base-800 rounded p-3 text-xs text-neutral-500">
                No macro detail stored for this game. Click "Recompute" to
                re-parse the replay.
              </div>
            )}
          </div>
        );
      }

  // Expose to global so inline-block JSX in index.html can render
  // these as bare identifiers.
  Object.assign(window, {
    MacroBreakdownPanel
  });
})();
