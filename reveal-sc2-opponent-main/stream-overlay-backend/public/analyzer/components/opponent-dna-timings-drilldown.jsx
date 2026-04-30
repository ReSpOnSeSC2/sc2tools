/**
 * Opponent DNA — StrategyTendencyChart + TimingsDrilldownDrawer + VirtualizedSampleList — extracted from index.html.
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
      // OPPONENT DNA CARDS (used inside OpponentProfile below)
      // ============================================================
      function StrategyTendencyChart({ strategies }) {
        if (!strategies || strategies.length === 0)
          return <EmptyState sub="No strategy data yet" />;
        const total = strategies.reduce((s, x) => s + (x.count || 0), 0) || 1;
        const data = strategies.map((s) => ({
          name: s.strategy,
          winRate: (100 * (s.count || 0)) / total,
          games: s.count,
          _color: wrColor(s.winRate, s.wins + s.losses),
        }));
        return (
          <HBarChart
            data={data}
            height={Math.max(160, 40 * data.length + 60)}
            valueKey="winRate"
            maxValue={100}
            format={(v) => `${v.toFixed(0)}%`}
            colorFor={(d) => d._color}
          />
        );
      }

      /**
       * Drilldown drawer - opens when a timing card is clicked, shows every
       * game that contributed a sample for that token, sorted newest first.
       *
       * Layout: right-side off-canvas panel with backdrop. Focus is trapped
       * inside the panel while open; Escape closes it. We intentionally do
       * NOT introduce a new dialog framework -- this is a small fixed-
       * position div using the same `bg-base-800 ring-soft` chrome as the
       * Cards elsewhere in the SPA.
       */
      function TimingsDrilldownDrawer({
        open,
        onClose,
        token,
        info,
        matchupLabel,
        onOpenGame,
      }) {
        const panelRef = useRef(null);
        const closeBtnRef = useRef(null);
        const copyBtnRef = useRef(null);
        const [copyState, setCopyState] = useState("idle"); // idle | copied | error
        useEffect(() => {
          if (!open) return undefined;
          // Escape closes; Tab cycles focus inside the panel only (focus
          // trap). The trap is a small handler -- we just keep tabs from
          // jumping to elements outside the panel by snapping focus back to
          // either the close button or the copy button at the boundary.
          const focusables = () => {
            if (!panelRef.current) return [];
            return Array.from(
              panelRef.current.querySelectorAll(
                'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
              ),
            ).filter((el) => el.offsetParent !== null);
          };
          const onKey = (e) => {
            if (e.key === "Escape") {
              onClose();
              return;
            }
            if (e.key !== "Tab") return;
            const list = focusables();
            if (list.length === 0) return;
            const first = list[0];
            const last = list[list.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          };
          document.addEventListener("keydown", onKey);
          // Initial focus: the Close button (pre-existing affordance).
          const t = setTimeout(() => {
            const node =
              panelRef.current &&
              panelRef.current.querySelector("[data-autofocus]");
            if (node) node.focus();
          }, 30);
          return () => {
            document.removeEventListener("keydown", onKey);
            clearTimeout(t);
          };
        }, [open, onClose]);
        // Reset the copy button label each time the drawer reopens on a new token.
        useEffect(() => {
          setCopyState("idle");
        }, [token, open]);

        if (!open || !token || !info) return null;
        const samples = Array.isArray(info.samples) ? info.samples : [];
        const display = buildingDisplayName(token, token);
        const iconUrl = buildingIconUrl(token);
        const trend = TREND_GLYPHS[info.trend] || TREND_GLYPHS.unknown;

        const sourceLabel =
          info.source === "opp_build_log"
            ? "opponent's structures (sc2reader)"
            : "your build (proxy for matchup tendencies)";

        function copyAsMarkdown() {
          const lines = [];
          const ml = matchupLabel || "(matchup unknown)";
          const n = info.sampleCount || 0;
          lines.push(`### ${display} — ${ml} (n=${n})`);
          if (n >= 2 && info.p25Display && info.p75Display) {
            lines.push(
              `median ${info.medianDisplay} (p25–p75 ${info.p25Display}–${info.p75Display}` +
                (info.minDisplay && info.maxDisplay
                  ? `, range ${info.minDisplay}–${info.maxDisplay})`
                  : ")"),
            );
          } else {
            lines.push(`median ${info.medianDisplay || "—"}`);
          }
          lines.push("");
          lines.push("| Time | Date | Map | Matchup | Result | Source |");
          lines.push("|------|------|-----|---------|--------|--------|");
          for (const s of samples) {
            const ts = s.display || _format_seconds_safe(s.seconds);
            const dt = String(s.date || "").slice(0, 10) || "—";
            const mp = String(s.map || "—").replace(/\|/g, "/");
            const mu = `${(s.myRace || "?")[0].toUpperCase()} vs ${(s.oppRace || "?")[0].toUpperCase()}`;
            const res = s.result || (s.won ? "Win" : "Loss");
            const srcShort =
              info.source === "opp_build_log" ? "opp_log" : "my_log";
            lines.push(
              `| ${ts} | ${dt} | ${mp} | ${mu} | ${res} | ${srcShort} |`,
            );
          }
          const md = lines.join("\n") + "\n";
          // Prefer the Async Clipboard API; fall back to a hidden <textarea>
          // selection if the page isn't running on https / clipboard-perms
          // are denied (which is common on some local LAN deployments).
          const done = () => {
            setCopyState("copied");
            setTimeout(() => setCopyState("idle"), 1400);
          };
          const fail = () => {
            setCopyState("error");
            setTimeout(() => setCopyState("idle"), 1800);
          };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard
              .writeText(md)
              .then(done)
              .catch(() => {
                try {
                  const ta = document.createElement("textarea");
                  ta.value = md;
                  ta.style.position = "fixed";
                  ta.style.left = "-1000px";
                  document.body.appendChild(ta);
                  ta.select();
                  document.execCommand("copy");
                  document.body.removeChild(ta);
                  done();
                } catch (_) {
                  fail();
                }
              });
          } else {
            try {
              const ta = document.createElement("textarea");
              ta.value = md;
              ta.style.position = "fixed";
              ta.style.left = "-1000px";
              document.body.appendChild(ta);
              ta.select();
              document.execCommand("copy");
              document.body.removeChild(ta);
              done();
            } catch (_) {
              fail();
            }
          }
        }

        const copyLabel =
          copyState === "copied"
            ? "Copied!"
            : copyState === "error"
              ? "Copy failed"
              : "Copy timings to clipboard";

        return (
          <div
            className="fixed inset-0 z-50 flex"
            role="dialog"
            aria-modal="true"
            aria-label={`${display} — drilldown`}
          >
            <div
              className="flex-1 bg-black/60"
              onClick={onClose}
              aria-hidden="true"
            />
            <aside
              ref={panelRef}
              className="w-[min(560px,95vw)] h-full bg-base-800 ring-soft shadow-soft
                     flex flex-col"
            >
              <header className="flex items-center gap-3 px-5 py-4 border-b border-base-700">
                {iconUrl && (
                  <img
                    src={iconUrl}
                    alt=""
                    className="w-9 h-9 object-contain"
                    onError={(e) => {
                      e.currentTarget.style.visibility = "hidden";
                    }}
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-neutral-100 truncate">
                    {display}
                  </div>
                  <div className="text-[11px] text-neutral-500 truncate">
                    {matchupLabel ? `${matchupLabel} · ` : ""}n=
                    {info.sampleCount} · median {info.medianDisplay}
                    {info.p25Display && info.p75Display && info.sampleCount >= 2
                      ? ` (${info.p25Display}–${info.p75Display})`
                      : ""}
                    {info.minDisplay && info.maxDisplay && info.sampleCount >= 2
                      ? ` · range ${info.minDisplay}–${info.maxDisplay}`
                      : ""}
                  </div>
                </div>
                <span
                  title={trend.label}
                  aria-label={trend.label}
                  style={{ color: trend.color }}
                  className="text-base font-semibold tabular-nums"
                >
                  {trend.glyph}
                </span>
                <button
                  ref={closeBtnRef}
                  data-autofocus
                  onClick={onClose}
                  className="text-xs uppercase tracking-wider text-neutral-400
                         hover:text-neutral-100 px-2 py-1 ring-soft rounded"
                  aria-label="Close drilldown"
                >
                  Close
                </button>
              </header>
              <div className="px-5 py-3 text-[11px] text-neutral-500 border-b border-base-700">
                {sourceLabel}
                {" · "}sorted newest first
              </div>
              <div
                className="flex-1 overflow-y-auto"
                data-testid="timings-drilldown-list"
              >
                {samples.length === 0 ? (
                  <EmptyState
                    title="No contributing games"
                    sub="This token has no samples in the current games."
                  />
                ) : (
                  <VirtualizedSampleList
                    samples={samples}
                    source={info.source || ""}
                    onOpenGame={onOpenGame}
                  />
                )}
              </div>
              <footer className="flex items-center gap-2 px-5 py-3 border-t border-base-700">
                <button
                  ref={copyBtnRef}
                  type="button"
                  onClick={copyAsMarkdown}
                  className={
                    "text-xs px-3 py-1.5 rounded ring-soft transition-colors " +
                    (copyState === "copied"
                      ? "bg-win-500/20 text-win-500"
                      : copyState === "error"
                        ? "bg-loss-500/20 text-loss-500"
                        : "bg-base-700 hover:bg-base-700/70 text-neutral-300")
                  }
                  aria-label="Copy contributing games as Markdown"
                  title="Copies a Markdown table of every contributing game to your clipboard."
                >
                  {copyLabel}
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="ml-auto text-xs px-3 py-1.5 rounded ring-soft
                         bg-base-700 hover:bg-base-700/70 text-neutral-300"
                >
                  Close
                </button>
              </footer>
            </aside>
          </div>
        );
      }
      function _format_seconds_safe(s) {
        if (s == null) return "—";
        const n = Math.max(0, Math.floor(s));
        return Math.floor(n / 60) + ":" + String(n % 60).padStart(2, "0");
      }

      /**
       * IntersectionObserver-based virtual list for the drilldown samples.
       *
       * react-window isn't a dependency of this SPA (see package.json), so
       * this is a hand-rolled windowing pattern: render lightweight
       * placeholder rows for everything outside the viewport, swap in the
       * full row template for items the IntersectionObserver flags as
       * visible. Cuts initial DOM cost on opponents with hundreds of
       * contributing games while keeping native scroll (no virtual height
       * math, no jumpy scrollbar).
       */
      function VirtualizedSampleList({ samples, source, onOpenGame }) {
        const containerRef = useRef(null);
        const [visible, setVisible] = useState(() => {
          // Pre-flag the first 30 rows visible so the user sees something
          // immediately while the observer wires up.
          const set = new Set();
          for (let i = 0; i < Math.min(30, samples.length); i++) set.add(i);
          return set;
        });
        useEffect(() => {
          // Reset when the sample set changes (e.g. switching matchup chip).
          const set = new Set();
          for (let i = 0; i < Math.min(30, samples.length); i++) set.add(i);
          setVisible(set);
        }, [samples]);
        useEffect(() => {
          const root = containerRef.current;
          if (!root) return undefined;
          // No IntersectionObserver in the (rare) ancient browser case ->
          // render everything. Better to pay the DOM cost once than to
          // silently hide rows.
          if (typeof IntersectionObserver === "undefined") {
            const all = new Set();
            for (let i = 0; i < samples.length; i++) all.add(i);
            setVisible(all);
            return undefined;
          }
          const io = new IntersectionObserver(
            (entries) => {
              setVisible((prev) => {
                let changed = false;
                const next = new Set(prev);
                for (const e of entries) {
                  const i = parseInt(e.target.dataset.idx, 10);
                  if (Number.isNaN(i)) continue;
                  if (e.isIntersecting && !next.has(i)) {
                    next.add(i);
                    changed = true;
                  }
                }
                return changed ? next : prev;
              });
            },
            { root, rootMargin: "200px 0px", threshold: 0.01 },
          );
          // Observe every placeholder once it's mounted. Querying the DOM
          // here keeps the observer in sync with React renders without
          // forcing each row to wire up its own ref.
          const stubs = root.querySelectorAll("[data-virtual-row]");
          stubs.forEach((s) => io.observe(s));
          return () => io.disconnect();
        }, [samples]);

        const srcShort = source === "opp_build_log" ? "opp_log" : "my_log";

        return (
          <ul
            ref={containerRef}
            className="divide-y divide-base-700"
            data-testid="timings-drilldown-virtual-list"
          >
            {samples.map((s, i) => {
              const key = (s.gameId || "g") + ":" + i;
              if (!visible.has(i)) {
                // Placeholder: same vertical footprint as a real row so the
                // scrollbar tracks correctly. Carries the data-idx the
                // observer needs to flip it visible.
                return (
                  <li
                    key={key}
                    data-virtual-row
                    data-idx={i}
                    className="h-[58px]"
                    aria-hidden="true"
                  />
                );
              }
              const isWin =
                s.result === "Win" || s.result === "Victory" || !!s.won;
              const isLoss =
                s.result === "Loss" ||
                s.result === "Defeat" ||
                (!isWin && s.won === false);
              const pillBg = isWin ? "#3ddc97" : isLoss ? "#ef476f" : "#9aa3b2";
              const canOpen = !!s.gameId && typeof onOpenGame === "function";
              const onRowClick = canOpen
                ? () => onOpenGame(s.gameId)
                : undefined;
              return (
                <li
                  key={key}
                  data-virtual-row
                  data-idx={i}
                  role={canOpen ? "button" : undefined}
                  tabIndex={canOpen ? 0 : -1}
                  onClick={onRowClick}
                  onKeyDown={
                    canOpen
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onRowClick();
                          }
                        }
                      : undefined
                  }
                  className={
                    "px-5 py-3 hover:bg-base-700/40 focus-within:bg-base-700/40 " +
                    (canOpen ? "cursor-pointer" : "")
                  }
                >
                  <div className="flex items-center gap-3 text-sm">
                    <span className="font-mono tabular-nums text-neutral-200 w-12">
                      {s.display || _format_seconds_safe(s.seconds)}
                    </span>
                    <span
                      className="text-neutral-300 truncate flex-1"
                      title={s.map || ""}
                    >
                      {s.map || "—"}
                    </span>
                    <span
                      className={raceClass(s.myRace) + " text-xs font-mono"}
                    >
                      {(s.myRace || "?")[0].toUpperCase()}
                    </span>
                    <span className="text-neutral-600 text-xs">vs</span>
                    <span
                      className={raceClass(s.oppRace) + " text-xs font-mono"}
                    >
                      {(s.oppRace || "?")[0].toUpperCase()}
                    </span>
                    <span
                      className="text-[10px] font-semibold tabular-nums px-1.5 py-0.5 rounded text-white"
                      style={{ background: pillBg }}
                      title={isWin ? "Win" : isLoss ? "Loss" : "Result unknown"}
                    >
                      {isWin ? "W" : isLoss ? "L" : "?"}
                    </span>
                  </div>
                  <div
                    className="mt-1 flex items-center justify-between
                              text-[11px] text-neutral-500"
                  >
                    <span title={s.date} className="font-mono">
                      {fmtRelDate(s.date)} ·{" "}
                      {String(s.date || "").slice(0, 10) || "—"}
                    </span>
                    <span className="flex items-center gap-2">
                      <span
                        className="text-[10px] uppercase tracking-wider text-neutral-500
                               px-1.5 py-0.5 rounded bg-base-700"
                        title={
                          source === "opp_build_log"
                            ? "parsed from opponent's build log (sc2reader)"
                            : "parsed from your build log"
                        }
                      >
                        {srcShort}
                      </span>
                      {canOpen ? (
                        <span
                          className="text-accent-400 hover:text-accent-500
                                     underline decoration-dotted underline-offset-2"
                          aria-hidden="true"
                        >
                          open game →
                        </span>
                      ) : null}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        );
      }

  // Expose to global so inline-block JSX in index.html can render
  // these as bare identifiers.
  Object.assign(window, {
    StrategyTendencyChart,
    TimingsDrilldownDrawer,
    VirtualizedSampleList
  });
})();
