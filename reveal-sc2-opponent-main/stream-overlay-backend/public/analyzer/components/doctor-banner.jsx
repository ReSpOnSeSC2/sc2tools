/**
 * DoctorBanner — startup-diagnostics surface for the SPA.
 *
 * Loaded from index.html via:
 *   <script type="text/babel" data-presets="react" src="..."></script>
 *
 * Polls /api/doctor/check on mount and every 30s. Renders one row
 * per failing check with a Fix button. Per-row dismiss is persisted
 * in localStorage keyed on a coarse timestamp bucket so the row
 * reappears after the next state change (and after the user
 * actually re-runs the launcher).
 *
 * Fix actions (server's check.fix.kind):
 *   - 'rerun_launcher' -> copy-to-clipboard hint (no auto-shell-out;
 *      the SPA must never spawn arbitrary local processes).
 *   - 'open_wizard'    -> dispatches a 'sc2:open-wizard' window event
 *      that App listens for and calls setShowWizard(true).
 *   - 'open_settings'  -> dispatches 'sc2:open-tab' with tab='settings'
 *      so App can switch the active tab.
 *
 * Friend's-install fix: replaces the silent "No data" failure mode
 * with an actionable banner the user can fix without docs.
 */
(function () {
  "use strict";
  const React = window.React;
  const { useState, useEffect, useCallback, useRef } = React;

  const POLL_INTERVAL_MS = 30 * 1000;
  const DISMISS_BUCKET_MS = 6 * 60 * 60 * 1000; // 6h
  const FIX_HINT_LAUNCHER =
    "Re-run START_SC2_TOOLS.bat -- it will reinstall any missing " +
    "Node and Python dependencies.";

  function dismissKey(checkId, generatedAt) {
    const bucket = Math.floor(
      new Date(generatedAt || 0).getTime() / DISMISS_BUCKET_MS
    );
    return `doctor.dismissed.${checkId}.${bucket}`;
  }

  function isDismissed(checkId, generatedAt) {
    try {
      return localStorage.getItem(dismissKey(checkId, generatedAt)) === "1";
    } catch (_e) {
      return false;
    }
  }

  function markDismissed(checkId, generatedAt) {
    try {
      localStorage.setItem(dismissKey(checkId, generatedAt), "1");
    } catch (_e) {
      /* private mode / quota -- best effort */
    }
  }

  function statusStyle(status) {
    if (status === "err") {
      return "border-loss-500/50 bg-loss-500/10 text-loss-500";
    }
    return "border-warn-500/50 bg-warn-500/10 text-warn-500";
  }

  function FixButton({ check, onAction }) {
    const fix = check.fix;
    if (!fix) return null;
    if (fix.kind === "rerun_launcher") {
      return (
        <button
          type="button"
          onClick={() => {
            try {
              navigator.clipboard.writeText("START_SC2_TOOLS.bat");
            } catch (_e) {
              /* HTTPS-only API; copy-to-clipboard is best-effort */
            }
            window.alert(FIX_HINT_LAUNCHER);
          }}
          className="px-2 py-1 text-xs uppercase tracking-wider rounded bg-base-700 hover:bg-base-600"
        >
          How to fix
        </button>
      );
    }
    if (fix.kind === "open_wizard") {
      return (
        <button
          type="button"
          onClick={() => {
            window.dispatchEvent(new CustomEvent("sc2:open-wizard"));
            onAction(check.id);
          }}
          className="px-2 py-1 text-xs uppercase tracking-wider rounded bg-accent-500/80 hover:bg-accent-500 text-white"
        >
          Open wizard
        </button>
      );
    }
    if (fix.kind === "open_settings") {
      return (
        <button
          type="button"
          onClick={() => {
            window.dispatchEvent(new CustomEvent("sc2:open-tab", {
              detail: { tab: "settings", subtab: fix.target || null },
            }));
            onAction(check.id);
          }}
          className="px-2 py-1 text-xs uppercase tracking-wider rounded bg-accent-500/80 hover:bg-accent-500 text-white"
        >
          Open settings
        </button>
      );
    }
    return null;
  }

  function DoctorBanner() {
    const [report, setReport] = useState(null);
    const [hidden, setHidden] = useState(new Set());
    const tickRef = useRef(0);

    const fetchOnce = useCallback(async (refresh) => {
      try {
        const url = refresh
          ? "/api/doctor/check?refresh=1"
          : "/api/doctor/check";
        const r = await fetch(url, { headers: { Accept: "application/json" } });
        if (!r.ok) return;
        const json = await r.json();
        setReport(json);
      } catch (_e) {
        /* doctor endpoint missing/offline -- banner stays hidden */
      }
    }, []);

    useEffect(() => {
      let alive = true;
      fetchOnce(false).then(() => {
        if (!alive) return;
        const id = window.setInterval(() => {
          tickRef.current += 1;
          fetchOnce(false);
        }, POLL_INTERVAL_MS);
        return () => window.clearInterval(id);
      });
      return () => { alive = false; };
    }, [fetchOnce]);

    const onDismiss = useCallback((checkId) => {
      if (!report) return;
      markDismissed(checkId, report.generated_at);
      setHidden((prev) => {
        const next = new Set(prev);
        next.add(checkId);
        return next;
      });
    }, [report]);

    if (!report || !Array.isArray(report.checks)) return null;
    const generatedAt = report.generated_at;
    const visible = report.checks.filter(
      (c) => c.status !== "ok"
        && !hidden.has(c.id)
        && !isDismissed(c.id, generatedAt)
    );
    if (visible.length === 0) return null;

    return (
      <div className="space-y-1 px-4 pt-2">
        {visible.map((check) => (
          <div
            key={check.id}
            className={
              "flex items-center justify-between gap-3 rounded border px-3 py-2 text-sm "
              + statusStyle(check.status)
            }
          >
            <div className="flex-1 min-w-0">
              <div className="font-semibold uppercase tracking-wider text-[11px]">
                {check.title}
              </div>
              <div className="text-neutral-200/90 mt-0.5 break-words">
                {check.summary}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <FixButton check={check} onAction={onDismiss} />
              <button
                type="button"
                onClick={() => onDismiss(check.id)}
                className="px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200"
                title="Dismiss"
              >
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
    );
  }

  Object.assign(window, { DoctorBanner });
})();
