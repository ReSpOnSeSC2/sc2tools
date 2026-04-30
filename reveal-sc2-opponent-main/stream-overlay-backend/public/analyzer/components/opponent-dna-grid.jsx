/**
 * Opponent DNA — MedianTimingsGrid + TimingCard + Last5GamesTimeline + PredictedStrategiesList — extracted from index.html.
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


      /**
       * Matchup-aware Median Timings grid.
       *
       * Source of order: `data.medianTimingsOrder` from the API payload.
       * Source of taxonomy (display name, icon, race ownership): the
       * `window.TimingCatalog` script tag loaded at the top of the page.
       *
       * UI features:
       *   - Building icon (top-left), display name, hero median, p25-p75
       *     range, sample-count badge, win-rate pill, trend arrow.
       *   - Empty cards (sampleCount === 0) render dimmed + non-clickable
       *     subline "no samples"; still keyboard-focusable so screen-reader
       *     users can scan the matchup-relevant slots.
       *   - Click opens the side drilldown drawer with the contributing games.
       *   - Source filter pills above the grid filter by `source`. Choice
       *     persists in localStorage under `analyzer.timings.sourceFilter`.
       *   - aria-live summary line announces matchup + filter changes.
       */
      function MedianTimingsGrid({
        timings,
        order,
        matchupLabel,
        opponentName,
        matchupCounts,
        matchupTimings,
        onOpenGame,
      }) {
        // Source filter ('both' | 'opp' | 'self'), persisted in localStorage.
        const SF_KEY = "analyzer.timings.sourceFilter";
        const [sourceFilter, setSourceFilter] = useState(() => {
          try {
            const v =
              window.localStorage && window.localStorage.getItem(SF_KEY);
            return v === "opp" || v === "self" ? v : "both";
          } catch (_) {
            return "both";
          }
        });
        useEffect(() => {
          try {
            window.localStorage &&
              window.localStorage.setItem(SF_KEY, sourceFilter);
          } catch (_) {
            /* private mode: just live with in-memory state */
          }
        }, [sourceFilter]);

        // Per-matchup selector ('All' | matchup label, e.g. 'PvZ').
        // Persisted per-opponent under analyzer.timings.matchup[<opp_name>]
        // so each opponent remembers the last matchup the user inspected.
        const MS_KEY = "analyzer.timings.matchup";
        const opponentKey = opponentName || matchupLabel || "__none__";
        const matchupChips =
          matchupCounts && Object.keys(matchupCounts).length > 0
            ? Object.entries(matchupCounts).sort((a, b) => b[1] - a[1])
            : [];
        const [activeMatchup, setActiveMatchup] = useState(() => {
          try {
            const v =
              window.localStorage && window.localStorage.getItem(MS_KEY);
            const obj = v ? JSON.parse(v) : null;
            const stored = obj && obj[opponentKey];
            // Validate: only honor the saved value if it's still a real chip.
            if (stored === "All" || stored == null) return "All";
            if (matchupCounts && matchupCounts[stored]) return stored;
            return "All";
          } catch (_) {
            return "All";
          }
        });
        useEffect(() => {
          try {
            if (!window.localStorage) return;
            const v = window.localStorage.getItem(MS_KEY);
            const obj = (v ? JSON.parse(v) : null) || {};
            obj[opponentKey] = activeMatchup;
            window.localStorage.setItem(MS_KEY, JSON.stringify(obj));
          } catch (_) {
            /* private mode: just live with in-memory state */
          }
        }, [activeMatchup, opponentKey]);

        // Pick the timings/order/label that match the active matchup chip.
        // 'All' = the unfiltered backend payload; per-matchup = the
        // backend-precomputed `matchupTimings[label]` blob.
        let activeTimings = timings;
        let activeOrder = order;
        let activeLabel = matchupLabel;
        if (
          activeMatchup !== "All" &&
          matchupTimings &&
          matchupTimings[activeMatchup]
        ) {
          activeTimings = matchupTimings[activeMatchup].timings;
          activeOrder = matchupTimings[activeMatchup].order;
          activeLabel = activeMatchup;
        }

        // Drilldown state.
        const [drillToken, setDrillToken] = useState(null);

        if (!activeTimings || !activeOrder || activeOrder.length === 0) {
          return (
            <EmptyState
              title="No matchup-relevant timings"
              sub="This opponent has no games with both build logs parsed yet."
            />
          );
        }

        // Apply source filter to the canonical order. Tokens not in `activeTimings`
        // are silently dropped, so we never render a building outside the
        // backend's matchup-relevant list.
        const visibleTokens = activeOrder.filter((tok) => {
          const info = activeTimings[tok];
          if (!info) return false;
          if (sourceFilter === "opp") return info.source === "opp_build_log";
          if (sourceFilter === "self") return info.source === "build_log";
          return true;
        });

        const total = activeOrder.length;
        const filterSuffix =
          sourceFilter === "opp"
            ? " — opponent tech only"
            : sourceFilter === "self"
              ? " — your tech only"
              : "";
        const matchupSuffix =
          activeMatchup === "All"
            ? ""
            : ` (${(matchupCounts && matchupCounts[activeMatchup]) || 0} game${
                (matchupCounts && matchupCounts[activeMatchup]) === 1 ? "" : "s"
              })`;
        const summary = activeLabel
          ? `Showing ${visibleTokens.length} of ${total} timings for ${activeLabel}${matchupSuffix}${filterSuffix}`
          : `Showing ${visibleTokens.length} of ${total} timings${filterSuffix}`;

        const filterBtn = (key, label) => {
          const active = sourceFilter === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setSourceFilter(key)}
              aria-pressed={active}
              className={
                "px-3 py-1 rounded-full text-xs ring-soft transition-colors " +
                (active
                  ? "bg-accent-500/20 text-accent-400"
                  : "bg-base-700 text-neutral-400 hover:text-neutral-200")
              }
            >
              {label}
            </button>
          );
        };

        // Per-matchup chip ("All" + one per matchup the opponent has
        // played). Same pill chrome as the source filter so the two rows
        // read as a coherent control bar.
        const matchupBtn = (key, label, count) => {
          const active = activeMatchup === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setActiveMatchup(key)}
              aria-pressed={active}
              className={
                "px-3 py-1 rounded-full text-xs ring-soft transition-colors " +
                (active
                  ? "bg-accent-500/20 text-accent-400"
                  : "bg-base-700 text-neutral-400 hover:text-neutral-200")
              }
            >
              {count == null ? label : `${label} (${count})`}
            </button>
          );
        };

        return (
          <div data-testid="median-timings-grid">
            {matchupChips.length > 0 ? (
              <div
                className="flex flex-wrap items-center gap-2 mb-2"
                data-testid="median-timings-matchup-chips"
              >
                {matchupBtn("All", "All", null)}
                {matchupChips.map(([ml, n]) => matchupBtn(ml, ml, n))}
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-2 mb-3">
              {filterBtn("both", "Both")}
              {filterBtn("opp", "Opponent's tech")}
              {filterBtn("self", "Your tech")}
            </div>
            <div
              aria-live="polite"
              className="text-[11px] text-neutral-500 mb-2"
              data-testid="median-timings-summary"
            >
              {summary}
            </div>
            {visibleTokens.length === 0 ? (
              <EmptyState
                title="No timings for this filter"
                sub="Try the other source pill or 'Both'."
              />
            ) : (
              <div
                className="grid gap-2"
                style={{
                  gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
                }}
              >
                {visibleTokens.map((tok) => (
                  <TimingCard
                    key={tok}
                    token={tok}
                    info={activeTimings[tok]}
                    onClick={() => {
                      // Don't open the drawer on empty cards.
                      if ((activeTimings[tok] || {}).sampleCount > 0)
                        setDrillToken(tok);
                    }}
                  />
                ))}
              </div>
            )}
            <TimingsDrilldownDrawer
              open={!!drillToken}
              onClose={() => setDrillToken(null)}
              token={drillToken}
              info={drillToken ? activeTimings[drillToken] : null}
              matchupLabel={activeLabel}
              onOpenGame={onOpenGame}
            />
          </div>
        );
      }

      /**
       * One card in the grid. Renders the icon + median + metadata.
       * Empty cards (sampleCount === 0) get dimmed styling and are still
       * Tab-focusable but never open the drilldown.
       */
      function TimingCard({ token, info, onClick }) {
        info = info || {};
        const empty = !info.sampleCount;
        const iconUrl = buildingIconUrl(token);
        const display = buildingDisplayName(token, token);
        const trend = TREND_GLYPHS[info.trend] || TREND_GLYPHS.unknown;
        const wrPctStr =
          info.winRateWhenBuilt == null
            ? "—"
            : Math.round(info.winRateWhenBuilt * 100) + "%";
        const wrPillBg = wrPillColor(info.winRateWhenBuilt, info.sampleCount);
        const sourceLabel =
          info.source === "opp_build_log"
            ? "opponent's structures (sc2reader)"
            : "your build (proxy for matchup tendencies)";

        // Tooltip content. Composed once so hover/focus produce the same text.
        const tipLines = [];
        if (info.sampleCount) {
          if (info.minDisplay && info.maxDisplay)
            tipLines.push(`range ${info.minDisplay}–${info.maxDisplay}`);
          if (info.lastSeenDisplay && info.lastSeenDisplay !== "-")
            tipLines.push(`last seen at ${info.lastSeenDisplay}`);
          tipLines.push(sourceLabel);
          tipLines.push(`n=${info.sampleCount} matchup samples`);
        } else {
          tipLines.push("No samples in this matchup");
          tipLines.push(sourceLabel);
        }
        const tipTitle = tipLines.join("\n");

        const ariaLabel = empty
          ? `${display} — no samples`
          : `${display}, median ${info.medianDisplay}, n=${info.sampleCount}, ` +
            `win rate ${wrPctStr}, ${trend.label}`;

        return (
          <div
            role={empty ? undefined : "button"}
            tabIndex={empty ? -1 : 0}
            aria-label={ariaLabel}
            aria-disabled={empty || undefined}
            onClick={empty ? undefined : onClick}
            onKeyDown={
              empty
                ? undefined
                : (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onClick && onClick();
                    }
                  }
            }
            title={tipTitle}
            className={
              "bg-base-700 ring-soft rounded-lg px-3 py-2 " +
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 " +
              (empty
                ? "opacity-60 cursor-default"
                : "cursor-pointer hover:bg-base-700/80 focus:ring-2 focus:ring-accent-500")
            }
            data-testid="timing-card"
            data-token={token}
            data-empty={empty ? "1" : "0"}
            data-empty-card={empty ? "1" : "0"}
            data-source={info.source || ""}
          >
            <div className="flex items-start gap-2">
              {iconUrl ? (
                <img
                  src={iconUrl}
                  alt=""
                  width={28}
                  height={28}
                  className={
                    "w-7 h-7 object-contain flex-none " +
                    (empty ? "opacity-50" : "")
                  }
                  onError={(e) => {
                    e.currentTarget.style.visibility = "hidden";
                  }}
                />
              ) : (
                <div
                  className="w-7 h-7 rounded bg-base-800 flex-none"
                  aria-hidden="true"
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="text-[11px] uppercase tracking-wider text-neutral-500 truncate">
                  {display}
                </div>
                <div
                  className={
                    "mt-0.5 text-xl font-semibold tabular-nums " +
                    (empty ? "text-neutral-600" : "text-neutral-100")
                  }
                >
                  {info.medianDisplay || "-"}
                </div>
                {!empty &&
                info.p25Display &&
                info.p75Display &&
                info.sampleCount >= 2 ? (
                  <div className="text-[10px] text-neutral-500 tabular-nums">
                    {info.p25Display} — {info.p75Display}
                  </div>
                ) : empty ? (
                  <div className="text-[10px] text-neutral-600">no samples</div>
                ) : (
                  <div className="text-[10px] text-neutral-600">
                    single sample
                  </div>
                )}
              </div>
            </div>
            <div className="mt-1 flex items-center gap-1 text-[10px]">
              <span className="text-neutral-500 tabular-nums">
                n={info.sampleCount}
              </span>
              {!empty ? (
                <span
                  className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
                  style={{ background: wrPillBg + "22", color: wrPillBg }}
                  title={`win rate when built: ${wrPctStr}`}
                >
                  {wrPctStr}
                </span>
              ) : null}
              <span
                className="ml-auto"
                aria-label={trend.label}
                title={trend.label}
                style={{ color: trend.color }}
              >
                {trend.glyph}
              </span>
            </div>
          </div>
        );
      }

      function Last5GamesTimeline({ games }) {
        if (!games || games.length === 0)
          return <EmptyState sub="No recent games" />;
        return (
          <div className="space-y-2">
            {games.map((g, i) => {
              const result = g.result || g.Result || "";
              const isWin = result === "Win" || result === "Victory";
              const isLoss = result === "Loss" || result === "Defeat";
              const color = isWin ? "#3ddc97" : isLoss ? "#ef476f" : "#9aa3b2";
              const date = g.date || g.Date || "";
              const map = g.map || g.Map || "";
              const len = g.game_length || g.GameLength || 0;
              const lenStr = len
                ? ` (${Math.floor(len / 60)}:${String(len % 60).padStart(2, "0")})`
                : "";
              return (
                <div
                  key={i}
                  className="bg-base-700 ring-soft rounded-lg px-3 py-2"
                >
                  <div className="flex justify-between items-center">
                    <span className="font-semibold text-sm" style={{ color }}>
                      {fmtDate(date)} · {result || "—"}
                      {lenStr}
                    </span>
                    <span
                      className="text-xs text-neutral-500 truncate ml-3 max-w-[40%]"
                      title={map}
                    >
                      {map || "—"}
                    </span>
                  </div>
                  <div className="text-xs text-neutral-400 mt-0.5">
                    opp:{" "}
                    <span className="text-neutral-300">
                      {g.opp_strategy || "—"}
                    </span>
                  </div>
                  <div className="text-xs text-neutral-400 mt-0.5">
                    me:{" "}
                    <span className="text-neutral-300">
                      {g.my_build || "—"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        );
      }

      function PredictedStrategiesList({ predictions }) {
        if (!predictions || predictions.length === 0)
          return <EmptyState sub="Not enough games to predict" />;
        return (
          <div className="space-y-1.5">
            {predictions.slice(0, 8).map((p, i) => (
              <div key={i} className="flex items-center gap-3">
                <div className="w-12 text-right tabular-nums text-sm font-semibold text-accent-400">
                  {pct(p.probability)}
                </div>
                <div className="flex-1 bg-base-700 rounded-full h-2 overflow-hidden">
                  <div
                    className="h-full bg-accent-500"
                    style={{ width: `${(p.probability * 100).toFixed(1)}%` }}
                  />
                </div>
                <div className="text-sm text-neutral-300 flex-1 min-w-[40%]">
                  {p.strategy}
                </div>
              </div>
            ))}
            <div className="text-[10px] text-neutral-600 mt-2">
              recency-weighted: last 10 games count 2× · all others 1×
            </div>
          </div>
        );
      }

  // Expose to global so inline-block JSX in index.html can render
  // these as bare identifiers.
  Object.assign(window, {
    MedianTimingsGrid,
    TimingCard,
    Last5GamesTimeline,
    PredictedStrategiesList
  });
})();
