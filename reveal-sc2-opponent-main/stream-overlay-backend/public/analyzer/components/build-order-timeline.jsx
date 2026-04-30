/**
 * BuildOrderTimeline — extracted from index.html.
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

      function BuildOrderTimeline({ gameId, perspective: perspectiveProp }) {
        const [data, setData] = useState(null);
        const [loading, setLoading] = useState(true);
        const [error, setError] = useState(null);
        const [showAll, setShowAll] = useState(false);
        const [filter, setFilter] = useState("all");
        // 'opponent' shows the opponent's build, 'me' shows the user's. The
        // OpponentProfile passes perspective="opponent" so that drawer
        // defaults to the OPPONENT'S build (which is the entire point of
        // viewing an opponent card). Other surfaces default to "me".
        const [perspective, setPerspective] = useState(perspectiveProp || "me");
        // Tracks the on-demand opponent-build extraction state. Older games
        // don't have opp_build_log persisted yet; clicking "Extract" POSTs
        // to /games/:id/opp-build-order, which re-parses the replay and
        // writes opp_build_log + opp_early_build_log back to meta_database.
        const [extracting, setExtracting] = useState(false);
        const [extractError, setExtractError] = useState(null);
        // Stage 7.5: build-editor modal state. The editor is opened
        // lazily via POST /api/custom-builds/from-game; we keep its
        // state local to this component so each opened drawer has
        // its own independent editor instance.
        const [editorOpen, setEditorOpen] = useState(false);
        const [editorDraft, setEditorDraft] = useState(null);
        const [editorLoading, setEditorLoading] = useState(false);
        const [editorProfileReady, setEditorProfileReady] = useState(true);
        const [editorError, setEditorError] = useState(null);
        // editorGame is a perspective-locked snapshot of the build-order
        // payload taken at openBuildEditor() time. The modal’s source-event
        // timeline + default-name helper read game.events and game.my_build,
        // so when wantOpp is true we feed a swapped copy (opp_events,
        // opp_strategy, etc.) without mutating the live `data` object.
        const [editorGame, setEditorGame] = useState(null);
        // Stage 6.5: leak-window focus state. When the spending efficiency
        // chart fires sc2:focus-build-order with a {start, end} window, we
        // store it here so the events list highlights everything inside
        // [start, end] and scrolls the first matching event into view.
        // Auto-clears after BUILD_ORDER_FOCUS_HOLD_MS so the highlight is
        // transient and doesn't persist across game switches.
        const [focusRange, setFocusRange] = useState(null);
        const eventsContainerRef = useRef(null);

        useEffect(() => {
          let cancelled = false;
          setLoading(true);
          setError(null);
          fetch(`${API}/games/${encodeURIComponent(gameId)}/build-order`)
            .then((r) =>
              r.ok ? r.json() : r.json().then((j) => Promise.reject(j)),
            )
            .then((j) => {
              if (!cancelled) {
                setData(j);
                setLoading(false);
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

        // Stage 6.5: subscribe to the leak-band click event from the
        // SpendingEfficiencyChart. Filter by gameId so multiple
        // BuildOrderTimeline instances (e.g. user vs opponent drawers)
        // don't all react to the same click.
        useEffect(() => {
          const BUILD_ORDER_FOCUS_HOLD_MS = 4000;
          const SCROLL_AFTER_PAINT_MS = 60;
          let clearTimer = null;
          const handler = (ev) => {
            const detail = ev && ev.detail;
            if (!detail || detail.gameId !== gameId) return;
            const startSec = Number(detail.start) || 0;
            const endSec = Number(detail.end) || 0;
            if (endSec <= startSec) return;
            setFocusRange({ start: startSec, end: endSec });
            // Defer the scroll to next paint so React has flushed the
            // data-leak-focused attribute onto the matching rows.
            setTimeout(() => {
              const container = eventsContainerRef.current;
              if (!container) return;
              const target = container.querySelector(
                '[data-leak-focused="true"]',
              );
              if (target && target.scrollIntoView) {
                target.scrollIntoView({ behavior: "smooth", block: "center" });
              }
            }, SCROLL_AFTER_PAINT_MS);
            if (clearTimer) clearTimeout(clearTimer);
            clearTimer = setTimeout(
              () => setFocusRange(null),
              BUILD_ORDER_FOCUS_HOLD_MS,
            );
          };
          window.addEventListener("sc2:focus-build-order", handler);
          return () => {
            window.removeEventListener("sc2:focus-build-order", handler);
            if (clearTimer) clearTimeout(clearTimer);
          };
        }, [gameId]);

        if (loading)
          return (
            <div className="text-xs text-neutral-500 px-3 py-2">
              loading build order…
            </div>
          );
        if (error)
          return (
            <div className="text-xs text-loss-500 px-3 py-2">
              build-order unavailable: {error}
            </div>
          );
        if (!data) return null;

        const myAllEvents = data.events || [];
        const myEarlyEvents = data.early_events || [];
        const oppAllEvents = data.opp_events || [];
        const oppEarlyEvents = data.opp_early_events || [];
        const oppAvailable =
          !!data.opp_build_available && oppAllEvents.length > 0;

        // Effective perspective: if the caller asked for the opponent's
        // build but we don't have it yet, surface the extract affordance
        // instead of silently flipping back to the user's build.
        const wantOpp = perspective === "opponent";
        const allEvents = wantOpp ? oppAllEvents : myAllEvents;
        const earlyEvents = wantOpp ? oppEarlyEvents : myEarlyEvents;
        const events = showAll ? allEvents : earlyEvents;
        const filtered =
          filter === "all"
            ? events
            : filter === "buildings"
              ? events.filter((e) => e.is_building)
              : filter === "units"
                ? events.filter(
                    (e) => !e.is_building && e.category !== "upgrade",
                  )
                : events.filter((e) => e.category === "upgrade");

        const myRace = data.my_race || data.myRace || "";
        const oppName = data.opponent || "";
        const oppRace = (data.opp_race || "").toString();
        const headerLabel = wantOpp
          ? `${oppName || "Opponent"}'s Build${oppRace ? ` (${oppRace})` : ""}`
          : `Your Build${myRace ? ` (${myRace})` : ""}${oppName ? ` vs ${oppName}` : ""}${oppRace ? ` [${oppRace.charAt(0).toUpperCase()}]` : ""}`;

        const extractOppBuild = () => {
          setExtracting(true);
          setExtractError(null);
          fetch(`${API}/games/${encodeURIComponent(gameId)}/opp-build-order`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          })
            .then((r) =>
              r.ok ? r.json() : r.json().then((j) => Promise.reject(j)),
            )
            .then((j) => {
              // Merge the freshly-extracted events into local state so the
              // timeline rerenders without a full refetch.
              setData((d) =>
                Object.assign({}, d, {
                  opp_events: j.opp_events || [],
                  opp_early_events: j.opp_early_events || [],
                  opp_build_available: (j.opp_events || []).length > 0,
                  opp_race: j.opp_race || (d && d.opp_race),
                }),
              );
              setExtracting(false);
              setPerspective("opponent");
            })
            .catch((e) => {
              setExtractError(e.error || String(e));
              setExtracting(false);
            });
        };

        // Stage 7.5: open the build editor with a server-derived
        // draft. Probes /api/profile/exists first so the editor knows
        // whether to disable the Save button (profile.json is required
        // for community attribution). Errors are surfaced inline rather
        // than thrown so the timeline stays responsive.
        const openBuildEditor = () => {
          setEditorLoading(true);
          setEditorError(null);
          // Perspective-locked snapshot fed to BuildEditorModal so its
          // source-event timeline and default-name helper reflect whose
          // build is being saved (opponent vs. me) at the moment the
          // editor was opened. We swap fields rather than mutating data.
          const editorGameSnapshot = wantOpp
            ? Object.assign({}, data, {
                events: oppAllEvents,
                early_events: oppEarlyEvents,
                my_race: (data && data.opp_race) || "",
                opp_race: (data && data.my_race) || "",
                my_build: (data && data.opp_strategy) || "",
                opp_strategy: (data && data.my_build) || "",
              })
            : data;
          setEditorGame(editorGameSnapshot);
          const sourceEvents = wantOpp ? oppAllEvents : myAllEvents;
          const draftBody = {
            // Pass events directly so the backend skips a meta DB
            // lookup. Each event maps {time,name,...} -> {t,what} on
            // the server side via parseLogLine.
            events: (sourceEvents || []).map((e) => ({
              t: Number(e && e.time) || 0,
              what: (window.BuildEditorHelpers ? window.BuildEditorHelpers.spaEventToWhat(e) : null) || (e && e.name) || "",
            })).filter((ev) => ev.what && /^[A-Za-z][A-Za-z0-9]*$/.test(ev.what)),
            name: window.BuildEditorHelpers ? window.BuildEditorHelpers.deriveDefaultName(editorGameSnapshot) : "Custom build",
            race: wantOpp ? (data && data.opp_race) || "Protoss" : (data && data.my_race) || "Protoss",
            vs_race: wantOpp ? (data && data.my_race) || "Random" : (data && data.opp_race) || "Random",
            source_replay_id: gameId,
            game_id: gameId,
          };
          const probeProfile = fetch("/api/profile/exists")
            .then((r) => (r.ok ? r.json() : { exists: false }))
            .then((j) => setEditorProfileReady(!!(j && (j.exists || j.profile_exists))))
            .catch(() => setEditorProfileReady(false));
          const fromGame = fetch("/api/custom-builds/from-game", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(draftBody),
          })
            .then((r) => (r.ok ? r.json() : r.json().then((j) => Promise.reject(j))))
            .then((j) => {
              setEditorDraft(j.draft || null);
              setEditorOpen(true);
            })
            .catch((e) => {
              setEditorError((e && e.error) || "Could not derive a draft from this game.");
            });
          Promise.all([probeProfile, fromGame]).finally(() => setEditorLoading(false));
        };

        // Empty-state branches.
        if (wantOpp && !oppAvailable) {
          return (
            <div className="bg-base-900 ring-soft rounded-lg p-3 my-2 border border-base-700">
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <span className="text-[11px] uppercase tracking-wider text-neutral-500">
                  {oppName || "Opponent"}'s Build
                  {oppRace ? ` (${oppRace})` : ""}
                </span>
                <div className="ml-auto flex items-center gap-1 text-xs">
                  <button
                    className="px-2 py-0.5 rounded bg-base-700 text-neutral-300"
                    onClick={() => setPerspective("me")}
                  >
                    Show your build
                  </button>
                </div>
              </div>
              <div className="text-xs text-neutral-400 px-1 py-2">
                {extracting
                  ? "Re-parsing the replay file to pull the opponent’s build order…"
                  : "Opponent’s build order is not stored for this game yet."}
              </div>
              {extractError && (
                <div className="text-xs text-loss-500 px-1 pb-2">
                  Extract failed: {extractError}
                </div>
              )}
              <div className="flex items-center gap-2">
                <button
                  onClick={extractOppBuild}
                  disabled={extracting}
                  className="px-2.5 py-1 text-xs rounded bg-accent-500 text-white hover:opacity-90 disabled:opacity-50"
                  title="Re-parse the replay file to extract the opponent's build order."
                >
                  {extracting ? "Extracting…" : "Extract opponent build"}
                </button>
                <span className="text-[10px] text-neutral-500">
                  Requires the original .SC2Replay file to still be on disk (
                  {data.game_id ? `id ${data.game_id}` : "this game"}).
                </span>
              </div>
            </div>
          );
        }

        if (allEvents.length === 0) {
          return (
            <div className="text-xs text-neutral-500 px-3 py-2">
              No build_log on this game.
            </div>
          );
        }

        return (
          <div className="bg-base-900 ring-soft rounded-lg p-3 my-2 border border-base-700">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <span className="text-[11px] uppercase tracking-wider text-neutral-500">
                {headerLabel}
              </span>
              <span className="text-xs text-neutral-400">
                {showAll
                  ? `full · ${allEvents.length} events`
                  : `first 5 min · ${earlyEvents.length} events`}
              </span>
              {/* Perspective toggle -- shown whenever we have at least one
              of the two timelines. "Opponent" is highlighted by default
              when this drawer is opened from the opponent profile. */}
              <div className="flex items-center gap-1 text-xs">
                <button
                  className={`px-2 py-0.5 rounded ${wantOpp ? "bg-accent-500 text-white" : "bg-base-700 text-neutral-300"}`}
                  onClick={() => setPerspective("opponent")}
                  disabled={!oppAvailable}
                  title={
                    oppAvailable
                      ? ""
                      : "Opponent build not extracted for this game yet"
                  }
                >
                  Opponent
                </button>
                <button
                  className={`px-2 py-0.5 rounded ${!wantOpp ? "bg-accent-500 text-white" : "bg-base-700 text-neutral-300"}`}
                  onClick={() => setPerspective("me")}
                >
                  You
                </button>
              </div>
              <div className="ml-auto flex items-center gap-1 text-xs">
                {/* Stage 7.5: Save as new build CTA. Hidden when the
                    build-editor module failed to load; disabled while a
                    /from-game request is in flight or when the timeline
                    has zero mappable events. */}
                {window.BuildEditorModal && (
                  <button
                    className="px-2 py-0.5 rounded bg-accent-500 text-white hover:opacity-90 disabled:opacity-50 mr-1"
                    onClick={openBuildEditor}
                    disabled={editorLoading || allEvents.length === 0}
                    title={
                      allEvents.length === 0
                        ? "No events on this game to save."
                        : "Open the editor to save these events as a custom build matchable across your library."
                    }
                  >
                    {editorLoading ? "Loading…" : "Save as new build"}
                  </button>
                )}
                {editorError && (
                  <span
                    className="text-[10px] text-loss-500 mr-1"
                    aria-live="polite"
                  >
                    {editorError}
                  </span>
                )}
                <button
                  className={`px-2 py-0.5 rounded ${filter === "all" ? "bg-accent-500 text-white" : "bg-base-700 text-neutral-300"}`}
                  onClick={() => setFilter("all")}
                >
                  All
                </button>
                <button
                  className={`px-2 py-0.5 rounded ${filter === "buildings" ? "bg-accent-500 text-white" : "bg-base-700 text-neutral-300"}`}
                  onClick={() => setFilter("buildings")}
                >
                  Buildings
                </button>
                <button
                  className={`px-2 py-0.5 rounded ${filter === "units" ? "bg-accent-500 text-white" : "bg-base-700 text-neutral-300"}`}
                  onClick={() => setFilter("units")}
                >
                  Units
                </button>
                <button
                  className={`px-2 py-0.5 rounded ${filter === "upgrades" ? "bg-accent-500 text-white" : "bg-base-700 text-neutral-300"}`}
                  onClick={() => setFilter("upgrades")}
                >
                  Upgrades
                </button>
                <button
                  className="px-2 py-0.5 rounded bg-base-700 text-neutral-300 ml-2"
                  onClick={() => setShowAll((s) => !s)}
                >
                  {showAll ? "Show 5 min" : "Show all"}
                </button>
              </div>
            </div>
            {!wantOpp && (
              <div className="text-[10px] text-neutral-500 mb-2">
                This is YOUR build (captured from the replay). Switch to
                "Opponent" to see {oppName || "their"} build.
                {oppName
                  ? ` Detected strategy: "${data.opp_strategy || "—"}".`
                  : ""}
              </div>
            )}
            {wantOpp && (
              <div className="text-[10px] text-neutral-500 mb-2">
                {oppName || "Opponent"}'s deduped first-5-min milestones.
                Detected strategy: "{data.opp_strategy || "—"}".
              </div>
            )}
            <div
              ref={eventsContainerRef}
              className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5 max-h-[420px] overflow-y-auto"
            >
              {filtered.map((e, i) => {
                const t = Number(e && e.time) || 0;
                const inFocus =
                  focusRange &&
                  t >= focusRange.start &&
                  t <= focusRange.end;
                const rowClass = inFocus
                  ? "flex items-center gap-2 rounded px-2 py-1 ring-1 ring-loss-500 bg-loss-500/15 transition-colors"
                  : "flex items-center gap-2 bg-base-800 rounded px-2 py-1";
                return (
                <div
                  key={i}
                  className={rowClass}
                  data-leak-focused={inFocus ? "true" : undefined}
                  data-build-event-time={t}
                >
                  <span className="font-mono text-[11px] text-neutral-400 w-10 tabular-nums">
                    {e.time_display}
                  </span>
                  <span
                    className={`inline-block w-2 h-2 rounded-full ${RACE_DOT_CLASS[e.race] || RACE_DOT_CLASS.Neutral}`}
                  />
                  <span
                    className="text-sm text-neutral-200 flex-1 truncate"
                    title={e.name}
                  >
                    {e.display}
                  </span>
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded ${CATEGORY_BADGE_CLASS[e.category] || CATEGORY_BADGE_CLASS.unknown}`}
                  >
                    {e.category}
                  </span>
                </div>
                );
              })}
            </div>
            {filtered.length === 0 && (
              <div className="text-xs text-neutral-500 px-2 py-3">
                No events match this filter.
              </div>
            )}
            {/* Stage 7.5: BuildEditorModal lives in
                /static/analyzer/components/build-editor-modal.js and
                attaches to window.BuildEditorModal. Mounted inside the
                timeline so closing/restoring focus stays correct. */}
            {editorOpen && window.BuildEditorModal &&
              React.createElement(window.BuildEditorModal, {
                open: editorOpen,
                game: editorGame || data,
                gameId: gameId,
                draft: editorDraft,
                profileReady: editorProfileReady,
                onClose: () => { setEditorOpen(false); setEditorGame(null); },
                onSaved: () => {},
                socket: typeof window !== "undefined" ? window.__sc2_socket : null,
              })}
          </div>
        );
      }

  // Expose to global so inline-block JSX in index.html can render
  // these as bare identifiers.
  Object.assign(window, {
    BuildOrderTimeline
  });
})();
