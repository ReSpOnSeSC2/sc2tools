/**
 * Settings misc — extracted from index.html for size-rule compliance.
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

      // settings-pr1m: the top-level Diagnostics tab was folded in here.
      // The Settings sub-tab now hosts the full <DiagnosticsView /> --
      // every check, the bundle download, the refresh button -- with
      // zero behavioural change. DiagnosticsView is a self-contained
      // component (state + fetch + render) so we just delegate.
      function SettingsDiagnosticsPanel() {
        return <DiagnosticsView />;
      }

      function SettingsPrivacyPanel({ telemetry, errors, onPatch }) {
        const t = telemetry || {};
        return (
          <div className="space-y-4 max-w-xl">
            <SettingsCheckbox id="settings-telemetry-opt"
              checked={!!t.opt_in}
              onChange={(v) => onPatch(["telemetry", "opt_in"], v)}
              label="Send anonymized usage telemetry"
              hint={"Counts of events; never replay paths, opponent names, "
                + "battle tags, or push tokens."} />
            <SettingsErrorList errors={errors["telemetry.opt_in"]} />
            <div className="px-3 py-3 bg-base-900 border border-base-700
                            rounded">
              <div className="text-sm font-medium text-neutral-300">
                Retention
              </div>
              <p className="text-xs text-neutral-500 mt-1">
                Replay-derived stats stay on this machine. Backups are kept
                until you delete them. Logs roll over after 30 days.
              </p>
            </div>
            <div className="px-3 py-3 bg-base-900 border border-base-700
                            rounded opacity-70"
                 title="Cloud sync arrives in Stage 14.">
              <div className="text-sm font-medium text-neutral-300">
                Cloud sync (Stage 14)
              </div>
              <p className="text-xs text-neutral-500 mt-1">
                Opt-in cloud backup of profile/config/custom builds.
                Disabled until Stage 14 ships.
              </p>
            </div>
          </div>
        );
      }

      function SettingsAboutPanel({ ui, errors, onPatch }) {
        const u = ui || {};
        const [updateMsg, setUpdateMsg] = useState(null);
        const checkUpdate = () => {
          setUpdateMsg("Update channel not wired yet — Stage 14 owns this. "
            + "Visit GitHub to see the latest release.");
        };
        return (
          <div className="space-y-4 max-w-xl">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <SettingsLabel htmlFor="settings-ui-theme">Theme</SettingsLabel>
                <SettingsSelect id="settings-ui-theme"
                  value={u.theme || "dark"}
                  onChange={(e) => onPatch(["ui", "theme"], e.target.value)}
                  options={[
                    { id: "dark",  label: "Dark" },
                    { id: "light", label: "Light" },
                  ]}
                  invalid={!!errors["ui.theme"]} />
                <SettingsErrorList errors={errors["ui.theme"]} />
              </div>
              <div>
                <SettingsLabel htmlFor="settings-ui-perspective">
                  Default perspective
                </SettingsLabel>
                <SettingsSelect id="settings-ui-perspective"
                  value={u.default_perspective || "me"}
                  onChange={(e) => onPatch(
                    ["ui", "default_perspective"], e.target.value)}
                  options={SETTINGS_PERSPECTIVES}
                  invalid={!!errors["ui.default_perspective"]} />
                <SettingsErrorList errors={errors["ui.default_perspective"]} />
              </div>
            </div>
            <div className="px-3 py-3 bg-base-900 border border-base-700
                            rounded space-y-2">
              <div className="text-sm text-neutral-300">
                SC2Tools v{SETTINGS_VERSION}
              </div>
              <div className="text-xs text-neutral-500">
                <a href={SETTINGS_GITHUB_URL} target="_blank"
                   rel="noopener noreferrer"
                   className="text-accent-300 hover:underline
                              focus-visible:underline">
                  View source on GitHub
                </a>
              </div>
              <SettingsButton kind="secondary" onClick={checkUpdate}>
                Check for updates
              </SettingsButton>
              {updateMsg ? (
                <p className="text-xs text-neutral-500">{updateMsg}</p>
              ) : null}
            </div>
          </div>
        );
      }

      // --- container ---------------------------------------------

      function useSettingsDocuments() {
        const [profile, setProfile] = useState(null);
        const [config, setConfig] = useState(null);
        const [pendingProfile, setPendingProfile] = useState(null);
        const [pendingConfig, setPendingConfig] = useState(null);
        const [loading, setLoading] = useState(true);
        const [loadError, setLoadError] = useState(null);
        const loadAll = async () => {
          setLoading(true); setLoadError(null);
          const [p, c] = await Promise.all([
            settingsFetchJson("/api/profile"),
            settingsFetchJson("/api/config"),
          ]);
          if (!p.ok || !c.ok) {
            setLoading(false);
            setLoadError("Couldn't load settings. "
              + "Open the wizard or check the backend is running.");
            return;
          }
          // Stage-2.4 / settings-pr1: GET /api/profile and GET /api/config
          // return envelopes ({ profile: {...} } and { config: {...} }), not the
          // bare document. Unwrap before stashing in state -- otherwise every
          // patch carries the stray top-level key and ajv rejects the PUT with
          // additionalProperties:false ("Some changes were rejected.").
          const profileDoc = (p.body && p.body.profile) ? p.body.profile : p.body;
          const configDoc  = (c.body && c.body.config)  ? c.body.config  : c.body;
          setProfile(profileDoc); setPendingProfile(profileDoc);
          setConfig(configDoc);   setPendingConfig(configDoc);
          setLoading(false);
        };
        useEffect(() => { loadAll(); }, []);
        return { profile, config, pendingProfile, pendingConfig,
                 loading, loadError, loadAll,
                 setPendingProfile, setPendingConfig };
      }

      function useSettingsBuildDefinitions() {
        const [definitions, setDefinitions] = useState([]);
        const [defLoading, setDefLoading] = useState(true);
        const [defError, setDefError] = useState(null);
        useEffect(() => {
          let cancelled = false;
          (async () => {
            setDefLoading(true); setDefError(null);
            const r = await settingsFetchJson("/api/analyzer/definitions");
            if (cancelled) return;
            setDefLoading(false);
            if (!r.ok) {
              setDefError((r.body && r.body.error) || "load failed");
              return;
            }
            setDefinitions(Array.isArray(r.body.items) ? r.body.items : []);
          })();
          return () => { cancelled = true; };
        }, []);
        return { definitions, defLoading, defError };
      }

      function settingsBuildSaveTasks(dirtyProfile, dirtyConfig,
                                      pendingProfile, pendingConfig) {
        const tasks = [];
        if (dirtyProfile.length) {
          tasks.push(settingsFetchJson("/api/profile", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(pendingProfile),
          }).then(r => ({ kind: "profile", r })));
        }
        if (dirtyConfig.length) {
          tasks.push(settingsFetchJson("/api/config", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(pendingConfig),
          }).then(r => ({ kind: "config", r })));
        }
        return tasks;
      }

      function settingsExtractSaveErrors(results) {
        let pErrs = null, cErrs = null, anyFailed = false;
        results.forEach(({ kind, r }) => {
          if (r.ok) return;
          anyFailed = true;
          if (Array.isArray(r.body && r.body.errors)) {
            if (kind === "profile") pErrs = r.body.errors;
            else cErrs = r.body.errors;
          }
        });
        return { anyFailed, pErrs, cErrs };
      }

  // Expose to global so inline-block JSX in index.html can render
  // these as bare identifiers.
  Object.assign(window, {
    SettingsDiagnosticsPanel,
    SettingsPrivacyPanel,
    SettingsAboutPanel,
    useSettingsDocuments,
    useSettingsBuildDefinitions,
    settingsBuildSaveTasks,
    settingsExtractSaveErrors
  });
})();
