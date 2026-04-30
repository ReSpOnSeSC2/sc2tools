/**
 * Settings folders — extracted from index.html for size-rule compliance.
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

      function SettingsFolderRow({ folder, onRemove, onTest, testStatus }) {
        return (
          <li className="flex items-center gap-2 px-3 py-2 bg-base-900
                         border border-base-700 rounded">
            <span className="font-mono text-xs text-neutral-200 truncate flex-1"
                  title={folder}>{folder}</span>
            {testStatus ? (
              <span className={"text-xs " + (testStatus.ok === true
                ? "text-win-500" : testStatus.ok === false
                  ? "text-loss-500" : "text-neutral-400")}>
                {testStatus.message}
              </span>
            ) : null}
            <SettingsButton kind="secondary" onClick={() => onTest(folder)}>
              Test
            </SettingsButton>
            <SettingsButton kind="danger" onClick={() => onRemove(folder)}
              ariaLabel={"Remove " + folder}>Remove</SettingsButton>
          </li>
        );
      }

      function settingsFolderTestStatus(body) {
        const count = body
          ? (body.replay_count != null
            ? body.replay_count
            : (Array.isArray(body.replays) ? body.replays.length : 0))
          : 0;
        if (typeof count === "number" && count > 0) {
          return { ok: true, message: "✓ " + count + " replays found", count };
        }
        return { ok: false, message: "✗ no replays detected", count: 0 };
      }

      function useSettingsFolderTests() {
        const [statuses, setStatuses] = useState({});
        const setOne = (key, val) =>
          setStatuses(prev => ({ ...prev, [key]: val }));
        const test = async (folder) => {
          setOne(folder, { ok: null, message: "Scanning…" });
          const r = await settingsFetchJson(
            "/api/onboarding/scan-replay-folders",
            { method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ single_path: folder }) });
          if (!r.ok) {
            setOne(folder, { ok: false,
              message: "✗ " + ((r.body && (r.body.error || "scan failed"))
                || "scan failed"),
              count: null });
            return;
          }
          setOne(folder, settingsFolderTestStatus(r.body));
        };
        return { statuses, test };
      }

      // Stage settings-pr1f: replaced minimal AddRow with a wizard-mirroring
      // surface: Browse opens a native folder picker via /api/analyzer/import/
      // pick-folder; Add accepts a manually pasted path; an Auto-detect block
      // (rendered above by the parent panel) lists every onboarding-detected
      // folder with a one-click Add.
      function SettingsFolderAddRow({ onAdd }) {
        const [draft, setDraft] = useState("");
        const [browsing, setBrowsing] = useState(false);
        const [browseError, setBrowseError] = useState("");
        const submit = () => {
          const trimmed = draft.trim();
          if (!trimmed) return;
          onAdd(trimmed);
          setDraft("");
        };
        const onKey = (e) => { if (e.key === "Enter") submit(); };
        const onBrowse = async () => {
          setBrowsing(true); setBrowseError("");
          const r = await settingsFetchJson(
            "/api/analyzer/import/pick-folder",
            { method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ initial_dir: "",
                title: "Pick a folder containing .SC2Replay files" }) });
          setBrowsing(false);
          if (!r.ok || !r.body) {
            setBrowseError("couldn't open the folder picker");
            return;
          }
          if (r.body.cancelled) return;
          if (r.body.path) {
            onAdd(String(r.body.path).trim());
          }
        };
        const trimmed = draft.trim();
        return (
          <div className="space-y-1">
            <SettingsLabel htmlFor="settings-add-folder">
              Add another folder
            </SettingsLabel>
            <div className="flex gap-2 items-stretch">
              <SettingsInput id="settings-add-folder" value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKey}
                placeholder={"Paste a path like C:\\Users\\you\\Documents"
                  + "\\StarCraft II\\Accounts\\..."} />
              <SettingsButton kind="secondary" onClick={onBrowse}
                              disabled={browsing}>
                {browsing ? "Opening…" : "Browse…"}
              </SettingsButton>
              <SettingsButton kind="primary" onClick={submit}
                              disabled={!trimmed}>Add</SettingsButton>
            </div>
            {browseError ? (
              <p className="text-xs text-loss-400">{browseError}</p>
            ) : null}
            {!trimmed ? (
              <p className="text-xs text-neutral-500">
                Type or paste a path, or click Browse to open a
                folder picker.
              </p>
            ) : null}
          </div>
        );
      }

      // Auto-detect card. Hits /api/onboarding/scan-replay-folders with no
      // body, which returns every folder onboarding would have suggested,
      // along with replay_count for each. One-click Add per row.
      function SettingsFolderAutoDetect({ existing, onAdd }) {
        const [loading, setLoading] = useState(false);
        const [err, setErr] = useState("");
        const [hits, setHits] = useState(null);
        const run = async () => {
          setLoading(true); setErr(""); setHits(null);
          const r = await settingsFetchJson(
            "/api/onboarding/scan-replay-folders",
            { method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({}) });
          setLoading(false);
          if (!r.ok || !r.body || !Array.isArray(r.body.folders)) {
            setErr("Auto-detect failed");
            return;
          }
          setHits(r.body.folders);
        };
        const isAdded = (p) => existing.includes(p);
        return (
          <div className="px-3 py-2 bg-base-900 border border-base-700 rounded
                          space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-sm text-neutral-200">Auto-detect</span>
              <span className="text-xs text-neutral-500 flex-1">
                Scans the same locations the onboarding wizard does.
              </span>
              <SettingsButton kind="secondary" onClick={run}
                              disabled={loading}>
                {loading ? "Scanning…" : "Scan now"}
              </SettingsButton>
            </div>
            {err ? <p className="text-xs text-loss-400">{err}</p> : null}
            {hits && hits.length === 0 ? (
              <p className="text-xs text-neutral-500">
                No replay folders found in the standard SC2 install
                locations. Use Browse or paste a path below.
              </p>
            ) : null}
            {hits && hits.length > 0 ? (
              <ul className="space-y-1">
                {hits.map((h) => (
                  <li key={h.path}
                      className="flex items-center gap-2 text-xs">
                    <span className="font-mono text-neutral-200 truncate flex-1"
                          title={h.path}>{h.path}</span>
                    <span className="text-neutral-400">
                      {h.replay_count != null ? h.replay_count + " replays" : ""}
                    </span>
                    {isAdded(h.path) ? (
                      <span className="text-xs text-neutral-500">added</span>
                    ) : (
                      <SettingsButton kind="primary"
                        onClick={() => onAdd(h.path)}>Add</SettingsButton>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        );
      }


      function SettingsFoldersPanel({ paths, errors, onPatch }) {
        const folders = (paths && paths.replay_folders) || [];
        const tester = useSettingsFolderTests();
        const addFolder = (trimmed) => {
          if (folders.includes(trimmed)) return;
          onPatch(["paths", "replay_folders"], [...folders, trimmed]);
        };
        const removeFolder = (folder) => {
          if (folders.length <= 1) {
            window.alert("At least one replay folder is required.");
            return;
          }
          const status = tester.statuses[folder];
          const found = (status && status.count != null)
            ? status.count + " replays" : "unknown count";
          if (!window.confirm("Remove " + folder + "? (" + found + ")")) return;
          onPatch(["paths", "replay_folders"],
            folders.filter(f => f !== folder));
        };
        return (
          <div className="space-y-3 max-w-2xl">
            <p className="text-xs text-neutral-500">
              Folders the watcher monitors for new .SC2Replay files. The
              first entry is the canonical "My Replays" folder.
            </p>
            {folders.length === 0 ? (
              <div className="px-3 py-3 bg-amber-900/20 border border-amber-700
                              rounded text-xs text-amber-200">
                No folders connected yet. Click Scan now below to auto-detect
                your SC2 replay folders, or use Browse to pick one manually.
              </div>
            ) : null}
            <SettingsFolderAutoDetect existing={folders} onAdd={addFolder} />
            <ul className="space-y-2">
              {folders.map(f => (
                <SettingsFolderRow key={f} folder={f}
                  onRemove={removeFolder} onTest={tester.test}
                  testStatus={tester.statuses[f]} />
              ))}
            </ul>
            <SettingsFolderAddRow onAdd={addFolder} />
            <SettingsErrorList errors={errors["paths.replay_folders"]} />
          </div>
        );
      }

      // settings-pr1g: the legacy active_definition_ids list is read by
      // ZERO code paths (verified via grep across routes/, analyzer.js,
      // index.js, and the Python project). The classifier uses every
      // definition + custom + (when enabled) community build regardless.
      // This panel now exposes only the toggles that actually take effect:
      //   - use_custom_builds        (data/custom_builds.json participates)
      //   - use_community_shared_builds (community cache participates)
      // plus a live sync card backed by /api/custom-builds/sync/*.

  // Expose to global so inline-block JSX in index.html can render
  // these as bare identifiers.
  Object.assign(window, {
    SettingsFolderRow,
    settingsFolderTestStatus,
    useSettingsFolderTests,
    SettingsFolderAddRow,
    SettingsFolderAutoDetect,
    SettingsFoldersPanel
  });
})();
