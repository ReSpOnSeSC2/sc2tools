/**
 * Settings backups — extracted from index.html for size-rule compliance.
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

      function SettingsBackupRow({ snap, onRestore, onDelete }) {
        const isSafety = snap.kind === "pre"
          && String(snap.label || "").startsWith("restore-");
        const chip = SETTINGS_BACKUP_KIND_STYLES[snap.kind]
          || SETTINGS_BACKUP_KIND_STYLES.bak;
        return (
          <tr className="border-t border-base-700">
            <td className="px-3 py-2 font-mono text-xs text-neutral-200
                           break-all">{snap.name}</td>
            <td className="px-3 py-2 text-xs text-neutral-400">{snap.base}</td>
            <td className="px-3 py-2">
              <span className={"text-[10px] uppercase tracking-wider "
                + "px-2 py-0.5 rounded " + chip}>{snap.kind}</span>
            </td>
            <td className="px-3 py-2 text-xs text-neutral-400 whitespace-nowrap">
              {settingsHumanizeBytes(snap.size)}
            </td>
            <td className="px-3 py-2 text-xs text-neutral-400 whitespace-nowrap">
              {settingsFormatDate(snap.modified_iso)}
            </td>
            <td className="px-3 py-2">
              <div className="flex gap-1 justify-end">
                {isSafety ? (
                  <span className="text-[11px] text-neutral-500"
                        title="Safety snapshot from a recent restore — protected.">
                    protected
                  </span>
                ) : (
                  <>
                    <SettingsButton kind="secondary"
                      onClick={() => onRestore(snap)}>Restore</SettingsButton>
                    <SettingsButton kind="danger"
                      onClick={() => onDelete(snap)}>Delete</SettingsButton>
                  </>
                )}
              </div>
            </td>
          </tr>
        );
      }

      function useSettingsBackups() {
        const [list, setList] = useState([]);
        const [loading, setLoading] = useState(true);
        const [error, setError] = useState(null);
        const [busy, setBusy] = useState(false);
        const [lastSafety, setLastSafety] = useState(null);
        const refresh = async () => {
          setLoading(true); setError(null);
          const r = await settingsFetchJson("/api/backups");
          setLoading(false);
          if (!r.ok) {
            setError((r.body && r.body.error) || "load failed");
            return;
          }
          setList(Array.isArray(r.body.backups) ? r.body.backups : []);
        };
        useEffect(() => { refresh(); }, []);
        return { list, loading, error, busy, setBusy,
                 lastSafety, setLastSafety, refresh };
      }

      async function settingsRunBackupAction(url, init, label) {
        const r = await settingsFetchJson(url, init);
        if (!r.ok) {
          window.alert(label + " failed: "
            + ((r.body && r.body.error) || r.status));
          return null;
        }
        return r.body;
      }

      function settingsConfirmRestore(snap) {
        const msg = "Restore " + snap.base + " from " + snap.name + "?\n\n"
          + "A safety snapshot of the current " + snap.base
          + " will be created first.";
        return window.confirm(msg);
      }

      function settingsConfirmDelete(snap) {
        const isSafety = snap.kind === "pre"
          && String(snap.label || "").startsWith("restore-");
        if (isSafety) {
          const extra = "This is a safety snapshot from a recent restore. "
            + "Delete it ONLY if you've already verified the restore "
            + "succeeded. Continue?";
          if (!window.confirm(extra)) return false;
        }
        return window.confirm("Permanently delete " + snap.name
          + "? This cannot be undone.");
      }

      function SettingsBackupsToolbar({ createBase, setCreateBase, onCreate,
                                        onRefresh, busy, loading,
                                        lastSafety, error }) {
        return (
          <>
            <div className="flex items-end gap-2 flex-wrap">
              <div>
                <SettingsLabel htmlFor="settings-snap-base">
                  Snapshot file
                </SettingsLabel>
                <SettingsSelect id="settings-snap-base"
                  value={createBase}
                  onChange={(e) => setCreateBase(e.target.value)}
                  options={SETTINGS_BACKUP_BASES} />
              </div>
              <SettingsButton onClick={onCreate} disabled={busy}>
                Create snapshot
              </SettingsButton>
              <SettingsButton kind="ghost" onClick={onRefresh}
                disabled={busy || loading}>Refresh</SettingsButton>
            </div>
            {lastSafety ? (
              <p className="text-xs text-neutral-500">
                Safety snapshot:{" "}
                <span className="font-mono">{lastSafety}</span>
              </p>
            ) : null}
            {error ? (
              <p className="text-xs text-loss-500">{error}</p>
            ) : null}
          </>
        );
      }

      function SettingsBackupsEmptyRow({ message }) {
        return (
          <tr>
            <td colSpan="6"
                className="px-3 py-4 text-center text-neutral-500">
              {message}
            </td>
          </tr>
        );
      }

      function SettingsBackupsTableRows({ list, loading,
                                          onRestore, onDelete }) {
        if (loading) {
          return <SettingsBackupsEmptyRow message="Loading…" />;
        }
        if (list.length === 0) {
          return <SettingsBackupsEmptyRow message="No snapshots yet." />;
        }
        return list.map(s => (
          <SettingsBackupRow key={s.name} snap={s}
            onRestore={onRestore} onDelete={onDelete} />
        ));
      }

      function SettingsBackupsTable({ list, loading, onRestore, onDelete }) {
        return (
          <div className="overflow-auto border border-base-700 rounded">
            <table className="w-full text-sm">
              <thead className="text-[10px] uppercase tracking-wider
                                 text-neutral-500 bg-base-800/40">
                <tr>
                  <th className="px-3 py-2 text-left">Name</th>
                  <th className="px-3 py-2 text-left">Base</th>
                  <th className="px-3 py-2 text-left">Kind</th>
                  <th className="px-3 py-2 text-left">Size</th>
                  <th className="px-3 py-2 text-left">Modified</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                <SettingsBackupsTableRows list={list} loading={loading}
                  onRestore={onRestore} onDelete={onDelete} />
              </tbody>
            </table>
          </div>
        );
      }

      function SettingsBackupsPanel() {
        const [createBase, setCreateBase] = useState("meta_database.json");
        const ctx = useSettingsBackups();
        const onCreate = async () => {
          ctx.setBusy(true);
          await settingsRunBackupAction("/api/backups/create", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ base: createBase }),
          }, "Create");
          ctx.setBusy(false); ctx.refresh();
        };
        const onRestore = async (snap) => {
          if (!settingsConfirmRestore(snap)) return;
          ctx.setBusy(true);
          const body = await settingsRunBackupAction(
            "/api/backups/restore",
            { method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ snapshot: snap.name }) },
            "Restore");
          ctx.setBusy(false);
          if (body && body.pre_restore_snapshot
              && body.pre_restore_snapshot.name) {
            ctx.setLastSafety(body.pre_restore_snapshot.name);
          }
          ctx.refresh();
        };
        const onDelete = async (snap) => {
          if (!settingsConfirmDelete(snap)) return;
          ctx.setBusy(true);
          await settingsRunBackupAction(
            "/api/backups/" + encodeURIComponent(snap.name),
            { method: "DELETE" }, "Delete");
          ctx.setBusy(false); ctx.refresh();
        };
        return (
          <div className="space-y-3">
            <SettingsBackupsToolbar createBase={createBase}
              setCreateBase={setCreateBase}
              onCreate={onCreate} onRefresh={ctx.refresh}
              busy={ctx.busy} loading={ctx.loading}
              lastSafety={ctx.lastSafety} error={ctx.error} />
            <SettingsBackupsTable list={ctx.list} loading={ctx.loading}
              onRestore={onRestore} onDelete={onDelete} />
          </div>
        );
      }

  // Expose to global so inline-block JSX in index.html can render
  // these as bare identifiers.
  Object.assign(window, {
    SettingsBackupRow,
    useSettingsBackups,
    settingsRunBackupAction,
    settingsConfirmRestore,
    settingsConfirmDelete,
    SettingsBackupsToolbar,
    SettingsBackupsEmptyRow,
    SettingsBackupsTableRows,
    SettingsBackupsTable,
    SettingsBackupsPanel
  });
})();
