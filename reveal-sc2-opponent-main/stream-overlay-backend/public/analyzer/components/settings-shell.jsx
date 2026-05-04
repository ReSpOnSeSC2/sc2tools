/**
 * Settings shell — extracted from index.html for size-rule compliance.
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

      function SettingsActivePanel({ tab, pendingProfile, pendingConfig,
                                     errors, patchProfile, patchConfig,
                                     defs }) {
        if (!pendingProfile || !pendingConfig) return null;
        switch (tab) {
          case "profile":
            return <SettingsProfilePanel profile={pendingProfile}
              config={pendingConfig} errors={errors}
              onPatch={patchProfile} onPatchConfig={patchConfig} />;
          case "folders":
            return <SettingsFoldersPanel paths={pendingConfig.paths}
              errors={errors} onPatch={patchConfig} />;
          case "import":
            return <SettingsImportPanel
              pendingConfig={pendingConfig} onPatch={patchConfig} />;
          case "builds":
            return <SettingsBuildsPanel
              classifier={pendingConfig.build_classifier}
              errors={errors} onPatch={patchConfig}
              definitions={defs.definitions} defLoading={defs.defLoading}
              defError={defs.defError} />;
          case "overlay":
            return <SettingsOverlayPanel
              overlay={pendingConfig.stream_overlay}
              errors={errors} onPatch={patchConfig} />;
          case "voice":
            return <SettingsVoicePanel
              voice={pendingConfig.voice}
              errors={errors} onPatch={patchConfig} />;
          case "backups": return <SettingsBackupsPanel />;
          case "diagnostics": return <SettingsDiagnosticsPanel />;
          case "privacy":
            return <SettingsPrivacyPanel
              telemetry={pendingConfig.telemetry}
              errors={errors} onPatch={patchConfig} />;
          case "about":
            return <SettingsAboutPanel ui={pendingConfig.ui}
              errors={errors} onPatch={patchConfig} />;
          default: return null;
        }
      }

      function SettingsLoadFailure({ message, onRetry }) {
        return (
          <div className="space-y-2">
            <p className="text-sm text-loss-500">{message}</p>
            <SettingsButton kind="secondary" onClick={onRetry}>
              Retry
            </SettingsButton>
          </div>
        );
      }

      function settingsComputeDirty(docs) {
        const dirtyProfile = (docs.profile && docs.pendingProfile)
          ? settingsDiffPaths(docs.profile, docs.pendingProfile, []) : [];
        const dirtyConfig = (docs.config && docs.pendingConfig)
          ? settingsDiffPaths(docs.config, docs.pendingConfig, []) : [];
        return { dirtyProfile, dirtyConfig,
                 dirtyCount: dirtyProfile.length + dirtyConfig.length };
      }

      function settingsMakePatchers(docs) {
        return {
          patchProfile: (segs, value) => docs.setPendingProfile(
            prev => settingsSetByPath(prev || {}, segs, value)),
          patchConfig: (segs, value) => docs.setPendingConfig(
            prev => settingsSetByPath(prev || {}, segs, value)),
        };
      }

      // ============================================================
      // DIAGNOSTICS VIEW (Stage 4)
      //
      // Fetches /api/diagnostics, renders a grid of status cards (one
      // per check) and offers two actions: "Re-run all checks" (forces
      // ?refresh=1) and "Copy diagnostic bundle" (downloads a redacted
      // .zip from /api/diagnostics/bundle).
      //
      // Color tokens come from the Tailwind extend block at the top of
      // this page (win-500 / loss-500 / amber-300 / neutral-500); no
      // hard-coded hex values. Every interactive element gets a
      // focus-visible ring; status dots get aria-labels; the live-region
      // <div aria-live="polite"> announces refresh completion.
      // ============================================================

      const DIAG_STATUS_TOKENS = {
        ok:      { dot: "bg-win-500",    text: "text-win-500",
                   ring: "ring-win-500/40",    label: "OK" },
        warn:    { dot: "bg-amber-400",  text: "text-amber-300",
                   ring: "ring-amber-400/40",  label: "Warning" },
        err:     { dot: "bg-loss-500",   text: "text-loss-500",
                   ring: "ring-loss-500/40",   label: "Error" },
        pending: { dot: "bg-neutral-500/60", text: "text-neutral-500",
                   ring: "ring-neutral-500/40", label: "Pending" },
      };

      function diagStatusTokens(status) {
        return DIAG_STATUS_TOKENS[status] || DIAG_STATUS_TOKENS.pending;
      }

      function DiagnosticsStatusDot({ status }) {
        const t = diagStatusTokens(status);
        return (
          <span aria-label={t.label} role="img"
                className={"inline-block w-2.5 h-2.5 rounded-full " + t.dot} />
        );
      }

      function DiagnosticsFixButton({ fix }) {
        if (!fix) return null;
        if (fix.kind === "link") {
          return (
            <a href={fix.target} target="_blank" rel="noopener noreferrer"
               className="text-xs px-2 py-1 rounded bg-base-700
                          hover:bg-base-600 text-accent-400 underline-offset-2
                          hover:underline focus:outline-none
                          focus-visible:ring-2 focus-visible:ring-accent-500">
              {fix.label}
            </a>
          );
        }
        if (fix.kind === "cmd") {
          const onCopy = async () => {
            try { await navigator.clipboard.writeText(fix.target); }
            catch (_e) { /* clipboard not granted -- silent fallback */ }
          };
          return (
            <button onClick={onCopy} type="button"
                    title={"Copy command: " + fix.target}
                    className="text-xs px-2 py-1 rounded bg-base-700
                               hover:bg-base-600 text-accent-400
                               focus:outline-none focus-visible:ring-2
                               focus-visible:ring-accent-500">
              {fix.label}
            </button>
          );
        }
        return (
          <button type="button"
                  className="text-xs px-2 py-1 rounded bg-base-700 text-neutral-400
                             cursor-not-allowed opacity-70" disabled>
            {fix.label}
          </button>
        );
      }

      function DiagnosticsCardDetail({ detail }) {
        if (!detail) return null;
        return (
          <details className="mt-2">
            <summary className="text-[11px] uppercase tracking-wider
                                text-neutral-500 cursor-pointer
                                focus:outline-none focus-visible:ring-2
                                focus-visible:ring-accent-500 rounded px-1">
              Details
            </summary>
            <pre className="mt-1 text-[11px] text-neutral-400
                            bg-base-900/60 border border-base-700 rounded
                            p-2 overflow-auto max-h-56 whitespace-pre-wrap
                            break-all">
              {JSON.stringify(detail, null, 2)}
            </pre>
          </details>
        );
      }

      function DiagnosticsCard({ check }) {
        const t = diagStatusTokens(check.status);
        return (
          <article role="status"
                   className={"bg-base-800 border border-base-700 rounded-lg "
                              + "p-3 ring-1 " + t.ring}>
            <header className="flex items-center gap-2">
              <DiagnosticsStatusDot status={check.status} />
              <h3 className="text-sm font-medium text-neutral-100 truncate"
                  title={check.title}>{check.title}</h3>
              <span className={"ml-auto text-[10px] uppercase tracking-wider "
                               + t.text}>{check.status}</span>
            </header>
            <p className="mt-1 text-xs text-neutral-300">{check.summary}</p>
            {check.fix_action && (
              <div className="mt-2">
                <DiagnosticsFixButton fix={check.fix_action} />
              </div>
            )}
            <DiagnosticsCardDetail detail={check.detail} />
          </article>
        );
      }

      function diagSummaryCounts(checks) {
        const counts = { ok: 0, warn: 0, err: 0, pending: 0 };
        for (const c of (checks || [])) {
          if (counts[c.status] === undefined) counts[c.status] = 0;
          counts[c.status] += 1;
        }
        return counts;
      }

      function DiagnosticsToolbar({ counts, busy, onRefresh, onBundle,
                                    generatedAt, error }) {
        return (
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <h2 className="text-base font-semibold text-neutral-100">
              Diagnostics
            </h2>
            <span className="text-xs text-neutral-500"
                  title="Updated when you press Re-run all checks">
              {generatedAt
                ? "Generated " + new Date(generatedAt).toLocaleTimeString()
                : "Loading…"}
            </span>
            <DiagnosticsCountChip status="ok"      n={counts.ok} />
            <DiagnosticsCountChip status="warn"    n={counts.warn} />
            <DiagnosticsCountChip status="err"     n={counts.err} />
            <DiagnosticsCountChip status="pending" n={counts.pending} />
            <div className="ml-auto flex gap-2">
              <button type="button" onClick={onRefresh} disabled={busy}
                      className="text-xs px-2.5 py-1.5 rounded bg-accent-500
                                 hover:bg-accent-600 disabled:opacity-50
                                 disabled:cursor-not-allowed text-white
                                 focus:outline-none focus-visible:ring-2
                                 focus-visible:ring-accent-400">
                {busy ? "Running…" : "Re-run all checks"}
              </button>
              <button type="button" onClick={onBundle} disabled={busy}
                      title="Downloads a redacted .zip for support tickets"
                      className="text-xs px-2.5 py-1.5 rounded bg-base-700
                                 hover:bg-base-600 disabled:opacity-50
                                 disabled:cursor-not-allowed text-neutral-200
                                 focus:outline-none focus-visible:ring-2
                                 focus-visible:ring-accent-400">
                Copy diagnostic bundle
              </button>
            </div>
            {error && (
              <span role="alert" className="basis-full text-xs text-loss-500">
                {error}
              </span>
            )}
          </div>
        );
      }

      function DiagnosticsCountChip({ status, n }) {
        const t = diagStatusTokens(status);
        return (
          <span title={t.label + ": " + n}
                className={"text-[10px] uppercase tracking-wider px-2 py-0.5 "
                           + "rounded bg-base-700 " + t.text}>
            {status}: {n}
          </span>
        );
      }

      async function diagFetchChecks(refresh) {
        const url = "/api/diagnostics" + (refresh ? "?refresh=1" : "");
        const r = await fetch(url, { credentials: "same-origin" });
        if (!r.ok) {
          throw new Error("HTTP " + r.status + " from /api/diagnostics");
        }
        return r.json();
      }

      function diagDownloadBundle() {
        // Trigger the browser's native download via a hidden anchor.
        // The endpoint sets Content-Disposition; the browser saves the
        // file and pops it open in the OS shell.
        const a = document.createElement("a");
        a.href = "/api/diagnostics/bundle";
        a.download = "sc2tools-diagnostics.zip";
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }

      // Stage 5 of STAGE_DATA_INTEGRITY_ROADMAP: read the integrity
      // sweep state and post-back to /api/recovery/apply when the user
      // clicks "Apply recovery". Lives next to DiagnosticsView so the
      // recovery panel renders on the same tab as the integrity check.
      async function recoveryFetchState() {
        const r = await fetch("/api/recovery", { credentials: "same-origin" });
        if (!r.ok) throw new Error("HTTP " + r.status + " from /api/recovery");
        return r.json();
      }
      async function diMetricsFetch() {
        const r = await fetch("/api/data-integrity/metrics",
                              { credentials: "same-origin" });
        if (!r.ok) throw new Error("HTTP " + r.status + " from /api/data-integrity/metrics");
        return r.json();
      }
      function DataIntegrityMetricsCard() {
        // Stage 7: write-health dashboard widget. Polls every 30s
        // when the Diagnostics tab is open; values are process-local
        // so a backend restart resets them (which is documented in
        // the lib/data_integrity_metrics.js header).
        const [snap, setSnap] = useState(null);
        const [err, setErr] = useState(null);
        useEffect(() => {
          let alive = true;
          const tick = async () => {
            try {
              const body = await diMetricsFetch();
              if (alive) { setSnap(body); setErr(null); }
            } catch (e) {
              if (alive) setErr(String((e && e.message) || e));
            }
          };
          tick();
          const id = setInterval(tick, 30_000);
          return () => { alive = false; clearInterval(id); };
        }, []);
        if (err) {
          return <div className="text-xs text-red-400">Metrics: {err}</div>;
        }
        if (!snap) {
          return <div className="text-xs text-neutral-500">Loading write health…</div>;
        }
        const counters = snap.counters || {};
        const ATTEMPTED = counters.write_attempted || {};
        const SUCCEEDED = counters.write_succeeded || {};
        const FAILED = counters.write_failed || {};
        const REJECTED = counters.validation_rejected || {};
        const APPLIED = counters.recovery_applied || {};
        const sumOf = (m) => Object.values(m).reduce((a, b) => a + b, 0);
        return (
          <div className="mt-2 border-t border-base-700 pt-3 space-y-1">
            <div className="text-xs text-neutral-400 uppercase tracking-wider">
              Stage 7 — write health (this session)
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
              <div><span className="text-neutral-500">attempted</span> {sumOf(ATTEMPTED)}</div>
              <div><span className="text-neutral-500">succeeded</span> {sumOf(SUCCEEDED)}</div>
              <div className={sumOf(FAILED) > 0 ? "text-red-400" : ""}>
                <span className="text-neutral-500">failed</span> {sumOf(FAILED)}
              </div>
              <div className={sumOf(REJECTED) > 0 ? "text-amber-300" : ""}>
                <span className="text-neutral-500">rejected</span> {sumOf(REJECTED)}
              </div>
              <div><span className="text-neutral-500">applied</span> {sumOf(APPLIED)}</div>
            </div>
            {(snap.recent_errors || []).length > 0 && (
              <details className="text-xs text-neutral-500">
                <summary>Recent integrity errors ({snap.recent_errors.length})</summary>
                <pre className="text-[10px] whitespace-pre-wrap">
                  {JSON.stringify(snap.recent_errors.slice(-5), null, 2)}
                </pre>
              </details>
            )}
          </div>
        );
      }
      async function recoveryApplyCandidate(candidatePath) {
        const r = await fetch("/api/recovery/apply", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ candidate_path: candidatePath }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          throw new Error(body && body.message
            ? body.error + ": " + body.message
            : "HTTP " + r.status + " from /api/recovery/apply");
        }
        return body;
      }

      function RecoveryPanel({ onApplied }) {
        const [data, setData] = useState(null);
        const [busy, setBusy] = useState(false);
        const [error, setError] = useState(null);
        const [applyingPath, setApplyingPath] = useState(null);
        const [success, setSuccess] = useState(null);

        const reload = async () => {
          setBusy(true); setError(null);
          try {
            const body = await recoveryFetchState();
            setData(body);
          } catch (err) {
            setError(String((err && err.message) || err));
          } finally {
            setBusy(false);
          }
        };
        useEffect(() => { reload(); }, []);
        const onApply = async (candidatePath) => {
          setApplyingPath(candidatePath); setError(null); setSuccess(null);
          try {
            const body = await recoveryApplyCandidate(candidatePath);
            setSuccess("Applied " + body.applied.from + " -> " + body.applied.to);
            await reload();
            if (typeof onApplied === "function") onApplied();
          } catch (err) {
            setError(String((err && err.message) || err));
          } finally {
            setApplyingPath(null);
          }
        };
        if (busy && !data) {
          return (
            <div className="text-xs text-neutral-500">
              Scanning for orphaned tmp files…
            </div>
          );
        }
        if (error && !data) {
          return (
            <div className="text-xs text-red-400">
              Recovery scan failed: {error}
            </div>
          );
        }
        if (!data) return null;
        const candidates = (data.findings || []).filter((f) => f.candidate_path);
        const degraded = (data.findings || []).filter((f) => f.status !== "ok");
        if (candidates.length === 0 && degraded.length === 0
            && (data.orphans_aged || []).length === 0) {
          return (
            <div className="text-xs text-neutral-500">
              No orphans, no degraded files. Sweep run at {data.timestamp}.
            </div>
          );
        }
        return (
          <div className="space-y-2 mt-2 border-t border-base-700 pt-3">
            <div className="text-xs text-neutral-400 uppercase tracking-wider">
              Stage 5 — recovery candidates
            </div>
            {error && (
              <div className="text-xs text-red-400">Error: {error}</div>
            )}
            {success && (
              <div className="text-xs text-emerald-400">{success}</div>
            )}
            {candidates.length === 0 ? (
              <div className="text-xs text-amber-300">
                {degraded.length} file(s) flagged but no candidate available.
                You may need to restore from backup manually.
              </div>
            ) : (
              <div className="space-y-1">
                {candidates.map((f) => (
                  <div key={f.basename}
                       className="flex items-center justify-between
                                  bg-base-800 border border-base-700 rounded
                                  px-3 py-2 text-xs">
                    <div>
                      <div className="font-mono">{f.basename}</div>
                      <div className="text-neutral-500">
                        live: {f.live_keys} keys → candidate:
                        {" "}{f.candidate_keys} keys
                        {" "}({f.candidate_source})
                      </div>
                    </div>
                    <button type="button"
                            disabled={applyingPath === f.candidate_path}
                            onClick={() => onApply(f.candidate_path)}
                            className="px-3 py-1 rounded
                                       bg-emerald-700 hover:bg-emerald-600
                                       text-white disabled:opacity-50">
                      {applyingPath === f.candidate_path
                        ? "Applying…" : "Apply recovery"}
                    </button>
                  </div>
                ))}
              </div>
            )}
            {(data.orphans_aged || []).length > 0 && (
              <div className="text-[11px] text-neutral-500">
                Aged orphans: {data.orphans_aged.join(", ")}
              </div>
            )}
          </div>
        );
      }

      function DiagnosticsView() {
        const [data, setData] = useState(null);
        const [busy, setBusy] = useState(false);
        const [error, setError] = useState(null);

        const refresh = async (force) => {
          setBusy(true); setError(null);
          try {
            const body = await diagFetchChecks(!!force);
            setData(body);
          } catch (err) {
            setError(String((err && err.message) || err));
          } finally {
            setBusy(false);
          }
        };

        useEffect(() => { refresh(false); }, []);

        const counts = diagSummaryCounts(data && data.checks);
        return (
          <section aria-label="Diagnostics" className="space-y-3">
            <DiagnosticsToolbar counts={counts} busy={busy}
              onRefresh={() => refresh(true)} onBundle={diagDownloadBundle}
              generatedAt={data && data.generated_at} error={error} />
            <div aria-live="polite" className="sr-only">
              {busy ? "Running diagnostics" : data
                ? "Diagnostics complete: " + counts.ok + " ok, "
                  + counts.warn + " warnings, " + counts.err + " errors"
                : ""}
            </div>
            {!data && !error && (
              <div className="text-sm text-neutral-500">Loading…</div>
            )}
            {data && (
              <div className="grid grid-cols-1 md:grid-cols-2
                              lg:grid-cols-3 gap-3">
                {data.checks.map((c) => (
                  <DiagnosticsCard key={c.id} check={c} />
                ))}
              </div>
            )}
            {/* Stage 5 recovery panel: stays mounted on the Diagnostics
                tab so users land here on incident reports and can apply
                recovery candidates without hunting through the SPA. */}
            <RecoveryPanel onApplied={() => refresh(true)} />
            {/* Stage 7 write-health widget. Same data-integrity surface
                as the recovery panel; rendered separately so users can
                see counters at a glance even when there's nothing to
                recover. */}
            <DataIntegrityMetricsCard />
          </section>
        );
      }

      function SettingsView({ dbRev: _dbRev }) {
        const [tab, setTab] = useState("profile");
        const docs = useSettingsDocuments();
        const defs = useSettingsBuildDefinitions();
        const [errors, setErrors] = useState({});
        const [saving, setSaving] = useState(false);
        const [saveError, setSaveError] = useState(null);
        const dirty = settingsComputeDirty(docs);
        const patchers = settingsMakePatchers(docs);
        const onDiscard = () => {
          docs.setPendingProfile(docs.profile);
          docs.setPendingConfig(docs.config);
          setErrors({}); setSaveError(null);
        };
        const onSave = async () => {
          setSaving(true); setSaveError(null); setErrors({});
          const tasks = settingsBuildSaveTasks(
            dirty.dirtyProfile, dirty.dirtyConfig,
            docs.pendingProfile, docs.pendingConfig);
          const verdict = settingsExtractSaveErrors(
            await Promise.all(tasks));
          if (verdict.anyFailed) {
            setSaving(false);
            setErrors(settingsCollectErrors(verdict.pErrs, verdict.cErrs));
            setSaveError("Some changes were rejected. See inline errors.");
            return;
          }
          await docs.loadAll(); setSaving(false);
        };
        if (docs.loading) {
          return <p className="text-sm text-neutral-500">Loading settings…</p>;
        }
        if (docs.loadError) {
          return <SettingsLoadFailure message={docs.loadError}
            onRetry={docs.loadAll} />;
        }
        return (
          <div className="space-y-4">
            <SettingsSaveBar dirtyCount={dirty.dirtyCount} saving={saving}
              error={saveError} onSave={onSave} onDiscard={onDiscard} />
            <SettingsSaveErrorList errors={errors} />
            <div className="flex flex-col md:flex-row gap-6">
              <SettingsTabRail tab={tab} onChange={setTab} />
              <section className="flex-1 min-w-0"
                       aria-label={tab + " settings"}>
                <SettingsActivePanel tab={tab}
                  pendingProfile={docs.pendingProfile}
                  pendingConfig={docs.pendingConfig}
                  errors={errors}
                  patchProfile={patchers.patchProfile}
                  patchConfig={patchers.patchConfig}
                  defs={defs} />
              </section>
            </div>
          </div>
        );
      }



  // Expose to global so inline-block JSX in index.html can render
  // these as bare identifiers.
  Object.assign(window, {
    SettingsActivePanel,
    SettingsLoadFailure,
    settingsComputeDirty,
    settingsMakePatchers,
    DIAG_STATUS_TOKENS,
    diagStatusTokens,
    DiagnosticsStatusDot,
    DiagnosticsFixButton,
    DiagnosticsCardDetail,
    DiagnosticsCard,
    diagSummaryCounts,
    DiagnosticsToolbar,
    DiagnosticsCountChip,
    diagFetchChecks,
    diagDownloadBundle,
    DiagnosticsView,
    SettingsView
  });
})();
