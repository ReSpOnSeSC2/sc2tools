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
