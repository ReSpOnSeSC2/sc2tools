/**
 * Settings foundation — extracted from index.html for size-rule compliance.
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
      // SETTINGS PAGE (Stage 2.4)
      // ------------------------------------------------------------
      // Persistent settings UI -- same fields as the Stage 2.2 wizard,
      // editable any time after onboarding. Backed by:
      //   GET/PATCH /api/profile          (Stage 2.1)
      //   GET/PATCH /api/config           (Stage 2.1)
      //   POST     /api/onboarding/*      (Stage 2.2 -- Test buttons)
      //   GET      /api/backups           (Stage 2.3)
      //   POST     /api/backups/create
      //   POST     /api/backups/restore
      //   DELETE   /api/backups/:name
      //
      // The page is a sticky-save-bar + tab-rail layout. Edits update
      // a "pending" copy of profile/config; on Save we send PATCH
      // requests for whichever document changed and reload the
      // server's normalized echo.
      //
      // Out of scope for this stage:
      //   - Diagnostics body  (Stage 4)
      //   - Cloud sync opt-in (Stage 14)
      //   - Community builds  (Stage 7)
      //   - Schema migrations (Stage 14)
      // ============================================================

      const SETTINGS_TABS = [
        { id: "profile",     label: "Profile" },
        { id: "folders",     label: "Replay folders" },
        { id: "import",      label: "Import replays" },
        { id: "builds",      label: "Build classifier" },
        { id: "overlay",     label: "Stream overlay" },
        { id: "voice",       label: "Voice readout" },
        { id: "backups",     label: "Backups" },
        { id: "diagnostics", label: "Diagnostics" },
        { id: "privacy",     label: "Privacy" },
        { id: "about",       label: "About" },
      ];

      const SETTINGS_RACES = ["Protoss", "Terran", "Zerg", "Random"];

      const SETTINGS_REGIONS = [
        { id: "us",  label: "Americas (us)" },
        { id: "eu",  label: "Europe (eu)" },
        { id: "kr",  label: "Korea (kr)" },
        { id: "cn",  label: "China (cn)" },
        { id: "sea", label: "South-East Asia (sea)" },
      ];

      const SETTINGS_PERSPECTIVES = [
        { id: "me",       label: "Me" },
        { id: "opponent", label: "Opponent" },
        { id: "both",     label: "Both" },
      ];

      const SETTINGS_BACKUP_KIND_STYLES = {
        pre:    "bg-amber-500/20 text-amber-300",
        broken: "bg-loss-500/20 text-loss-500",
        backup: "bg-accent-500/20 text-accent-300",
        bak:    "bg-base-700 text-neutral-400",
      };

      const SETTINGS_BACKUP_BASES = [
        { id: "meta_database.json",      label: "meta_database.json" },
        { id: "profile.json",            label: "profile.json" },
        { id: "config.json",             label: "config.json" },
        { id: "MyOpponentHistory.json",  label: "MyOpponentHistory.json" },
        { id: "custom_builds.json",      label: "custom_builds.json" },
      ];

      const SETTINGS_GITHUB_URL = "https://github.com/ReSpOnSeSC2/sc2tools";
      const SETTINGS_VERSION = "1.4.5";

      // --- helpers -----------------------------------------------

      async function settingsFetchJson(url, init) {
        const res = await fetch(url, init || {});
        let body = null;
        try { body = await res.json(); } catch (_e) { /* may be empty */ }
        return { ok: res.ok, status: res.status, body: body || {} };
      }

      function settingsSetByPath(obj, segs, value) {
        if (!segs.length) return value;
        const [head, ...rest] = segs;
        const next = (obj && typeof obj === "object" && !Array.isArray(obj))
          ? { ...obj } : {};
        next[head] = settingsSetByPath(next[head], rest, value);
        return next;
      }

      function settingsHumanizeBytes(n) {
        if (typeof n !== "number" || !Number.isFinite(n)) return "—";
        if (n < 1024) return n + " B";
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
        return (n / (1024 * 1024)).toFixed(1) + " MB";
      }

      function settingsFormatDate(iso) {
        if (!iso) return "—";
        try { return new Date(iso).toLocaleString(); }
        catch (_e) { return iso; }
      }

      function settingsArraysEqual(a, b) {
        if (a === b) return true;
        if (!Array.isArray(a) || !Array.isArray(b)) return false;
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i += 1) {
          if (!Object.is(a[i], b[i])) return false;
        }
        return true;
      }

      function settingsDiffPaths(a, b, path) {
        const here = path || [];
        if (Object.is(a, b)) return [];
        if (a === null || b === null
            || typeof a !== "object" || typeof b !== "object"
            || Array.isArray(a) !== Array.isArray(b)) {
          return [here];
        }
        if (Array.isArray(a)) {
          return settingsArraysEqual(a, b) ? [] : [here];
        }
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        const out = [];
        keys.forEach(k => {
          out.push(...settingsDiffPaths(a[k], b[k], [...here, k]));
        });
        return out;
      }

      // The server (routes/settings.js#formatErrors) sends ajv errors as
      // { path: "/battlenet/battle_tag", message: "..." } — note "path"
      // (not instancePath) and a leading "/". Convert to dotted keys to
      // match the inline error wiring (errors["battlenet.battle_tag"]).
      function settingsCollectErrors(profileErrors, configErrors) {
        const out = {};
        const push = (key, msg) => {
          if (!key) key = "_root";
          out[key] = out[key] || [];
          out[key].push(msg);
        };
        const collect = (errs) => {
          if (!Array.isArray(errs)) return;
          errs.forEach(e => {
            // Server shape: { path, message }. Legacy ajv shape:
            // { instancePath, dataPath, params }. Accept both.
            const raw = String(e.path || e.instancePath
              || e.dataPath || "");
            const cleaned = raw.replace(/^\//, "").replace(/\//g, ".");
            const key = cleaned
              || (e.params && e.params.missingProperty)
              || "";
            push(key, e.message || "invalid value");
          });
        };
        collect(profileErrors); collect(configErrors);
        return out;
      }

      // Flat list of every error for the save-bar surface, so the user
      // sees what actually rejected even when the broken field lives on
      // a tab they aren't looking at.
      function settingsErrorsToList(errorsByKey) {
        const list = [];
        for (const key of Object.keys(errorsByKey || {})) {
          for (const msg of errorsByKey[key]) {
            list.push({ key, msg });
          }
        }
        return list;
      }

      // --- shared atoms ------------------------------------------

      function SettingsLabel({ children, htmlFor, hint }) {
        return (
          <label htmlFor={htmlFor}
                 className="block text-sm font-medium text-neutral-200 mb-1">
            {children}
            {hint ? (
              <span className="ml-2 text-[11px] font-normal text-neutral-500">
                {hint}
              </span>
            ) : null}
          </label>
        );
      }

      function SettingsInput(props) {
        const { invalid, ...rest } = props;
        const cls =
          "w-full px-3 py-2 text-sm rounded bg-base-900 border " +
          (invalid ? "border-loss-500 " : "border-base-700 ") +
          "text-neutral-100 placeholder-neutral-600 focus:outline-none " +
          "focus:ring-2 focus:ring-accent-500 focus:border-accent-500 " +
          "motion-reduce:transition-none transition-colors";
        return <input {...rest} className={cls} />;
      }

      function SettingsSelect(props) {
        const { invalid, options, ...rest } = props;
        const cls =
          "w-full px-3 py-2 text-sm rounded bg-base-900 border " +
          (invalid ? "border-loss-500 " : "border-base-700 ") +
          "text-neutral-100 focus:outline-none focus:ring-2 " +
          "focus:ring-accent-500 focus:border-accent-500 " +
          "motion-reduce:transition-none transition-colors";
        return (
          <select {...rest} className={cls}>
            {options.map(o => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
        );
      }

      function SettingsCheckbox({ id, checked, onChange, disabled, label, hint }) {
        const wrap = "flex items-start gap-2 text-sm "
          + (disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer");
        return (
          <label htmlFor={id} className={wrap}>
            <input id={id} type="checkbox" checked={!!checked}
                   disabled={!!disabled}
                   onChange={(e) => onChange(e.target.checked)}
                   className="mt-0.5 accent-accent-500" />
            <span>
              <span className="text-neutral-200">{label}</span>
              {hint ? (
                <span className="block text-[11px] text-neutral-500">{hint}</span>
              ) : null}
            </span>
          </label>
        );
      }

      function SettingsButton({ children, onClick, kind, disabled,
                                ariaLabel, title }) {
        const k = kind || "primary";
        const base = "px-3 py-1.5 text-sm rounded transition "
          + "motion-reduce:transition-none focus:outline-none "
          + "focus-visible:ring-2 focus-visible:ring-accent-500";
        const styles = {
          primary: " bg-accent-500 text-white hover:bg-accent-400 "
            + "disabled:opacity-50 disabled:cursor-not-allowed",
          secondary: " bg-base-700 text-neutral-200 hover:bg-base-600 "
            + "disabled:opacity-50 disabled:cursor-not-allowed",
          danger: " bg-loss-500/30 text-loss-500 hover:bg-loss-500/50 "
            + "disabled:opacity-50 disabled:cursor-not-allowed",
          ghost: " text-neutral-400 hover:text-neutral-100 "
            + "hover:bg-base-700 disabled:opacity-50 "
            + "disabled:cursor-not-allowed",
        };
        return (
          <button type="button" onClick={onClick} disabled={disabled}
                  aria-label={ariaLabel} title={title}
                  className={base + (styles[k] || styles.primary)}>
            {children}
          </button>
        );
      }

      function SettingsErrorList({ errors }) {
        if (!errors || !errors.length) return null;
        return (
          <ul className="mt-1 text-xs text-loss-500 list-disc list-inside"
              aria-live="polite">
            {errors.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        );
      }

      function SettingsSaveBar({ dirtyCount, saving, error,
                                 onSave, onDiscard }) {
        const visible = dirtyCount > 0 || !!error;
        if (!visible) return null;
        return (
          <div className="sticky top-[57px] z-10 -mx-4 px-4 py-2
                          bg-amber-500/10 border-y border-amber-500/30
                          flex items-center gap-3 flex-wrap"
               role="region" aria-live="polite"
               aria-label="Unsaved settings changes">
            <span className="text-sm text-amber-300">
              {dirtyCount} unsaved {dirtyCount === 1 ? "change" : "changes"}
            </span>
            {error ? (
              <span className="text-xs text-loss-500">{error}</span>
            ) : null}
            <div className="ml-auto flex gap-2">
              <SettingsButton kind="ghost" onClick={onDiscard}
                              disabled={saving}>Discard</SettingsButton>
              <SettingsButton kind="primary" onClick={onSave}
                              disabled={saving || dirtyCount === 0}>
                {saving ? "Saving…" : "Save"}
              </SettingsButton>
            </div>
          </div>
        );
      }

      function SettingsSaveErrorList({ errors }) {
        const items = settingsErrorsToList(errors);
        if (items.length === 0) return null;
        return (
          <div className="px-3 py-2 bg-loss-900/30 border border-loss-700
                          rounded space-y-1" role="alert">
            <div className="text-xs font-semibold text-loss-300">
              The server rejected these fields:
            </div>
            <ul className="text-xs text-loss-200 font-mono space-y-0.5">
              {items.map((it, i) => (
                <li key={i}>
                  <span className="text-loss-400">{it.key || "(root)"}</span>
                  <span className="mx-1 text-neutral-500">&mdash;</span>
                  <span>{it.msg}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      }

      function SettingsTabRail({ tab, onChange }) {
        return (
          <nav aria-label="Settings sections"
               className="md:w-56 shrink-0 flex md:flex-col gap-1
                          overflow-x-auto md:overflow-visible">
            {SETTINGS_TABS.map(t => {
              const active = tab === t.id;
              const cls = "text-left px-3 py-2 text-sm rounded transition "
                + "motion-reduce:transition-none focus:outline-none "
                + "focus-visible:ring-2 focus-visible:ring-accent-500 "
                + (active
                  ? "bg-base-700 text-neutral-100"
                  : "text-neutral-400 hover:bg-base-700/60 "
                    + "hover:text-neutral-200");
              return (
                <button key={t.id} onClick={() => onChange(t.id)}
                        aria-current={active ? "page" : undefined}
                        className={cls}>
                  {t.label}
                </button>
              );
            })}
          </nav>
        );
      }

      // --- panels ------------------------------------------------

  // Expose to global so inline-block JSX in index.html can render
  // these as bare identifiers.
  Object.assign(window, {
    SETTINGS_TABS,
    SETTINGS_RACES,
    SETTINGS_REGIONS,
    SETTINGS_PERSPECTIVES,
    SETTINGS_BACKUP_KIND_STYLES,
    SETTINGS_BACKUP_BASES,
    SETTINGS_GITHUB_URL,
    SETTINGS_VERSION,
    settingsFetchJson,
    settingsSetByPath,
    settingsHumanizeBytes,
    settingsFormatDate,
    settingsArraysEqual,
    settingsDiffPaths,
    settingsCollectErrors,
    settingsErrorsToList,
    SettingsLabel,
    SettingsInput,
    SettingsSelect,
    SettingsCheckbox,
    SettingsButton,
    SettingsErrorList,
    SettingsSaveBar,
    SettingsSaveErrorList,
    SettingsTabRail
  });
})();
