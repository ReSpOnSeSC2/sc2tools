/**
 * Settings builds — extracted from index.html for size-rule compliance.
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

      function settingsFmtSyncTime(iso) {
        if (!iso) return "never";
        try {
          const d = new Date(iso);
          if (isNaN(d.getTime())) return "never";
          return d.toLocaleString();
        } catch (_e) { return "never"; }
      }

      function useSettingsBuildCounts() {
        const [counts, setCounts] = useState({ custom: 0, community_cache: 0, total: 0 });
        const [err, setErr] = useState("");
        const reload = useCallback(async () => {
          const r = await settingsFetchJson("/api/custom-builds");
          if (!r.ok || !r.body) { setErr("couldn't load custom builds"); return; }
          setErr("");
          setCounts(r.body.counts || { custom: 0, community_cache: 0, total: 0 });
        }, []);
        useEffect(() => { reload(); }, [reload]);
        return { counts, err, reload };
      }

      function useSettingsCommunitySync() {
        const [status, setStatus] = useState(null);
        const [err, setErr] = useState("");
        const reload = useCallback(async () => {
          const r = await settingsFetchJson(
            "/api/custom-builds/sync/status");
          if (!r.ok || !r.body) { setErr("couldn't load sync status"); return; }
          setErr(""); setStatus(r.body);
        }, []);
        useEffect(() => { reload(); }, [reload]);
        return { status, err, reload };
      }

      function SettingsBuildsCounts({ builtInCount, counts }) {
        return (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <SettingsCountCard label="Built-in patterns"
              value={builtInCount}
              hint="ships with the analyzer; always active" />
            <SettingsCountCard label="Your custom builds"
              value={counts.custom}
              hint="data/custom_builds.json" />
            <SettingsCountCard label="Community builds"
              value={counts.community_cache}
              hint="cached from the shared community DB" />
          </div>
        );
      }

      function SettingsCountCard({ label, value, hint }) {
        return (
          <div className="px-3 py-3 bg-base-900 border border-base-700 rounded">
            <div className="text-xs text-neutral-500">{label}</div>
            <div className="text-2xl font-semibold text-neutral-100
                            tabular-nums">{value}</div>
            <div className="text-xs text-neutral-500 mt-1">{hint}</div>
          </div>
        );
      }

      function SettingsBuildsCommunitySyncCard({ classifier, errors,
                                                 onPatch, onCountsRefresh }) {
        const c = classifier || {};
        const sync = useSettingsCommunitySync();
        const [syncing, setSyncing] = useState(false);
        const [syncMsg, setSyncMsg] = useState("");
        const enabled = !!c.use_community_shared_builds;
        const onSync = async () => {
          setSyncing(true); setSyncMsg("");
          const r = await settingsFetchJson("/api/custom-builds/sync",
            { method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({}) });
          setSyncing(false);
          if (!r.ok || !r.body) {
            setSyncMsg("Sync failed");
            return;
          }
          if (r.body.sync_disabled) {
            setSyncMsg("Community sync is disabled on this server.");
            return;
          }
          if (r.body.error) {
            setSyncMsg("Sync error: " + r.body.error);
          } else {
            setSyncMsg("Sync complete.");
          }
          sync.reload();
          onCountsRefresh && onCountsRefresh();
        };
        return (
          <div className="px-4 py-3 bg-base-900 border border-base-700 rounded
                          space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-neutral-100">
                  Community builds
                </div>
                <p className="text-xs text-neutral-400 mt-0.5">
                  Builds shared by other players. Cached locally and
                  refreshed on a 15-minute schedule. New builds you save
                  push back automatically.
                </p>
              </div>
              <SettingsButton kind="secondary" onClick={onSync}
                              disabled={syncing}>
                {syncing ? "Syncing…" : "Sync now"}
              </SettingsButton>
            </div>
            <SettingsCheckbox id="settings-use-community"
              checked={enabled}
              onChange={(v) => onPatch(
                ["build_classifier", "use_community_shared_builds"], v)}
              label="Use community-shared builds for classification"
              hint="When off, the cache is still synced but ignored when labelling games." />
            <SettingsErrorList errors={
              errors["build_classifier.use_community_shared_builds"]} />
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <dt className="text-neutral-500">Last sync</dt>
              <dd className="text-neutral-200">
                {settingsFmtSyncTime(sync.status && sync.status.last_sync_at)}
              </dd>
              <dt className="text-neutral-500">Pending uploads</dt>
              <dd className="text-neutral-200">
                {sync.status ? (sync.status.pending_count || 0) : "—"}
              </dd>
              <dt className="text-neutral-500">Cached community builds</dt>
              <dd className="text-neutral-200">
                {sync.status ? (sync.status.cache_count || 0) : "—"}
              </dd>
              {sync.status && sync.status.last_error ? (
                <>
                  <dt className="text-neutral-500">Last error</dt>
                  <dd className="text-loss-400 truncate"
                      title={sync.status.last_error}>
                    {sync.status.last_error}
                  </dd>
                </>
              ) : null}
            </dl>
            {syncMsg ? (
              <p className="text-xs text-neutral-300">{syncMsg}</p>
            ) : null}
            {sync.err ? (
              <p className="text-xs text-loss-400">{sync.err}</p>
            ) : null}
          </div>
        );
      }

      function SettingsBuildsPanel({ classifier, errors, onPatch,
                                     definitions, defLoading, defError }) {
        const c = classifier || {};
        const builtInCount = Array.isArray(definitions) ? definitions.length : 0;
        const buildCounts = useSettingsBuildCounts();
        return (
          <div className="space-y-4 max-w-3xl">
            <div className="px-4 py-3 bg-base-900 border border-base-700 rounded">
              <h3 className="text-sm font-semibold text-neutral-100 mb-1">
                What the build classifier does
              </h3>
              <p className="text-xs text-neutral-400 leading-relaxed">
                After every replay is parsed, the classifier compares your
                opening (the first ~5 minutes) against build patterns and
                labels the game with the closest match (e.g.
                "PvT &mdash; Cannon Rush"). The toggles below control which
                pattern sources participate. Built-in patterns are always
                on; you opt your own custom builds and community builds in
                or out.
              </p>
            </div>
            {defError ? (
              <p className="text-xs text-loss-400">
                Couldn't load build_definitions.json: {defError}
              </p>
            ) : null}
            <SettingsBuildsCounts builtInCount={builtInCount}
                                  counts={buildCounts.counts} />
            {buildCounts.err ? (
              <p className="text-xs text-loss-400">{buildCounts.err}</p>
            ) : null}
            <div className="px-4 py-3 bg-base-900 border border-base-700
                            rounded space-y-2">
              <SettingsCheckbox id="settings-use-custom"
                checked={!!c.use_custom_builds}
                onChange={(v) => onPatch(
                  ["build_classifier", "use_custom_builds"], v)}
                label="Use my custom builds (data/custom_builds.json)"
                hint="Off keeps your builds saved but excludes them from auto-classification." />
              <SettingsErrorList
                errors={errors["build_classifier.use_custom_builds"]} />
            </div>
            <SettingsCustomBuildsList onChanged={buildCounts.reload} />
            <SettingsBuildsCommunitySyncCard classifier={c}
              errors={errors} onPatch={onPatch}
              onCountsRefresh={buildCounts.reload} />
          </div>
        );
      }

      // settings-pr1h: list custom builds (source==="custom") with an Edit
      // button that opens BuildEditorModal in edit mode (PUT /:id). Hidden
      // when the modal module hasn't loaded so we don't show a dead button.
      function SettingsCustomBuildsList({ onChanged }) {
        const [list, setList] = useState(null);
        const [err, setErr] = useState("");
        const [editing, setEditing] = useState(null); // { id, draft }
        const [busyId, setBusyId] = useState("");
        const reload = useCallback(async () => {
          const r = await settingsFetchJson("/api/custom-builds");
          if (!r.ok || !r.body) { setErr("couldn't load builds"); return; }
          setErr("");
          const builds = (r.body.builds || []).filter((b) => b.source === "custom");
          setList(builds);
        }, []);
        useEffect(() => { reload(); }, [reload]);
        const onEdit = async (id) => {
          setBusyId(id); setErr("");
          const r = await settingsFetchJson(
            "/api/custom-builds/" + encodeURIComponent(id));
          setBusyId("");
          if (!r.ok || !r.body) {
            setErr("couldn't load that build for editing");
            return;
          }
          setEditing({ id, draft: r.body });
        };
        const onDelete = async (id, name) => {
          if (!window.confirm("Delete custom build \"" + name + "\"?")) return;
          setBusyId(id);
          const r = await settingsFetchJson(
            "/api/custom-builds/" + encodeURIComponent(id),
            { method: "DELETE" });
          setBusyId("");
          if (!r.ok && r.status !== 204) {
            setErr("delete failed");
            return;
          }
          await reload();
          onChanged && onChanged();
        };
        const onSaved = () => {
          setEditing(null); reload();
          onChanged && onChanged();
        };
        return (
          <div className="px-4 py-3 bg-base-900 border border-base-700
                          rounded space-y-2">
            <div className="text-sm font-semibold text-neutral-100">
              Your custom builds
            </div>
            {!window.BuildEditorModal ? (
              <p className="text-xs text-amber-400">
                Build editor module didn't load (network error?). Reload
                the page to try again.
              </p>
            ) : null}
            {err ? (
              <p className="text-xs text-loss-400">{err}</p>
            ) : null}
            {list && list.length === 0 ? (
              <p className="text-xs text-neutral-500">
                No custom builds saved yet. Open a game in My Builds and
                click "Save as new build" on the timeline to create one.
              </p>
            ) : null}
            {list && list.length > 0 ? (
              <ul className="space-y-1">
                {list.map((b) => (
                  <li key={b.id}
                      className="flex items-center gap-2 text-xs">
                    <div className="flex-1 min-w-0">
                      <div className="text-neutral-200 truncate"
                           title={b.name}>{b.name}</div>
                      <div className="text-neutral-500">
                        {(b.race || "?") + " vs " + (b.vs_race || "?")}
                        {b.skill_level ? " · " + b.skill_level : ""}
                        {b.updated_at
                          ? " · updated " + settingsFmtSyncTime(b.updated_at)
                          : ""}
                      </div>
                    </div>
                    <SettingsButton kind="secondary"
                      onClick={() => onEdit(b.id)}
                      disabled={!window.BuildEditorModal || busyId === b.id}>
                      {busyId === b.id ? "Loading…" : "Edit"}
                    </SettingsButton>
                    <SettingsButton kind="danger"
                      onClick={() => onDelete(b.id, b.name)}
                      disabled={busyId === b.id}>
                      Delete
                    </SettingsButton>
                  </li>
                ))}
              </ul>
            ) : null}
            {editing && window.BuildEditorModal ?
              React.createElement(window.BuildEditorModal, {
                open: true,
                game: { events: [], my_race: editing.draft.race,
                        opp_race: editing.draft.vs_race },
                gameId: editing.draft.source_replay_id || "",
                draft: editing.draft,
                editId: editing.id,
                profileReady: true,
                onClose: () => setEditing(null),
                onSaved: onSaved,
                socket: typeof window !== "undefined"
                  ? window.__sc2_socket : null,
              })
            : null}
          </div>
        );
      }

      function settingsOverlayStatusClass(s) {
        if (!s) return "";
        return "text-xs " + (s.ok === true ? "text-win-500"
          : s.ok === false ? "text-loss-500" : "text-neutral-400");
      }

      async function settingsRunOverlayTest(url, body) {
        const r = await settingsFetchJson(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const ok = r.ok && r.body && r.body.ok !== false;
        // settings-pr1j: when the server falls back to .env (because
        // the SPA didn't paste an oauth token), surface that to the
        // user so they understand WHICH credentials got tested.
        const usedEnv = !!(r.body && r.body.token_source === "env");
        const baseMsg = r.body && r.body.message
          ? r.body.message : (r.ok ? "OK" : "failed");
        const message = usedEnv && ok
          ? baseMsg + " (using saved .env credentials)"
          : baseMsg;
        return { ok, message };
      }

  // Expose to global so inline-block JSX in index.html can render
  // these as bare identifiers.
  Object.assign(window, {
    settingsFmtSyncTime,
    useSettingsBuildCounts,
    useSettingsCommunitySync,
    SettingsBuildsCounts,
    SettingsCountCard,
    SettingsBuildsCommunitySyncCard,
    SettingsBuildsPanel,
    SettingsCustomBuildsList,
    settingsOverlayStatusClass,
    settingsRunOverlayTest
  });
})();
