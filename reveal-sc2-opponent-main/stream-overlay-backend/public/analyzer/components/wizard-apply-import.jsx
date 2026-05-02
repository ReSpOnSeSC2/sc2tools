/**
 * Wizard apply import — extracted from index.html for size-rule compliance.
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

      function WizardStepIntegrations({ twitch, obs, pulse,
                                        onChangeTwitch, onChangeObs, onChangePulse,
                                        onTest, onSkipAll, onNext, onBack }) {
        const [open, setOpen] = useState({
          pulse: true, streamlabs: false, twitch: false, obs: false });
        const toggle = (k) => setOpen({ ...open, [k]: !open[k] });
        return (
          <div style={{ padding: "var(--space-6)" }}>
            <h2 id="wizard-title" style={{ fontSize: "var(--font-size-xl)",
                                            marginBottom: "var(--space-3)" }}>
              Optional: connect your stack
            </h2>
            <p style={{ fontSize: "var(--font-size-sm)",
                        color: "var(--color-text-secondary)",
                        marginBottom: "var(--space-4)" }}>
              Each card has a "How do I…" expander with step-by-step
              instructions. None of these are required &mdash; skip any
              you don't use.
            </p>
            <WizardPulseCard pulse={pulse} onChange={onChangePulse}
                             onSearch={() => onTest("pulse-search")}
                             onPickMatch={(m) => onTest("pulse-pick", m)}
                             onTest={() => onTest("pulse")}
                             expanded={open.pulse}
                             onToggle={() => toggle("pulse")} />
            <WizardStreamlabsCard expanded={open.streamlabs}
                                  onToggle={() => toggle("streamlabs")} />
            <WizardObsCard obs={obs} onChange={onChangeObs}
                           onTest={() => onTest("obs")}
                           expanded={open.obs}
                           onToggle={() => toggle("obs")} />
            <WizardNavRow>
              <WizardButton kind="secondary" onClick={onBack}>Back</WizardButton>
              <WizardButton kind="secondary" onClick={onSkipAll}>Skip all</WizardButton>
              <WizardButton onClick={onNext}>Next</WizardButton>
            </WizardNavRow>
          </div>
        );
      }

      // ---- Step 6: Apply ----------------------------------------

      function WizardSummaryRow({ label, value }) {
        return (
          <div style={{ display: "flex", gap: "var(--space-3)",
                        padding: "var(--space-2) 0",
                        borderBottom: "1px solid var(--color-divider)" }}>
            <dt style={{ width: "180px",
                         color: "var(--color-text-secondary)" }}>{label}</dt>
            <dd style={{ flex: 1, color: "var(--color-text-primary)",
                         wordBreak: "break-all" }}>{value || "—"}</dd>
          </div>
        );
      }

      function WizardStepApply({ summary, applying, applyError, onApply, onBack }) {
        return (
          <div style={{ padding: "var(--space-6)" }}>
            <h2 id="wizard-title" style={{ fontSize: "var(--font-size-xl)",
                                            marginBottom: "var(--space-3)" }}>
              Ready to save
            </h2>
            <dl style={{ fontSize: "var(--font-size-sm)" }}>
              {summary.map((row) => (
                <WizardSummaryRow key={row.label}
                                  label={row.label} value={row.value} />
              ))}
            </dl>
            <WizardError>{applyError}</WizardError>
            <WizardNavRow>
              <WizardButton kind="secondary" onClick={onBack} disabled={applying}>
                Back
              </WizardButton>
              <WizardButton onClick={onApply} disabled={applying}>
                {applying ? "Applying…" : "Apply & start"}
              </WizardButton>
            </WizardNavRow>
          </div>
        );
      }

      // ---- Async helpers -----------------------------------------

      async function wizardFetchJson(url, init) {
        const res = await fetch(url, init || {});
        let body = null;
        try { body = await res.json(); } catch (_e) { /* may be empty */ }
        return { ok: res.ok, status: res.status, body: body || {} };
      }

      function wizardEmptyTwitch() { return { channel: "", oauth_token: "", status: null }; }
      function wizardEmptyObs() {
        return { host: WIZARD_DEFAULT_OBS_HOST, port: WIZARD_DEFAULT_OBS_PORT,
                 password: "", status: null };
      }
      function wizardEmptyPulse() {
        return {
          character_ids: [], status: null,
          search_term: "", matches: [], searchStatus: null,
        };
      }

      function wizardJsonInit(body) {
        return {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        };
      }

      async function wizardTestTwitch(twitch, setTwitch) {
        setTwitch({ ...twitch, status: { kind: "testing", message: "Testing…" } });
        const r = await wizardFetchJson("/api/onboarding/test/twitch",
            wizardJsonInit({ channel: twitch.channel,
                             oauth_token: twitch.oauth_token }));
        const ok = r.ok && r.body.ok;
        setTwitch({ ...twitch, status: {
          kind: ok ? "ok" : "fail",
          message: ok ? `Connected as ${r.body.login}.`
                      : (r.body.error || "Connection failed."),
        } });
      }

      async function wizardTestObs(obs, setObs) {
        setObs({ ...obs, status: { kind: "testing", message: "Testing…" } });
        const r = await wizardFetchJson("/api/onboarding/test/obs",
            wizardJsonInit({ host: obs.host, port: obs.port,
                             password: obs.password || "" }));
        const ok = r.ok && r.body.ok;
        setObs({ ...obs, status: {
          kind: ok ? "ok" : "fail",
          message: ok ? "Connected to obs-websocket."
                      : (r.body.error || "Connection failed."),
        } });
      }

      async function wizardSearchPulse(pulse, setPulse) {
        const term = (pulse.search_term || "").trim();
        if (!term) return;
        setPulse({ ...pulse,
          searchStatus: { kind: "searching", message: "Searching…" } });
        const r = await wizardFetchJson("/api/onboarding/search-pulse",
            wizardJsonInit({ name: term }));
        const matches = (r.body && r.body.matches) || [];
        const ok = r.ok && r.body.ok;
        setPulse({ ...pulse,
          matches,
          searchStatus: ok
            ? { kind: "ok", message: "" }
            : { kind: "fail",
                message: (r.body && r.body.error) || "Search failed." } });
      }

      function wizardPickPulseMatch(pulse, setPulse, match) {
        const cur = pulse.character_ids || [];
        const next = cur.includes(match.pulse_id)
          ? cur.filter((id) => id !== match.pulse_id)
          : [...cur, match.pulse_id];
        setPulse({ ...pulse, character_ids: next, status: null });
      }

      async function wizardTestPulse(pulse, setPulse) {
        const ids = pulse.character_ids || [];
        if (ids.length === 0) return;
        setPulse({ ...pulse, status: { kind: "testing", message: "Testing…" } });
        const r = await wizardFetchJson("/api/onboarding/test/pulse",
            wizardJsonInit({ character_ids: ids }));
        const ok = r.ok && r.body.ok;
        const results = (r.body && r.body.results) || [];
        const summary = ok
          ? results.map((x) => `${x.name || "?"} (${x.region || "?"})`).join(", ")
          : "";
        setPulse({ ...pulse,
          status: {
            kind: ok ? "ok" : "fail",
            message: ok
              ? `Verified ${results.length} profile(s): ${summary}`
              : (r.body.error || "Pulse lookup failed."),
          },
        });
      }

      function wizardPickPrimary(identities) {
        if (!Array.isArray(identities) || identities.length === 0) return null;
        let best = identities[0];
        for (const p of identities) {
          if ((p.games_seen || 0) > (best.games_seen || 0)) best = p;
        }
        return best;
      }

      function wizardRegionFromCharacterId(cid) {
        const lead = (cid || "").split("-")[0];
        return ({ "1": "us", "2": "eu", "3": "kr",
                  "5": "cn", "6": "sea" })[lead] || "us";
      }

      // Account_id resolution: identity_cli.py lifts the real Battle.net
      // account_id from the replay folder path (Accounts/<id>/<toon>/...).
      // When a custom path doesn't match that layout, fall back to the
      // toon_handle's last numeric segment so the schema regex still
      // validates.
      function wizardAccountIdFor(player) {
        if (!player) return "0";
        if (player.account_id) return String(player.account_id);
        const cid = player.character_id || "";
        const tail = cid.split("-")[3] || "0";
        return tail;
      }

      function wizardPulseIdsByRegion(pulse) {
        const out = {};
        if (!pulse || !Array.isArray(pulse.character_ids)) return out;
        const byId = {};
        for (const m of (pulse.matches || [])) byId[String(m.pulse_id)] = m;
        for (const cid of pulse.character_ids) {
          const m = byId[String(cid)];
          const region = m && m.region ? String(m.region).toLowerCase() : "";
          if (region && !out[region]) out[region] = String(cid);
        }
        return out;
      }

      function wizardBuildProfile(state) {
        const primary = wizardPickPrimary(state.identities);
        if (!primary) return null;
        // Stage settings-pr1c: prefer the BattleTag the user typed in the
        // wizard's identity step. Stub-fallback only if blank, so legacy
        // installs that didn't see this field still validate.
        const typedBt = ((state.battleTags || {})[primary.character_id] || "").trim();
        const battle_tag = typedBt || `${primary.name}#0`;
        const region = state.pulse.region
            || wizardRegionFromCharacterId(primary.character_id);
        const account_id = wizardAccountIdFor(primary);
        return {
          version: 1,
          battlenet: { battle_tag,
                       character_id: primary.character_id,
                       account_id, region },
          races: Array.isArray(state.races) && state.races.length
            ? state.races : ["Protoss"],
          mmr_target: null,
          preferred_player_name_in_replays: primary.name,
        };
      }

      function wizardBuildConfig(state) {
        const battleTagsMap = state.battleTags || {};
        const pulseIdsByRegion = wizardPulseIdsByRegion(state.pulse);
        const identities = (Array.isArray(state.identities) ? state.identities : [])
          .map((p) => {
            const region = wizardRegionFromCharacterId(p.character_id);
            const entry = {
              name: p.name,
              character_id: p.character_id,
              account_id: wizardAccountIdFor(p),
              region,
            };
            const bt = (battleTagsMap[p.character_id] || "").trim();
            if (bt) entry.battle_tag = bt;
            const pid = pulseIdsByRegion[region];
            if (pid) entry.pulse_id = String(pid);
            return entry;
          });
        return {
          version: 1,
          paths: {
            sc2_install_dir: "",
            replay_folders: Array.isArray(state.folders) ? state.folders : [],
          },
          identities,
          macro_engine: {
            enabled_disciplines: ["chrono", "inject", "mule"],
            minimum_game_length_sec: 60,
            engine_version: "2026-04-chain-counted",
          },
          build_classifier: {
            active_definition_ids: [],
            use_custom_builds: true,
            use_community_shared_builds: true,
          },
          stream_overlay: {
            // settings-pr1k: enabled is no longer user-toggled in the
            // SPA (event bus is always on); default true so old code
            // paths that read this field still see the expected value.
            enabled: true,
            // twitch_channel left null on fresh installs; the owner
            // sets TWITCH_CHANNEL via .env directly, not via the wizard.
            twitch_channel: null,
            obs_websocket: {
              host: state.obs.host || WIZARD_DEFAULT_OBS_HOST,
              port: state.obs.port || WIZARD_DEFAULT_OBS_PORT,
              password: state.obs.password || null,
            },
            pulse_character_ids: Array.isArray(state.pulse.character_ids)
              ? state.pulse.character_ids.slice() : [],
          },
          telemetry: { opt_in: false },
          ui: { theme: "dark", default_perspective: "me" },
        };
      }

      function wizardAggregateRaces(identities) {
        const sums = { Protoss: 0, Terran: 0, Zerg: 0, Random: 0 };
        for (const p of identities || []) {
          const r = (p && p.races) || {};
          sums.Protoss += r.Protoss || 0;
          sums.Terran  += r.Terran  || 0;
          sums.Zerg    += r.Zerg    || 0;
          sums.Random  += r.Random  || 0;
        }
        return sums;
      }

      // Threshold: a race must have at least 5% of games OR 5 raw games
      // to auto-check. Below that, the user can still tick it manually.
      const WIZARD_RACE_AUTO_PCT = 0.05;
      const WIZARD_RACE_AUTO_FLOOR = 5;

      function wizardPickAutoRaces(identities) {
        const sums = wizardAggregateRaces(identities);
        const total = sums.Protoss + sums.Terran + sums.Zerg + sums.Random;
        if (total === 0) return [];
        const out = [];
        for (const r of WIZARD_RACES) {
          const n = sums[r] || 0;
          if (n >= WIZARD_RACE_AUTO_FLOOR
              || n / total >= WIZARD_RACE_AUTO_PCT) {
            out.push(r);
          }
        }
        return out;
      }

      function wizardSummary(state) {
        const folderLabel = Array.isArray(state.folders) && state.folders.length
          ? `${state.folders.length} folder(s):\n${state.folders.join("\n")}`
          : null;
        const ids = Array.isArray(state.identities) ? state.identities : [];
        const primary = wizardPickPrimary(ids);
        const idLabel = ids.length
          ? `${ids.length} identity(ies):\n` + ids
              .map((p) => `${p.name} (${p.character_id})`).join("\n")
          : null;
        const raceLabel = Array.isArray(state.races) && state.races.length
          ? state.races.join(", ") : null;
        return [
          { label: "Replay folders",      value: folderLabel },
          { label: "Identities",          value: idLabel },
          { label: "Primary",
            value: primary ? `${primary.name} (${primary.character_id})` : null },
          { label: "Races",               value: raceLabel },
          { label: "Twitch channel",      value: state.twitch.channel },
          { label: "OBS host:port",
            value: state.obs.password ? `${state.obs.host}:${state.obs.port}` : null },
          { label: "SC2Pulse profile(s)",
            value: (state.pulse.character_ids || []).length
              ? `${state.pulse.character_ids.length}: `
                + state.pulse.character_ids.join(", ")
              : null },
        ];
      }

      async function wizardApply(state, setApplying, setApplyError, onComplete) {
        setApplying(true); setApplyError("");
        // Step 3 has a "Skip (add identity later)" affordance for
        // users whose replays sc2reader can't currently parse. When
        // they skip, wizardBuildProfile returns null because there's
        // no identity to anchor the profile to -- but Apply must
        // still succeed so they can finish onboarding and configure
        // identity later in Settings -> Profile. We persist config
        // (with identities: []) and skip the profile PUT entirely.
        const profile = wizardBuildProfile(state);
        if (profile) {
          const r1 = await wizardFetchJson("/api/profile",
              { ...wizardJsonInit(profile), method: "PUT" });
          if (!r1.ok) {
            setApplying(false);
            setApplyError("Profile save failed: "
                + JSON.stringify(r1.body.errors || r1.body.error));
            return;
          }
        }
        const r2 = await wizardFetchJson("/api/config",
            { ...wizardJsonInit(wizardBuildConfig(state)), method: "PUT" });
        if (!r2.ok) {
          setApplying(false);
          setApplyError("Config save failed: "
              + JSON.stringify(r2.body.errors || r2.body.error));
          return;
        }
        // Initial backfill only makes sense when we know who the user
        // is -- skip it on the no-identity path so we don't churn the
        // meta DB with rows that can't be attributed.
        if (profile) {
          // Best-effort: never blocks completion if backfill kickoff fails.
          await wizardFetchJson("/api/onboarding/start-initial-backfill",
              { method: "POST" });
        }
        setApplying(false);
        if (typeof onComplete === "function") onComplete();
      }


      function WizardStepImport({ folders, identities, battleTags,
                                  onNext, onBack, onSkip }) {
        // Reuses SettingsImportPanel by faking the pendingConfig shape it
        // expects. Lets a brand-new user kick off a historical replay
        // import as part of onboarding -- the import then runs in the
        // background while they finish the rest of the wizard.
        //
        // Identities are plumbed through so SettingsImportPanel can
        // populate selectedNames; without them, its Start button stays
        // disabled and a wizard user can sail past Step 5 with no
        // import ever running. battleTags is included for parity with
        // the persisted config shape but is not used by the panel today.
        const idList = Array.isArray(identities) ? identities : [];
        const fakePendingConfig = {
          paths: { replay_folders: Array.isArray(folders) ? folders : [] },
          identities: idList,
          battle_tags: (battleTags && typeof battleTags === "object")
            ? battleTags : {},
        };
        return (
          <WizardCard>
            <h2 id="wizard-title"
              className="text-xl font-semibold text-neutral-100">
              Import your past replays (optional)
            </h2>
            <p className="text-sm text-neutral-400 mt-2">
              We can scan your replay folder for games you played before
              installing this app and import them all at once. This is
              optional — you can also skip it and only track new games
              going forward.
            </p>
            <p className="text-xs text-neutral-500 mt-1">
              The import runs in the background, so you can continue with
              the rest of the wizard while it works.
            </p>
            <div className="mt-4">
              <SettingsImportPanel pendingConfig={fakePendingConfig} />
            </div>
            <WizardNavRow>
              <WizardButton kind="ghost" onClick={onBack}>
                Back
              </WizardButton>
              <WizardButton kind="ghost" onClick={onSkip}>
                Skip
              </WizardButton>
              <WizardButton kind="primary" onClick={onNext}>
                Continue
              </WizardButton>
            </WizardNavRow>
          </WizardCard>
        );
      }

      // ---- Wizard step dispatcher --------------------------------


  // Expose to global so inline-block JSX in index.html can render
  // these as bare identifiers.
  Object.assign(window, {
    WizardStepIntegrations,
    WizardSummaryRow,
    WizardStepApply,
    wizardFetchJson,
    wizardEmptyTwitch,
    wizardEmptyObs,
    wizardEmptyPulse,
    wizardJsonInit,
    wizardTestTwitch,
    wizardTestObs,
    wizardSearchPulse,
    wizardPickPulseMatch,
    wizardTestPulse,
    wizardPickPrimary,
    wizardRegionFromCharacterId,
    wizardAccountIdFor,
    wizardPulseIdsByRegion,
    wizardBuildProfile,
    wizardBuildConfig,
    wizardAggregateRaces,
    WIZARD_RACE_AUTO_PCT,
    WIZARD_RACE_AUTO_FLOOR,
    wizardPickAutoRaces,
    wizardSummary,
    wizardApply,
    WizardStepImport
  });
})();
