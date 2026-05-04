/**
 * Empty-state CTAs for the Opponents and My Builds tabs.
 *
 * Friend's-install fix: replaces the silent <EmptyState title="No data" />
 * render with an actionable panel that branches on the actual reason
 * the tab is empty. The user gets a button, not a shrug.
 *
 * OpponentsEmptyState branches:
 *   1. config.json missing  -> "Set up your character ID" (opens wizard).
 *   2. Poller available     -> "Start the SC2Pulse poller" (POSTs
 *                              /api/runtime/restart-poller).
 *   3. Otherwise            -> coaching: "Play a ranked game".
 *
 * BuildsEmptyState branches:
 *   1. /api/analyzer/summary totals.total === 0 -> "Import your replays"
 *      (switches to Settings -> Import).
 *   2. Otherwise -> "No games match your filters" + Reset filters button.
 *
 * Lightweight module-scoped 30s cache fronts the diagnostics fetches
 * so a tab-switch storm doesn't hammer the backend. Each component
 * has its own dependency set; both share the cache map.
 *
 * Loaded from index.html via:
 *   <script type="text/babel" data-presets="react" src="..."></script>
 */
(function () {
  "use strict";
  const React = window.React;
  const { useState, useEffect, useCallback } = React;

  const CACHE_TTL_MS = 30 * 1000;
  const cache = new Map();

  async function cachedFetchJson(url) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.v;
    try {
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      if (!r.ok) {
        // 404 on /api/profile/exists is meaningful (= not configured),
        // so cache the negative answer rather than re-fetching every render.
        const v = { __status: r.status };
        cache.set(url, { t: Date.now(), v });
        return v;
      }
      const v = await r.json();
      cache.set(url, { t: Date.now(), v });
      return v;
    } catch (_e) {
      return null;
    }
  }

  function clearCache() {
    cache.clear();
  }

  function CtaPanel({ title, body, primary, secondary }) {
    return (
      <div className="px-6 py-10 text-center">
        <div className="text-base font-semibold text-neutral-100 mb-1">
          {title}
        </div>
        {body && (
          <div className="text-sm text-neutral-400 max-w-md mx-auto mb-4">
            {body}
          </div>
        )}
        <div className="flex items-center justify-center gap-2">
          {primary && (
            <button
              type="button"
              onClick={primary.onClick}
              disabled={!!primary.disabled}
              className={
                "px-3 py-1.5 text-xs uppercase tracking-wider rounded "
                + (primary.disabled
                  ? "bg-base-700 text-neutral-500 cursor-default"
                  : "bg-accent-500 hover:bg-accent-400 text-white")
              }
            >
              {primary.label}
            </button>
          )}
          {secondary && (
            <button
              type="button"
              onClick={secondary.onClick}
              className="px-3 py-1.5 text-xs uppercase tracking-wider rounded bg-base-700 hover:bg-base-600 text-neutral-200"
            >
              {secondary.label}
            </button>
          )}
        </div>
      </div>
    );
  }

  function openWizard() {
    window.dispatchEvent(new CustomEvent("sc2:open-wizard"));
  }

  function openSettings(subtab) {
    window.dispatchEvent(new CustomEvent("sc2:open-tab", {
      detail: { tab: "settings", subtab: subtab || null },
    }));
  }

  function OpponentsEmptyState() {
    const [profileMissing, setProfileMissing] = useState(null);
    const [pollerReady, setPollerReady] = useState(null);
    const [pollerPid, setPollerPid] = useState(null);
    const [pollerErr, setPollerErr] = useState(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
      let cancelled = false;
      (async () => {
        const exists = await cachedFetchJson("/api/profile/exists");
        if (cancelled) return;
        if (exists && exists.__status === 404) setProfileMissing(true);
        else if (exists && exists.exists === false) setProfileMissing(true);
        else setProfileMissing(false);
        const status = await cachedFetchJson("/api/runtime/status");
        if (cancelled) return;
        setPollerReady(!!(status && status.can_restart_poller));
      })();
      return () => { cancelled = true; };
    }, []);

    const startPoller = useCallback(async () => {
      setBusy(true); setPollerErr(null);
      try {
        const r = await fetch("/api/runtime/restart-poller", { method: "POST" });
        const j = await r.json();
        if (j && j.ok && j.pid) {
          setPollerPid(j.pid);
        } else {
          setPollerErr((j && j.error) || `request failed (${r.status})`);
        }
      } catch (e) {
        setPollerErr(String(e && e.message || e));
      } finally {
        setBusy(false);
      }
    }, []);

    if (profileMissing) {
      return (
        <CtaPanel
          title="No opponents tracked yet"
          body="Set up your SC2Pulse character ID first -- the poller needs it to know which account's matches to watch."
          primary={{ label: "Set up character ID", onClick: openWizard }}
          secondary={{ label: "Open settings", onClick: () => openSettings("profile") }}
        />
      );
    }

    if (pollerReady && pollerPid == null) {
      return (
        <CtaPanel
          title="No opponents tracked yet"
          body={
            pollerErr
              ? `Last attempt failed: ${pollerErr}`
              : "The SC2Pulse poller isn't running. Start it now to begin tracking opponents."
          }
          primary={{
            label: busy ? "Starting..." : "Start poller",
            disabled: busy,
            onClick: startPoller,
          }}
          secondary={{ label: "Open settings", onClick: () => openSettings("profile") }}
        />
      );
    }

    if (pollerPid != null) {
      return (
        <CtaPanel
          title="Poller started"
          body={`Started pid ${pollerPid}. Play a ranked game and opponents will appear here automatically.`}
        />
      );
    }

    return (
      <CtaPanel
        title="No opponents tracked yet"
        body="Play a ranked SC2 game -- opponents are added to this list automatically as the poller picks them up."
      />
    );
  }

  function BuildsEmptyState({ filters }) {
    const [totalGames, setTotalGames] = useState(null);
    const filtersActive = filters && Object.keys(filters || {}).length > 0;

    useEffect(() => {
      let cancelled = false;
      (async () => {
        const summary = await cachedFetchJson("/api/summary");
        if (cancelled || !summary) return;
        const total = (summary.totals && summary.totals.total)
          || summary.total
          || 0;
        setTotalGames(Number(total) || 0);
      })();
      return () => { cancelled = true; };
    }, []);

    if (totalGames === 0) {
      return (
        <CtaPanel
          title="No games imported yet"
          body="Import your historical replays to populate builds, opponents, and macro scores. The bulk import scans your Replays folder once and then the live watcher keeps it fresh."
          primary={{
            label: "Import replays",
            onClick: () => openSettings("import"),
          }}
        />
      );
    }

    if (filtersActive) {
      return (
        <CtaPanel
          title="No builds match your filters"
          body="Try widening the date range or clearing race / map filters."
          primary={{
            label: "Reset filters",
            onClick: () => {
              window.dispatchEvent(new CustomEvent("sc2:reset-filters"));
            },
          }}
        />
      );
    }

    return (
      <CtaPanel
        title="No builds detected yet"
        body="Builds appear here after the deep-parse classifier tags your games. New replays are processed automatically."
      />
    );
  }

  Object.assign(window, {
    OpponentsEmptyState,
    BuildsEmptyState,
    __sc2EmptyStatesClearCache: clearCache,
  });
})();
