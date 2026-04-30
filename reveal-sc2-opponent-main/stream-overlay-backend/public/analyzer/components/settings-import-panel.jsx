/**
 * Settings — Import past replays panel (multi-folder).
 *
 * Used in Settings -> Import replays AND wizard step 5. Both mount
 * <SettingsImportPanel /> and expect identical behaviour.
 *
 * Multi-folder fan-out is CLIENT-side: one /api/analyzer/import/* call
 * per checked folder, run sequentially via the driver in onStart()
 * below. The server's IMPORT_STATE singleton is untouched. One folder
 * erroring does not abort the rest; Stop cancels the active folder
 * and skips remaining queue.
 *
 * Helpers (date math, progress bar, worker slider, error breakdown)
 * live in settings-import-helpers.jsx and are referenced here as bare
 * identifiers via window-resolution. Loaded as a Babel module:
 *   <script type="text/babel" data-presets="react" data-type="module"
 *     src="/static/analyzer/components/settings-import-panel.jsx">
 */
(function () {
  "use strict";
  const React = window.React;
  const { useState, useEffect, useMemo, useRef } = React;

  // Polling cadence between /import/status pings inside the driver.
  // Matches the existing _useImportStatus hook so users see no UX delta.
  const DRIVER_POLL_MS = 1000;
  // Cap on how long the driver waits for IMPORT_STATE.running to release
  // between folders (e.g., if a prior import is still cleaning up).
  const DRIVER_BETWEEN_FOLDER_TIMEOUT_S = 10;

  function SettingsImportPanel({ pendingConfig, onPatch }) {
    const folderList = (pendingConfig
      && pendingConfig.paths
      && Array.isArray(pendingConfig.paths.replay_folders))
      ? pendingConfig.paths.replay_folders : [];
    const configuredIdentities = (pendingConfig
      && Array.isArray(pendingConfig.identities))
      ? pendingConfig.identities : [];
    const configuredNames = useMemo(
      () => Array.from(new Set(
        configuredIdentities.map((p) => p && p.name)
          .filter((n) => typeof n === "string" && n.trim().length > 0))),
      [configuredIdentities]);

    // folderItems is the single source of truth for "what folders
    // are visible and selected". Configured folders sync from the
    // pendingConfig prop; ad-hoc folders are user-added via Browse.
    const [folderItems, setFolderItems] = useState(() =>
      folderList.map((p) => ({
        path: p, isConfigured: true, checked: true,
      })));
    useEffect(() => {
      setFolderItems((prev) => {
        const byPath = Object.fromEntries(prev.map((f) => [f.path, f]));
        const configuredSet = new Set(folderList);
        const next = folderList.map((p) => byPath[p]
          ? { ...byPath[p], isConfigured: true }
          : { path: p, isConfigured: true, checked: true });
        for (const f of prev) {
          if (!configuredSet.has(f.path)) {
            next.push({ ...f, isConfigured: false });
          }
        }
        return next;
      });
    }, [folderList.join("|")]);
    const selectedFolders = folderItems
      .filter((f) => f.checked).map((f) => f.path);
    const toggleFolder = (path) => {
      setFolderItems((prev) => prev.map((f) =>
        f.path === path ? { ...f, checked: !f.checked } : f));
    };
    const removeAdHoc = (path) => {
      setFolderItems((prev) => prev.filter(
        (f) => f.path !== path || f.isConfigured));
    };

    const [presetId, setPresetId] = useState("90d");
    const [customSince, setCustomSince] = useState("");
    const [customUntil, setCustomUntil] = useState("");
    const sinceIso = _importComputeSinceIso(presetId, customSince);
    const untilIso = _importComputeUntilIso(presetId, customUntil);

    const [selectedNames, setSelectedNames] = useState(configuredNames);
    const configuredNamesKey = configuredNames.join("|");
    useEffect(() => {
      setSelectedNames((prev) => Array.from(
        new Set([...prev, ...configuredNames])));
    }, [configuredNamesKey]);
    const nameToCharIds = useMemo(() => {
      const acc = {};
      for (const ident of configuredIdentities) {
        const nm = ident && ident.name;
        const cid = ident && ident.character_id;
        if (!nm || !cid) continue;
        if (!acc[nm]) acc[nm] = [];
        if (!acc[nm].includes(cid)) acc[nm].push(cid);
      }
      return acc;
    }, [configuredIdentities]);
    const buildIdentityArrays = () => {
      const players = [], cids = [];
      for (const nm of selectedNames) {
        const idsForName = nameToCharIds[nm] || [""];
        for (const cid of idsForName) {
          players.push(nm); cids.push(cid || "");
        }
      }
      return { players, cids };
    };
    const toggleName = (name) => {
      setSelectedNames((prev) => prev.includes(name)
        ? prev.filter((n) => n !== name) : [...prev, name]);
    };

    const { cores, recommended } = _useImportCores();
    const [workers, setWorkers] = useState(0);
    useEffect(() => {
      if (workers === 0 && recommended > 0) setWorkers(recommended);
    }, [recommended]);

    const status = _useImportStatus();
    const interrupted = !!(status && !status.running
      && status.persisted && status.persisted.running === true);

    const [browsing, setBrowsing] = useState(false);
    const [browseError, setBrowseError] = useState(null);
    const onBrowse = () => {
      setBrowsing(true); setBrowseError(null);
      fetch(`${API}/import/pick-folder`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initial_dir: selectedFolders[0] || "" }),
      })
        .then((r) => r.ok ? r.json() : r.json().then(j => Promise.reject(j)))
        .then((j) => {
          setBrowsing(false);
          if (!j || !j.path) return;
          setFolderItems((prev) => prev.some((f) => f.path === j.path)
            ? prev.map((f) => f.path === j.path
                ? { ...f, checked: true } : f)
            : [...prev, {
                path: j.path, isConfigured: false, checked: true,
              }]);
        })
        .catch((e) => {
          setBrowseError((e && e.error) || "couldn't open folder picker");
          setBrowsing(false);
        });
    };

    const [discoverOpen, setDiscoverOpen] = useState(false);
    const [discovering, setDiscovering] = useState(false);
    const [discoverError, setDiscoverError] = useState(null);
    const [discovered, setDiscovered] = useState(null);
    const [picked, setPicked] = useState(new Set());
    const [savingIdentities, setSavingIdentities] = useState(false);
    const togglePick = (row) => {
      const key = _identityKey(row);
      setPicked((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    };
    const onDiscover = async () => {
      setDiscovering(true); setDiscoverError(null);
      setDiscovered(null); setPicked(new Set());
      const merged = new Map();
      try {
        for (const folder of selectedFolders) {
          const r = await fetch(`${API}/import/extract-identities`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              folder, since_iso: sinceIso || undefined,
              until_iso: untilIso || undefined, limit: 500,
            }),
          });
          const j = r.ok ? await r.json()
            : await r.json().then((b) => Promise.reject(b));
          for (const id of (j.identities || [])) {
            const key = _identityKey(id);
            if (!merged.has(key)) merged.set(key, id);
          }
        }
        setDiscovered(Array.from(merged.values()));
      } catch (e) {
        setDiscoverError((e && e.error)
          || "couldn't scan folder for identities");
      }
      setDiscovering(false);
    };
    const onAddPicked = () => {
      if (!discovered || picked.size === 0 || !onPatch) return;
      const toAdd = discovered.filter((row) =>
        picked.has(_identityKey(row))
        && !_isAlreadyConfigured(row, configuredIdentities));
      if (toAdd.length === 0) return;
      setSavingIdentities(true);
      const next = [...configuredIdentities, ...toAdd.map((row) => ({
        name: row.name, character_id: row.character_id,
        account_id: row.character_id
          ? (row.character_id.split("-")[2] || "") : "",
        region: row.region || "",
      }))];
      onPatch(["identities"], next);
      setSelectedNames((prev) => Array.from(new Set([
        ...prev, ...toAdd.map((r) => r.name).filter(Boolean),
      ])));
      setPicked(new Set());
      setSavingIdentities(false);
    };

    const [scanning, setScanning] = useState(false);
    const [scanResults, setScanResults] = useState(null);
    const [scanError, setScanError] = useState(null);
    const onScan = async () => {
      setScanning(true); setScanError(null); setScanResults(null);
      const ids = buildIdentityArrays();
      const perFolder = [];
      try {
        for (const folder of selectedFolders) {
          const r = await fetch(`${API}/import/scan`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              folder, since_iso: sinceIso || undefined,
              until_iso: untilIso || undefined, ...ids,
            }),
          });
          const j = r.ok ? await r.json()
            : await r.json().then((b) => Promise.reject(b));
          perFolder.push({
            path: folder,
            candidate: j.candidate_count || 0,
            new_: j.new_count || 0,
            already: j.already_imported_count || 0,
          });
        }
        setScanResults({
          perFolder,
          totalCandidate: perFolder.reduce((s, f) => s + f.candidate, 0),
          totalNew: perFolder.reduce((s, f) => s + f.new_, 0),
          totalAlready: perFolder.reduce((s, f) => s + f.already, 0),
        });
      } catch (e) {
        setScanError((e && e.error) || "scan failed");
      }
      setScanning(false);
    };

    // queue shape: {
    //   folders: [{path, status, completed, total, errors,
    //              errorMsg, errorBreakdown}],
    //   currentIndex, stopped, startedAt
    // }
    const [queue, setQueue] = useState(null);
    const stopRef = useRef(false);
    const queueRunning = !!(queue && !queue.stopped
      && queue.currentIndex < queue.folders.length);

    const onCancel = () => {
      stopRef.current = true;
      fetch(`${API}/import/cancel`, { method: "POST" })
        .catch(() => { /* best-effort */ });
    };

    const onStart = async (resume) => {
      // Resume targets only the persisted single folder in IMPORT_STATE.
      if (resume) {
        try {
          await fetch(`${API}/import/start`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              folder: (status && status.persisted
                && status.persisted.folder) || selectedFolders[0],
              since_iso: sinceIso || undefined,
              until_iso: untilIso || undefined,
              workers, resume: true, ...buildIdentityArrays(),
            }),
          });
        } catch (_) { /* non-fatal */ }
        return;
      }
      if (selectedFolders.length === 0) return;
      stopRef.current = false;
      const initial = {
        folders: selectedFolders.map((p) => ({
          path: p, status: "pending",
          completed: 0, total: 0, errors: 0,
          errorMsg: null, errorBreakdown: null,
        })),
        currentIndex: 0, stopped: false,
        startedAt: new Date().toISOString(),
      };
      setQueue(initial);
      const ids = buildIdentityArrays();

      for (let i = 0; i < initial.folders.length; i++) {
        if (stopRef.current) {
          setQueue((q) => q ? { ...q, stopped: true } : q);
          break;
        }
        const folder = initial.folders[i].path;
        setQueue((q) => q ? {
          ...q, currentIndex: i,
          folders: q.folders.map((f, j) =>
            j === i ? { ...f, status: "running" } : f),
        } : q);

        try {
          // Drain any prior IMPORT_STATE.running before starting next folder.
          for (let w = 0; w < DRIVER_BETWEEN_FOLDER_TIMEOUT_S; w++) {
            const s = await fetch(`${API}/import/status`).then((r) => r.json());
            if (!s.running) break;
            await new Promise((r) => setTimeout(r, DRIVER_POLL_MS));
          }
          const sr = await fetch(`${API}/import/start`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              folder, since_iso: sinceIso || undefined,
              until_iso: untilIso || undefined,
              workers, resume: false, ...ids,
            }),
          });
          if (!sr.ok) {
            const j = await sr.json().catch(() => ({}));
            setQueue((q) => q ? { ...q,
              folders: q.folders.map((f, j2) => j2 === i ? {
                ...f, status: "error",
                errorMsg: j.error || `start failed (${sr.status})`,
              } : f),
            } : q);
            continue;
          }
          // Poll until this folder finishes (or is cancelled)
          while (true) {
            await new Promise((r) => setTimeout(r, DRIVER_POLL_MS));
            const s = await fetch(`${API}/import/status`)
              .then((r) => r.json());
            // Live progress update
            setQueue((q) => q ? {
              ...q, folders: q.folders.map((f, j2) => j2 === i ? {
                ...f, completed: s.completed || 0,
                total: s.total || 0, errors: s.errors || 0,
              } : f),
            } : q);
            const isDone = !s.running && (
              s.phase === "complete"
              || s.phase === "cancelled"
              || s.phase === "error");
            if (isDone) {
              setQueue((q) => q ? {
                ...q, folders: q.folders.map((f, j2) => j2 === i ? {
                  ...f,
                  status: s.phase === "cancelled" ? "cancelled"
                    : s.phase === "error" ? "error" : "done",
                  completed: s.completed || 0,
                  total: s.total || 0,
                  errors: s.errors || 0,
                  errorBreakdown: s.error_breakdown || null,
                } : f),
              } : q);
              if (s.phase === "cancelled") stopRef.current = true;
              break;
            }
            if (stopRef.current) break;
          }
        } catch (e) {
          setQueue((q) => q ? { ...q,
            folders: q.folders.map((f, j2) => j2 === i ? {
              ...f, status: "error",
              errorMsg: String((e && e.error) || e),
            } : f),
          } : q);
        }
      }
      // Mark complete
      setQueue((q) => q ? { ...q, currentIndex: q.folders.length } : q);
    };

    const aggregate = queue ? {
      total: queue.folders.reduce((s, f) => s + (f.total || 0), 0),
      completed: queue.folders.reduce((s, f) => s + (f.completed || 0), 0),
      errors: queue.folders.reduce((s, f) => s + (f.errors || 0), 0),
    } : null;

    const startDisabled = queueRunning || selectedFolders.length === 0 || selectedNames.length === 0;
    const scanDisabled = startDisabled || scanning;

    return (
      <div className="space-y-6 max-w-3xl">
        <header>
          <h3 className="text-base text-neutral-100 font-semibold">
            Import past replays
          </h3>
          <p className="text-xs text-neutral-500 mt-1">
            Bulk-import old games from one or more folders. The live
            tracker keeps working while this runs.
          </p>
        </header>

        {interrupted && (
          <div className="bg-gold-900/40 border border-gold-700 rounded p-3 text-xs space-y-1">
            <div className="text-gold-300 font-semibold">An earlier import didn't finish.</div>
            <div className="text-neutral-300">
              {status.persisted.completed || 0} of {status.persisted.total || 0} replays
              were already imported from {status.persisted.folder}.
            </div>
            <button onClick={() => onStart(true)} disabled={queueRunning}
              className="mt-1 px-3 py-1 text-xs rounded bg-accent-500 text-base-900 hover:opacity-90 disabled:opacity-50">
              Pick up where it stopped
            </button>
          </div>
        )}

        {/* === Folders === */}
        <section className="space-y-2">
          <div className="text-xs text-neutral-300 font-medium">
            Replay folders
          </div>
          {folderItems.length === 0 ? (
            <div className="text-[11px] text-neutral-500
                            bg-base-900/40 rounded p-3">
              No folders configured. Click <strong>+ Browse for another
              folder</strong> below to pick one, or set them up in the
              <strong> Replay folders</strong> tab.
            </div>
          ) : (
            <div className="space-y-1">
              {folderItems.map((f) => (
                <label key={f.path}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs ${
                    queueRunning ? "opacity-60 cursor-not-allowed" : "cursor-pointer hover:bg-base-700"
                  } ${f.checked ? "bg-base-800" : ""}`}>
                  <input type="checkbox" checked={f.checked}
                    disabled={queueRunning}
                    onChange={() => toggleFolder(f.path)} />
                  <span className="font-mono truncate flex-1"
                    title={f.path}>{f.path}</span>
                  {f.isConfigured ? (
                    <span className="text-[10px] uppercase tracking-wide
                                     text-neutral-500">
                      configured
                    </span>
                  ) : (
                    <button type="button"
                      onClick={(e) => { e.preventDefault();
                                        removeAdHoc(f.path); }}
                      disabled={queueRunning}
                      className="text-[11px] text-neutral-500
                                 hover:text-loss-500
                                 disabled:opacity-50">
                      remove
                    </button>
                  )}
                </label>
              ))}
            </div>
          )}
          <div>
            <button type="button" onClick={onBrowse}
              disabled={queueRunning || browsing}
              className="text-[11px] text-accent-400 hover:underline
                         disabled:opacity-50 disabled:no-underline">
              {browsing ? "Opening…" : "+ Browse for another folder"}
            </button>
          </div>
          {browseError && (
            <div className="text-[11px] text-loss-500">{browseError}</div>
          )}
        </section>

        {/* === Date range === */}
        <section className="space-y-2">
          <div className="text-xs text-neutral-300 font-medium">
            How far back?
          </div>
          <div className="flex flex-wrap gap-1">
            {IMPORT_DATE_PRESETS.map((p) => (
              <button key={p.id} type="button"
                onClick={() => setPresetId(p.id)}
                disabled={queueRunning}
                className={`px-2.5 py-1 text-xs rounded transition ${
                  presetId === p.id ? "bg-accent-500 text-base-900"
                                    : "bg-base-700 text-neutral-300 hover:bg-base-600"
                } disabled:opacity-50`}>
                {p.label}
              </button>
            ))}
          </div>
          {presetId === "custom" && (
            <div className="flex gap-3 pt-1">
              <div className="flex-1">
                <SettingsLabel htmlFor="import-since">From</SettingsLabel>
                <SettingsInput id="import-since" type="date"
                  value={customSince} disabled={queueRunning}
                  onChange={(e) => setCustomSince(e.target.value)} />
              </div>
              <div className="flex-1">
                <SettingsLabel htmlFor="import-until">To</SettingsLabel>
                <SettingsInput id="import-until" type="date"
                  value={customUntil} disabled={queueRunning}
                  onChange={(e) => setCustomUntil(e.target.value)} />
              </div>
            </div>
          )}
        </section>

        {/* === Accounts === */}
        <section className="space-y-2">
          <div className="text-xs text-neutral-300 font-medium">
            Whose replays?
          </div>
          {configuredNames.length === 0 ? (
            <div className="text-[11px] text-neutral-500
                            bg-base-900/40 rounded p-3">
              No accounts configured. Click <strong>+ Find more
              accounts</strong> below to scan a folder for player IDs.
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {configuredNames.map((name) => {
                const checked = selectedNames.includes(name);
                return (
                  <label key={name}
                    className={`px-2 py-1 text-xs rounded cursor-pointer ${
                      checked ? "bg-accent-500 text-base-900"
                              : "bg-base-700 text-neutral-300 hover:bg-base-600"
                    }${queueRunning ? " opacity-50 cursor-not-allowed" : ""}`}>
                    <input type="checkbox" className="sr-only"
                      checked={checked} disabled={queueRunning}
                      onChange={() => toggleName(name)} />
                    {checked ? "✓ " : ""}{name}
                  </label>
                );
              })}
            </div>
          )}
          {configuredNames.length > 0 && selectedNames.length === 0 && (
            <div className="text-[11px] text-loss-500">
              Check at least one account before starting.
            </div>
          )}
          <div>
            <button type="button"
              onClick={() => setDiscoverOpen((o) => !o)}
              disabled={queueRunning}
              className="text-[11px] text-accent-400 hover:underline
                         disabled:opacity-50">
              {discoverOpen
                ? "− Hide account discovery"
                : "+ Find more accounts"}
            </button>
          </div>
          {discoverOpen && (
            <div className="bg-base-900/40 rounded p-3 space-y-2 text-xs">
              <p className="text-[11px] text-neutral-500">
                Scans every checked folder for unique player IDs. Pick
                the ones that are you — they&apos;ll be saved to your
                profile so future imports just work.
              </p>
              <button type="button" onClick={onDiscover}
                disabled={discovering || selectedFolders.length === 0
                          || queueRunning}
                className="px-3 py-1.5 text-xs rounded
                           bg-base-700 hover:bg-base-600 text-neutral-100
                           disabled:opacity-50">
                {discovering
                  ? `Scanning ${selectedFolders.length} folder${
                      selectedFolders.length === 1 ? "" : "s"}…`
                  : `Scan ${selectedFolders.length} folder${
                      selectedFolders.length === 1 ? "" : "s"} for `
                    + "identities"}
              </button>
              {discoverError && (
                <div className="text-loss-500">{discoverError}</div>
              )}
              {discovered && discovered.length === 0 && (
                <div className="text-neutral-500">
                  No identities found.
                </div>
              )}
              {discovered && discovered.length > 0 && (
                <div className="space-y-2">
                  <div className="text-[11px] text-neutral-400">
                    Found {discovered.length} unique player identity(ies).
                    Pick the ones that are you:
                  </div>
                  <ImportDiscoveredIdentitiesList
                    discovered={discovered}
                    configured={configuredIdentities}
                    picked={picked} onTogglePick={togglePick} />
                  <div className="flex gap-2 pt-1">
                    <button type="button" onClick={onAddPicked}
                      disabled={picked.size === 0 || !onPatch
                                || savingIdentities}
                      className="px-3 py-1.5 text-xs rounded
                                 bg-accent-500 text-base-900
                                 hover:opacity-90 disabled:opacity-50">
                      {savingIdentities
                        ? "Adding…"
                        : `Add ${picked.size} to my profile`}
                    </button>
                    <span className="text-[10px] text-neutral-500
                                     self-center">
                      Don&apos;t forget to click Save in the bar at the
                      top to commit.
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {/* === Speed === */}
        <section className="space-y-1">
          <div className="text-xs text-neutral-300 font-medium
                          flex items-center gap-1">
            How fast?
            <span title={"More cores = faster import, more RAM. The "
                         + "recommended setting is safe for everyday use."}
              className="text-neutral-500 cursor-help">ⓘ</span>
          </div>
          <ImportWorkerSlider value={workers} cores={cores}
            recommended={recommended} onChange={setWorkers}
            disabled={queueRunning} />
        </section>

        {/* === Action row === */}
        <div className="border-t border-base-700 pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={onScan}
              disabled={scanDisabled}
              className="px-3 py-1.5 text-xs rounded
                         bg-base-700 hover:bg-base-600 text-neutral-200
                         disabled:opacity-50">
              {scanning ? "Counting…" : "Preview count"}
            </button>
            <button type="button" onClick={() => onStart(false)}
              disabled={startDisabled}
              className="px-3 py-1.5 text-xs rounded
                         bg-accent-500 text-base-900 hover:opacity-90
                         disabled:opacity-50">
              {queueRunning
                ? `Importing ${queue.currentIndex + 1} of `
                  + `${queue.folders.length}…`
                : "Start import"}
            </button>
            {queueRunning && (
              <button type="button" onClick={onCancel}
                className="px-3 py-1.5 text-xs rounded
                           bg-loss-700 hover:bg-loss-600 text-neutral-100">
                Stop
              </button>
            )}
            <span className="text-[11px] text-neutral-500 ml-auto">
              {selectedFolders.length} folder
              {selectedFolders.length === 1 ? "" : "s"} ·{" "}
              {selectedNames.length} account
              {selectedNames.length === 1 ? "" : "s"}
            </span>
          </div>
          {scanError && (
            <div className="text-xs text-loss-500 mt-2">{scanError}</div>
          )}
        </div>

        {/* === Scan result === */}
        {scanResults && (
          <div className="bg-base-800 rounded p-3 text-xs space-y-2">
            <div className="text-neutral-200">
              <span className="font-semibold tabular-nums">
                {scanResults.totalCandidate}
              </span>{" "}replays in scope across{" "}
              <span className="font-semibold tabular-nums">
                {scanResults.perFolder.length}
              </span>{" "}folder(s).
            </div>
            {scanResults.totalNew > 0 ? (
              <div className="text-neutral-300">
                <span className="font-semibold text-win-500 tabular-nums">
                  {scanResults.totalNew}
                </span>{" "}new,{" "}
                <span className="text-neutral-500 tabular-nums">
                  {scanResults.totalAlready}
                </span>{" "}already imported.
              </div>
            ) : (
              <div className="text-neutral-400">
                All {scanResults.totalAlready} are already in your
                database — nothing new to import.
              </div>
            )}
            {scanResults.totalNew > 0 && (
              <div className="text-neutral-500">
                Estimated time at {workers} cores: ~{_importFmtDuration(
                  Math.ceil((scanResults.totalNew * 3)
                    / Math.max(1, workers)))}.
              </div>
            )}
            {scanResults.perFolder.length > 1 && (
              <ul className="text-[11px] text-neutral-400
                              space-y-0.5 pt-1">
                {scanResults.perFolder.map((p) => (
                  <li key={p.path}
                    className="flex justify-between gap-3">
                    <span className="font-mono truncate"
                      title={p.path}>{p.path}</span>
                    <span className="tabular-nums whitespace-nowrap">
                      {p.new_} new · {p.already} skipped
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* === Multi-folder progress === */}
        {queue && (
          <div aria-live="polite"
            className="space-y-2 bg-base-800 rounded p-3">
            <div className="flex items-center justify-between text-xs">
              <span className="text-neutral-300">
                {queueRunning
                  ? `Importing folder ${queue.currentIndex + 1} of `
                    + `${queue.folders.length}`
                  : "Import complete"} ·{" "}
                <span className="tabular-nums">
                  {aggregate.completed} / {aggregate.total}
                </span>
                {aggregate.errors > 0
                  && ` (${aggregate.errors} couldn't be parsed)`}
              </span>
            </div>
            <ImportProgressBar completed={aggregate.completed}
              total={aggregate.total} />
            <ul className="text-[11px] space-y-0.5 mt-1">
              {queue.folders.map((f) => (
                <li key={f.path} className="flex items-center gap-2">
                  <span className="w-4 inline-block text-center">
                    {f.status === "done" ? "✓"
                      : f.status === "running" ? "▸"
                      : f.status === "error" ? "✗"
                      : f.status === "cancelled" ? "⊘"
                      : "⋯"}
                  </span>
                  <span className={`font-mono truncate flex-1 ${
                    f.status === "done" ? "text-win-500"
                    : f.status === "error" ? "text-loss-500"
                    : f.status === "running" ? "text-accent-400"
                    : "text-neutral-500"}`} title={f.path}>{f.path}</span>
                  <span className="text-neutral-400 tabular-nums
                                   whitespace-nowrap">
                    {f.status === "pending" ? "pending"
                      : f.status === "error"
                        ? (f.errorMsg || "error")
                      : `${f.completed} / ${f.total}`
                        + (f.errors ? ` · ${f.errors} err` : "")}
                  </span>
                </li>
              ))}
            </ul>
            {!queueRunning
              && queue.folders.some((f) => f.errors > 0
                                          && f.errorBreakdown) && (
              <details className="text-xs">
                <summary className="cursor-pointer text-neutral-400">
                  Error details per folder
                </summary>
                {queue.folders.filter((f) => f.errors > 0
                                              && f.errorBreakdown)
                  .map((f) => (
                    <div key={f.path}
                      className="mt-2 pl-2 border-l border-base-700">
                      <div className="text-[11px] font-mono
                                      text-neutral-500">{f.path}</div>
                      <ImportErrorBreakdown
                        breakdown={f.errorBreakdown} samples={null} />
                    </div>
                  ))}
              </details>
            )}
          </div>
        )}
      </div>
    );
  }

  // Expose to global so inline-block JSX in index.html can render
  // these as bare identifiers.
  Object.assign(window, {
    SettingsImportPanel,
  });
})();
