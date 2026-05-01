/**
 * Wizard shell — extracted from index.html for size-rule compliance.
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

      function WizardBody({ step, ctx }) {
        if (step === 1) return <WizardStepWelcome onNext={() => ctx.setStep(2)}
                                                  onSkip={ctx.onSkipWizard} />;
        if (step === 2) return <WizardStepReplays
            folders={ctx.folders} scanning={ctx.foldersLoading}
            scanError={ctx.foldersError}
            selected={ctx.selectedFolders}
            onToggle={ctx.onToggleFolder}
            customInput={ctx.customInput}
            onCustomInput={ctx.setCustomInput}
            onAddCustom={ctx.onAddCustomFolder}
            onRescan={ctx.scanFolders}
            onNext={ctx.goNextFromReplays}
            onBack={() => ctx.setStep(1)}
            onSkip={() => ctx.setStep(3)} />;
        if (step === 3) return <WizardStepIdentity
            scanning={ctx.identitiesLoading} scanError={ctx.identitiesError}
            identities={ctx.identities}
            selectedIds={(ctx.selectedIdentities || []).map((p) => p.character_id)}
            battleTags={ctx.battleTags}
            onSetBattleTag={(cid, value) => ctx.setBattleTags(
              (prev) => ({ ...prev, [cid]: value }))}
            onToggle={ctx.onToggleIdentity}
            onRescan={() => ctx.scanIdentities(ctx.selectedFolders || [])}
            onNext={() => ctx.setStep(4)} onBack={() => ctx.setStep(2)}
            onSkip={() => ctx.setStep(4)} />;
        if (step === 4) return <WizardStepRace
            selectedRaces={ctx.selectedRaces}
            onToggle={ctx.onToggleRace}
            onNext={() => ctx.setStep(5)} onBack={() => ctx.setStep(3)}
            onSkip={() => ctx.setStep(5)} />;
        if (step === 5) return <WizardStepImport
            folders={ctx.selectedFolders}
            identities={ctx.selectedIdentities}
            battleTags={ctx.battleTags}
            onNext={() => ctx.setStep(6)}
            onBack={() => ctx.setStep(4)}
            onSkip={() => ctx.setStep(6)} />;
        if (step === 6) return <WizardStepIntegrations
            twitch={ctx.twitch} obs={ctx.obs} pulse={ctx.pulse}
            onChangeTwitch={(p) => ctx.setTwitch({ ...ctx.twitch, ...p, status: null })}
            onChangeObs={(p) => ctx.setObs({ ...ctx.obs, ...p, status: null })}
            onChangePulse={(p) => ctx.setPulse({ ...ctx.pulse, ...p, status: null })}
            onTest={ctx.onTest} onSkipAll={() => ctx.setStep(7)}
            onNext={() => ctx.setStep(7)} onBack={() => ctx.setStep(5)} />;
        if (step === 7) return <WizardStepApply
            summary={wizardSummary({
              folders: ctx.selectedFolders,
              identities: ctx.selectedIdentities,
              races: ctx.selectedRaces,
              twitch: ctx.twitch, obs: ctx.obs, pulse: ctx.pulse,
            })}
            applying={ctx.applying}
            applyError={ctx.applyError}
            onApply={ctx.onApply} onBack={() => ctx.setStep(6)} />;
        return null;
      }

      // ---- Wizard hooks ------------------------------------------

      function useWizardState() {
        const [step, setStep] = useState(1);
        const [folders, setFolders] = useState([]);
        const [selectedFolders, setSelectedFolders] = useState([]);
        const [customInput, setCustomInput] = useState("");
        const [foldersLoading, setFoldersLoading] = useState(false);
        const [foldersError, setFoldersError] = useState("");
        const [identities, setIdentities] = useState([]);
        const [selectedIdentities, setSelectedIdentities] = useState([]);
        const [identitiesLoading, setIdentitiesLoading] = useState(false);
        const [identitiesError, setIdentitiesError] = useState("");
        // Stage settings-pr1c: BattleTag per identity, keyed by
        // character_id (the regional folder id). Onboarding now asks
        // for this so Settings doesn't have to.
        const [battleTags, setBattleTags] = useState({});
        const [selectedRaces, setSelectedRaces] = useState([]);
        const [twitch, setTwitch] = useState(wizardEmptyTwitch());
        const [obs, setObs] = useState(wizardEmptyObs());
        const [pulse, setPulse] = useState(wizardEmptyPulse());
        const [applying, setApplying] = useState(false);
        const [applyError, setApplyError] = useState("");
        return {
          step, setStep,
          folders, setFolders,
          selectedFolders, setSelectedFolders,
          customInput, setCustomInput,
          foldersLoading, setFoldersLoading,
          foldersError, setFoldersError,
          identities, setIdentities,
          selectedIdentities, setSelectedIdentities,
          identitiesLoading, setIdentitiesLoading,
          identitiesError, setIdentitiesError,
          battleTags, setBattleTags,
          selectedRaces, setSelectedRaces,
          twitch, setTwitch, obs, setObs, pulse, setPulse,
          applying, setApplying, applyError, setApplyError,
        };
      }

      // ---- Scan-orchestration hook -------------------------------

      function useWizardScans(s) {
        const scanFolders = useCallback(async () => {
          s.setFoldersLoading(true); s.setFoldersError("");
          const r = await wizardFetchJson(
              "/api/onboarding/scan-replay-folders", { method: "POST" });
          s.setFoldersLoading(false);
          if (!r.ok) { s.setFoldersError("Folder scan failed."); return; }
          const list = r.body.folders || [];
          s.setFolders(list);
          if (list.length && (s.selectedFolders || []).length === 0) {
            s.setSelectedFolders([list[0].path]);
          }
        }, [s.selectedFolders]);

        const scanIdentities = useCallback(async (paths) => {
          s.setIdentitiesLoading(true); s.setIdentitiesError("");
          const r = await wizardFetchJson("/api/onboarding/scan-identities",
              wizardJsonInit({ folders: paths,
                               sample_size: WIZARD_IDENTITY_SAMPLE }));
          s.setIdentitiesLoading(false);
          if (!r.ok || r.body.ok === false) {
            s.setIdentitiesError(r.body.error || "Identity scan failed.");
            return;
          }
          const list = r.body.players || [];
          s.setIdentities(list);
          if (list.length && (s.selectedIdentities || []).length === 0) {
            s.setSelectedIdentities([list[0]]);
          }
        }, [s.selectedIdentities]);

        return { scanFolders, scanIdentities };
      }

      function useWizardHandlers(s) {
        const onToggleFolder = (p) => {
          const cur = s.selectedFolders || [];
          if (cur.includes(p)) {
            s.setSelectedFolders(cur.filter((x) => x !== p));
          } else {
            s.setSelectedFolders([...cur, p]);
          }
        };

        const onAddCustomFolder = () => {
          const path = (s.customInput || "").trim();
          if (!path) return;
          const cur = s.selectedFolders || [];
          if (!cur.includes(path)) s.setSelectedFolders([...cur, path]);
          s.setCustomInput("");
        };

        const onToggleIdentity = (player) => {
          const cur = s.selectedIdentities || [];
          const i = cur.findIndex((p) => p.character_id === player.character_id);
          if (i >= 0) {
            s.setSelectedIdentities(cur.filter((_, j) => j !== i));
          } else {
            s.setSelectedIdentities([...cur, player]);
          }
        };

        const onToggleRace = (race) => {
          const cur = s.selectedRaces || [];
          if (cur.includes(race)) {
            s.setSelectedRaces(cur.filter((r) => r !== race));
          } else {
            s.setSelectedRaces([...cur, race]);
          }
        };

        return { onToggleFolder, onAddCustomFolder,
                 onToggleIdentity, onToggleRace };
      }

      function wizardOnTest(s, which, payload) {
        if (which === "twitch")       return wizardTestTwitch(s.twitch, s.setTwitch);
        if (which === "obs")          return wizardTestObs(s.obs, s.setObs);
        if (which === "pulse")        return wizardTestPulse(s.pulse, s.setPulse);
        if (which === "pulse-search") return wizardSearchPulse(s.pulse, s.setPulse);
        if (which === "pulse-pick") {
          wizardPickPulseMatch(s.pulse, s.setPulse, payload);
          return null;
        }
        return null;
      }

      function useWizardEffects(s, scanFolders) {
        // Trigger the folder scan as soon as the user lands on Step 2
        // unless we already have results.
        useEffect(() => {
          if (s.step === 2 && s.folders.length === 0) scanFolders();
        }, [s.step, s.folders.length, scanFolders]);

        // Auto-prefill races from the aggregate race breakdown across
        // the selected identities. Only runs when the user hasn't yet
        // touched the race tiles -- manual edits aren't clobbered if
        // they go back and tweak.
        useEffect(() => {
          const ids = s.selectedIdentities || [];
          if (ids.length === 0) return;
          if ((s.selectedRaces || []).length > 0) return;
          const auto = wizardPickAutoRaces(ids);
          if (auto.length > 0) s.setSelectedRaces(auto);
        }, [s.selectedIdentities]);

        // Pre-fill the SC2Pulse search term from the primary identity
        // name once one is picked. Skip if user already typed something.
        useEffect(() => {
          const primary = wizardPickPrimary(s.selectedIdentities || []);
          if (!primary || !primary.name) return;
          if (s.pulse.search_term) return;
          if ((s.pulse.character_ids || []).length > 0) return;
          s.setPulse({ ...s.pulse, search_term: primary.name });
        }, [s.selectedIdentities]);
      }

      // ---- The wizard component itself ---------------------------


      function Wizard({ onComplete }) {
        const s = useWizardState();
        const { scanFolders, scanIdentities } = useWizardScans(s);

        useWizardEffects(s, scanFolders);

        const h = useWizardHandlers(s);

        const goNextFromReplays = () => {
          s.setSelectedIdentities([]);
          s.setIdentities([]); s.setIdentitiesError("");
          s.setStep(3);
          scanIdentities(s.selectedFolders || []);
        };

        const onTest = (which, payload) => wizardOnTest(s, which, payload);

        const onApply = () => wizardApply(
          { folders: s.selectedFolders,
            identities: s.selectedIdentities,
            races: s.selectedRaces,
            twitch: s.twitch, obs: s.obs, pulse: s.pulse },
          s.setApplying, s.setApplyError, onComplete);

        const onSkipWizard = () => {
          if (typeof onComplete === "function") onComplete();
        };

        const ctx = { ...s, ...h,
                      scanFolders, scanIdentities, goNextFromReplays,
                      onTest, onApply, onSkipWizard };

        return (
          <WizardCard>
            <WizardProgressStrip step={s.step} />
            <WizardBody step={s.step} ctx={ctx} />
          </WizardCard>
        );
      }

  // Expose to global so inline-block JSX in index.html can render
  // these as bare identifiers.
  Object.assign(window, {
    WizardBody,
    useWizardState,
    useWizardScans,
    useWizardHandlers,
    wizardOnTest,
    useWizardEffects,
    Wizard
  });
})();
