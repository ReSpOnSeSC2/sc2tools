/**
 * Settings import helpers — extracted from index.html for size-rule compliance.
 *
 * Loaded from index.html via:
 *   <script type="text/babel" data-presets="react" src="..."></script>
 *
 * Babel-standalone compiles JSX in this file before execution.
 * The IIFE wrapper isolates lexical scope from the inline block in
 * index.html (which has its own `const { useState, ... } = React;`),
 * preventing redeclaration errors. Each exported component / helper
 * is attached to `window` at the bottom so the inline block's bare
 * JSX identifiers (e.g. `<SettingsView />`) resolve via the global
 * object at render time.
 *
 * DO NOT EDIT THE EXTRACTED BODY HERE WITHOUT ALSO UPDATING THE
 * MATCHING SECTION IN index.html — the two MUST NOT BOTH EXIST.
 */
(function () {
  "use strict";
  const React = window.React;
  const { useState, useEffect, useMemo, useCallback, useRef, Fragment } = React;

      // ============================================================
      // SETTINGS — IMPORT HISTORICAL REPLAYS (Stage 7-ish)
      //
      // Bulk-imports a folder of .SC2Replay files via the
      // /api/analyzer/import/* endpoints. Lets the user dial worker
      // count from 1 → cpu_count (default min(8, cpu_count)). Shows
      // live progress, supports cancel, and surfaces interrupted
      // jobs (server-killed mid-import) so the user can resume.
      //
      // Used in two places:
      //   - This Settings panel (any-time use)
      //   - The wizard (optional onboarding step) — same component
      // ============================================================
      const IMPORT_DATE_PRESETS = [
        { id: "30d",  label: "Last 30 days",   days: 30   },
        { id: "90d",  label: "Last 90 days",   days: 90   },
        { id: "1y",   label: "Last year",      days: 365  },
        { id: "all",  label: "All time",       days: null },
        { id: "custom", label: "Custom range", days: null },
      ];
      const IMPORT_DEFAULT_RECOMMENDED_CAP = 8;
      const IMPORT_PROGRESS_POLL_MS = 1000;

      function _importFmtDate(dt) {
        if (!dt) return "";
        const d = (dt instanceof Date) ? dt : new Date(dt);
        if (isNaN(d.getTime())) return "";
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        return `${y}-${m}-${dd}`;
      }

      function _importComputeSinceIso(presetId, customSince) {
        if (presetId === "all") return "";
        if (presetId === "custom") return customSince || "";
        const preset = IMPORT_DATE_PRESETS.find(p => p.id === presetId);
        if (!preset || !preset.days) return "";
        const d = new Date();
        d.setDate(d.getDate() - preset.days);
        return _importFmtDate(d);
      }

      function _importComputeUntilIso(presetId, customUntil) {
        if (presetId === "custom") return customUntil || "";
        return "";
      }

      function _importEtaSec(completed, total, startedAt, workers) {
        if (!startedAt || completed <= 0 || total <= 0) return null;
        const elapsedMs = Date.now() - new Date(startedAt).getTime();
        if (elapsedMs <= 0) return null;
        const rate = completed / (elapsedMs / 1000);
        const remaining = total - completed;
        if (remaining <= 0 || rate <= 0) return 0;
        return Math.round(remaining / rate);
      }

      function _importFmtDuration(sec) {
        if (sec == null) return "—";
        if (sec < 60) return `${sec}s`;
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        if (m < 60) return `${m}m ${s}s`;
        const h = Math.floor(m / 60);
        return `${h}h ${m % 60}m`;
      }

      function ImportWorkerSlider({ value, cores, recommended, onChange,
                                    disabled }) {
        const overRecommended = value > recommended;
        return (
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <label htmlFor="import-workers"
                className="text-xs text-neutral-300">
                Worker count
              </label>
              <span className="text-xs tabular-nums text-neutral-200">
                {value} / {cores}
              </span>
            </div>
            <input id="import-workers" type="range"
              min={1} max={Math.max(1, cores)} step={1}
              value={value} disabled={disabled}
              onChange={(e) => onChange(parseInt(e.target.value, 10) || 1)}
              className="w-full accent-accent-500" />
            <div className="flex items-center justify-between text-[10px] text-neutral-500">
              <span>1</span>
              <span>Recommended: {recommended}</span>
              <span>{cores}</span>
            </div>
            {overRecommended && (
              <div className="text-[11px] text-gold-500" role="alert">
                ⚠ Using more than {recommended} cores can slow other apps
                and use significantly more RAM. Each worker holds ~250 MB
                while parsing.
              </div>
            )}
            <button type="button" onClick={() => onChange(cores)}
              disabled={disabled || value === cores}
              className="text-[11px] text-accent-500 hover:underline
                         disabled:opacity-50">
              Use all {cores} cores
            </button>
          </div>
        );
      }

      function ImportProgressBar({ completed, total }) {
        const pct = total > 0 ? Math.min(100, (100 * completed) / total) : 0;
        return (
          <div className="w-full bg-base-700 rounded h-2 overflow-hidden"
            role="progressbar"
            aria-valuenow={Math.round(pct)} aria-valuemin={0}
            aria-valuemax={100} aria-label="Import progress">
            <div className="h-full bg-accent-500 transition-all"
              style={{ width: `${pct}%` }} />
          </div>
        );
      }

      function _importDefaultFolder(pendingConfig) {
        const list = pendingConfig
          && pendingConfig.paths
          && pendingConfig.paths.replay_folders;
        return Array.isArray(list) && list.length > 0 ? list[0] : "";
      }

      function _useImportCores() {
        const [cores, setCores] = useState(1);
        const [recommended, setRecommended] = useState(1);
        useEffect(() => {
          let cancelled = false;
          fetch(`${API}/import/cores`)
            .then((r) => r.ok ? r.json() : Promise.reject())
            .then((j) => {
              if (cancelled) return;
              setCores(Number(j.cores) || 1);
              setRecommended(Number(j.recommended)
                || Math.min(IMPORT_DEFAULT_RECOMMENDED_CAP,
                            Number(j.cores) || 1));
            })
            .catch(() => { /* fall through with defaults */ });
          return () => { cancelled = true; };
        }, []);
        return { cores, recommended };
      }

      function _useImportStatus() {
        // Polls /import/status continuously while the panel is mounted.
        // The previous version stopped polling on phase=idle, which
        // meant a Start click after the panel had been open for a
        // while showed no progress until next mount. We always poll
        // now so transitions idle -> starting -> running -> complete
        // are picked up immediately.
        const [status, setStatus] = useState(null);
        useEffect(() => {
          let cancelled = false;
          let timer = null;
          const poll = () => {
            fetch(`${API}/import/status`)
              .then((r) => r.ok ? r.json() : Promise.reject())
              .then((j) => {
                if (cancelled) return;
                setStatus(j);
                timer = setTimeout(poll, IMPORT_PROGRESS_POLL_MS);
              })
              .catch(() => {
                if (!cancelled) timer = setTimeout(poll, 3000);
              });
          };
          poll();
          return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
          };
        }, []);
        return status;
      }

      // ============================================================
      // FOLDER IMPORT DRIVER
      //
      // Both the fresh-start path and the resume-from-checkpoint
      // path drive identical UI: a per-folder progress slot in
      // queue.folders[]. These helpers share that loop so resume
      // shows real-time progress (it used to fire-and-forget).
      //
      // The functions take setQueue + stopRef as args so they can
      // remain pure-async (no React hooks), live in helpers, and
      // be unit-testable.
      // ============================================================
      async function _drainImportRunning(apiBase, pollMs, timeoutS) {
        for (let w = 0; w < timeoutS; w++) {
          const s = await fetch(`${apiBase}/import/status`)
            .then((r) => r.json());
          if (!s.running) return;
          await new Promise((r) => setTimeout(r, pollMs));
        }
      }

      function _markFolderError(setQueue, folderIndex, errorMsg) {
        setQueue((q) => q ? { ...q,
          folders: q.folders.map((f, j) => j === folderIndex ? {
            ...f, status: "error", errorMsg,
          } : f),
        } : q);
      }

      function _markFolderProgress(setQueue, folderIndex, s) {
        setQueue((q) => q ? { ...q,
          folders: q.folders.map((f, j) => j === folderIndex ? {
            ...f, completed: s.completed || 0,
            total: s.total || 0, errors: s.errors || 0,
          } : f),
        } : q);
      }

      function _markFolderDone(setQueue, folderIndex, s, finalStatus) {
        setQueue((q) => q ? { ...q,
          folders: q.folders.map((f, j) => j === folderIndex ? {
            ...f, status: finalStatus,
            completed: s.completed || 0,
            total: s.total || 0,
            errors: s.errors || 0,
            errorBreakdown: s.error_breakdown || null,
            errorSamples: s.error_samples || null,
          } : f),
        } : q);
      }

      function _resolveFinalStatus(stopRefCurrent, phase) {
        if (stopRefCurrent || phase === "cancelled") return "cancelled";
        if (phase === "error") return "error";
        return "done";
      }

      async function _pollFolderImportUntilDone({
        setQueue, stopRef, folderIndex, apiBase, pollMs,
      }) {
        while (true) {
          await new Promise((r) => setTimeout(r, pollMs));
          const s = await fetch(`${apiBase}/import/status`)
            .then((r) => r.json());
          _markFolderProgress(setQueue, folderIndex, s);
          const isDone = !s.running && (
            s.phase === "complete"
            || s.phase === "cancelled"
            || s.phase === "error");
          if (isDone) {
            const finalStatus = _resolveFinalStatus(
              stopRef.current, s.phase);
            _markFolderDone(setQueue, folderIndex, s, finalStatus);
            if (finalStatus === "cancelled") stopRef.current = true;
            return finalStatus;
          }
          if (stopRef.current) {
            setQueue((q) => q ? { ...q,
              folders: q.folders.map((f, j) => j === folderIndex ? {
                ...f, status: "cancelled",
              } : f),
            } : q);
            return "cancelled";
          }
        }
      }

      /**
       * Drive a single folder import end-to-end.
       *
       * Drains any prior IMPORT_STATE.running, POSTs /import/start,
       * then polls /import/status updating queue.folders[folderIndex]
       * until the run completes, errors, or the user pressed Stop
       * (signalled via stopRef.current).
       *
       * Used for BOTH fresh start and resume — the body just gets
       * resume:true for the latter. Caller owns queue state and
       * decides which folders to process.
       *
       * Returns the final folder status: "done" | "error" | "cancelled".
       *
       * Example:
       *   await _runFolderImport({
       *     folder: "C:/Replays", body: { resume: true, workers: 4 },
       *     setQueue, stopRef, folderIndex: 0,
       *     apiBase: API, pollMs: 1000, betweenFolderTimeoutS: 10,
       *   });
       */
      async function _runFolderImport({
        folder, body, setQueue, stopRef, folderIndex,
        apiBase, pollMs, betweenFolderTimeoutS,
      }) {
        await _drainImportRunning(apiBase, pollMs, betweenFolderTimeoutS);
        const sr = await fetch(`${apiBase}/import/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ folder, ...body }),
        });
        if (!sr.ok) {
          const j = await sr.json().catch(() => ({}));
          _markFolderError(setQueue, folderIndex,
            j.error || `start failed (${sr.status})`);
          return "error";
        }
        return await _pollFolderImportUntilDone({
          setQueue, stopRef, folderIndex, apiBase, pollMs,
        });
      }

      const IMPORT_REASON_LABEL = {
        player_not_found:
          "Couldn't find your handle in the replay. The replay's player "
          + "name may have a clan tag or different display name.",
        no_opponent:
          "Solo or vs-AI replay (no human opponent in the lobby).",
        parse_failed:
          "Replay file is corrupt or unreadable by sc2reader.",
        worker_crash:
          "Worker process crashed while parsing this replay.",
        ambiguous_name:
          "Two or more players in the replay matched your name; "
          + "we couldn't tell which is you. Add your account ID "
          + "in Settings → Profile to disambiguate.",
        unknown:
          "Unspecified error. Check the sample message below.",
      };

      const REGION_LABEL = {
        us: "Americas (US)",
        eu: "Europe (EU)",
        kr: "Korea (KR)",
        cn: "China (CN)",
        sea: "South-East Asia",
      };

      function _identityKey(identity) {
        return (identity && identity.character_id)
          ? `cid:${identity.character_id}`
          : `name:${(identity && identity.name) || ""}`;
      }

      function _isAlreadyConfigured(discovered, configured) {
        if (!discovered || !discovered.character_id) return false;
        return (configured || []).some(
          (c) => c && c.character_id === discovered.character_id);
      }

      function ImportDiscoveredIdentitiesList({
        discovered, configured, picked, onTogglePick,
      }) {
        return (
          <ul className="space-y-1.5 max-h-64 overflow-y-auto">
            {discovered.map((row, i) => {
              const already = _isAlreadyConfigured(row, configured);
              const isPicked = picked.has(_identityKey(row));
              const cls = "flex items-center gap-2 p-2 rounded text-xs "
                + (already
                  ? "bg-base-900/40 opacity-60"
                  : isPicked
                    ? "bg-accent-500/20 border border-accent-500"
                    : "bg-base-800 hover:bg-base-700 cursor-pointer");
              return (
                <li key={i} className={cls}
                  onClick={() => !already && onTogglePick(row)}>
                  <input type="checkbox" disabled={already}
                    checked={already || isPicked}
                    onChange={() => !already && onTogglePick(row)}
                    className="accent-accent-500" />
                  <div className="flex-1 min-w-0">
                    <div className="text-neutral-100 font-medium truncate">
                      {row.name || "(no name)"}
                    </div>
                    <div className="text-[10px] text-neutral-500
                                    font-mono truncate">
                      {row.character_id || "(no character_id)"}
                      {row.region
                        ? " · " + (REGION_LABEL[row.region] || row.region)
                        : ""}
                      {" · seen in " + (row.count || 1) + " replay(s)"}
                    </div>
                  </div>
                  {already && (
                    <span className="text-[10px] text-neutral-500 ml-2">
                      already added
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        );
      }

      function ImportErrorBreakdown({ breakdown, samples }) {
        if (!breakdown || typeof breakdown !== "object") return null;
        const entries = Object.entries(breakdown)
          .filter(([, n]) => Number(n) > 0)
          .sort((a, b) => Number(b[1]) - Number(a[1]));
        if (entries.length === 0) return null;
        return (
          <div className="bg-base-800 rounded p-3 text-xs space-y-2">
            <div className="text-neutral-300 font-semibold">
              Why some replays were skipped
            </div>
            {entries.map(([reason, count]) => (
              <div key={reason} className="border-l-2 border-base-600 pl-2">
                <div className="text-neutral-200">
                  <span className="font-semibold tabular-nums">{count}</span>
                  {" "}
                  <span className="text-neutral-400">
                    {IMPORT_REASON_LABEL[reason]
                      || "Skipped (" + reason + ")."}
                  </span>
                </div>
                {samples && Array.isArray(samples[reason])
                  && samples[reason].length > 0 && (
                  <ul className="text-[10px] text-neutral-500 mt-1 space-y-0.5">
                    {samples[reason].slice(0, 2).map((s, i) => (
                      <li key={i} className="truncate">{s}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
            <div className="text-[10px] text-neutral-500 pt-1">
              Tip: if many show "couldn't find your handle", set your
              in-replay name in Settings → Profile to match what your
              replays actually show (case-insensitive substring is fine).
            </div>
          </div>
        );
      }


  // Expose to global so inline-block JSX in index.html can render
  // these as bare identifiers.
  Object.assign(window, {
    IMPORT_DATE_PRESETS,
    IMPORT_DEFAULT_RECOMMENDED_CAP,
    IMPORT_PROGRESS_POLL_MS,
    _importFmtDate,
    _importComputeSinceIso,
    _importComputeUntilIso,
    _importEtaSec,
    _importFmtDuration,
    ImportWorkerSlider,
    ImportProgressBar,
    _importDefaultFolder,
    _useImportCores,
    _useImportStatus,
    IMPORT_REASON_LABEL,
    REGION_LABEL,
    _identityKey,
    _isAlreadyConfigured,
    ImportDiscoveredIdentitiesList,
    ImportErrorBreakdown,
    _drainImportRunning,
    _markFolderError,
    _markFolderProgress,
    _markFolderDone,
    _resolveFinalStatus,
    _pollFolderImportUntilDone,
    _runFolderImport
  });
})();
