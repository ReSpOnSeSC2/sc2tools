/**
 * Wizard steps early — extracted from index.html for size-rule compliance.
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

      // ---- Step 1: Welcome --------------------------------------

      function WizardStepWelcome({ onNext, onSkip }) {
        return (
          <div style={{ padding: "var(--space-6)" }}>
            <h2 id="wizard-title"
                style={{ fontSize: "var(--font-size-2xl)",
                         marginBottom: "var(--space-4)" }}>
              Welcome to your SC2 stats lab.
            </h2>
            <ul style={{
              fontSize: "var(--font-size-base)",
              lineHeight: "var(--line-height-relaxed)",
              color: "var(--color-text-primary)",
              marginLeft: "var(--space-6)", listStyle: "disc",
            }}>
              <li>Track every macro slip across your last 1,000 ladder games.</li>
              <li>Recognize what your opponent is building before the first scout.</li>
              <li>See your real progress without manually tagging anything.</li>
            </ul>
            <WizardNavRow>
              <WizardButton onClick={onNext}>Get started</WizardButton>
              <WizardButton kind="secondary" onClick={onSkip}>
                Skip wizard (advanced)
              </WizardButton>
            </WizardNavRow>
          </div>
        );
      }

      // ---- Step 2: Replay folder --------------------------------

      function WizardFolderRow({ folder, selected, onToggle }) {
        const id = `wzr-folder-${folder.path}`;
        const isSel = (selected || []).includes(folder.path);
        return (
          <label htmlFor={id} style={{
            display: "flex", gap: "var(--space-2)",
            padding: "var(--space-3)",
            background: "var(--color-bg-elevated)",
            borderRadius: "var(--radius-md)",
            border: isSel
              ? "1px solid var(--color-info)"
              : "1px solid var(--color-border-subtle)",
            cursor: "pointer",
          }}>
            <input id={id} type="checkbox"
                   checked={isSel}
                   onChange={() => onToggle(folder.path)} />
            <div style={{ flex: 1, fontSize: "var(--font-size-sm)" }}>
              <div style={{ color: "var(--color-text-primary)",
                            wordBreak: "break-all" }}>{folder.path}</div>
              <div style={{ color: "var(--color-text-muted)",
                            fontSize: "var(--font-size-xs)" }}>
                {folder.replay_count} replays · {folder.source}
              </div>
            </div>
          </label>
        );
      }

      function WizardStepReplays({ folders, scanning, scanError,
                                   selected, onToggle,
                                   customInput, onCustomInput, onAddCustom,
                                   onRescan, onNext, onBack }) {
        const canAddCustom = !!(customInput && customInput.trim()
            && !(selected || []).includes(customInput.trim()));
        return (
          <div style={{ padding: "var(--space-6)" }}>
            <h2 id="wizard-title" style={{ fontSize: "var(--font-size-xl)",
                                            marginBottom: "var(--space-3)" }}>
              Where are your replays?
            </h2>
            <p style={{ fontSize: "var(--font-size-sm)",
                        color: "var(--color-text-secondary)",
                        marginBottom: "var(--space-4)" }}>
              We checked the usual places. Pick one or more &mdash; multi-account
              and multi-region setups should select every folder that's yours.
            </p>
            {scanning ? <div style={{ color: "var(--color-text-muted)" }}>Scanning…</div> : null}
            <WizardError>{scanError}</WizardError>
            <div style={{ display: "flex", flexDirection: "column",
                          gap: "var(--space-2)" }}>
              {(folders || []).map((f) => (
                <WizardFolderRow key={f.path} folder={f}
                                 selected={selected} onToggle={onToggle} />
              ))}
            </div>
            <WizardCustomFolderRow
              customInput={customInput}
              canAdd={canAddCustom}
              onCustomInput={onCustomInput}
              onAddCustom={onAddCustom} />
            <WizardSelectedFolders selected={selected} onToggle={onToggle} />
            <WizardNavRow>
              <WizardButton kind="secondary" onClick={onBack}>Back</WizardButton>
              <WizardButton kind="secondary" onClick={onRescan}>Rescan</WizardButton>
              <WizardButton onClick={onNext}
                            disabled={!(selected && selected.length > 0)}>
                Next
              </WizardButton>
            </WizardNavRow>
          </div>
        );
      }

      function WizardCustomFolderRow({ customInput, canAdd,
                                       onCustomInput, onAddCustom }) {
        const onKey = (e) => {
          if (e.key === "Enter" && canAdd) { e.preventDefault(); onAddCustom(); }
        };
        return (
          <div style={{ marginTop: "var(--space-4)" }}>
            <WizardField label="Add a custom folder path"
                         htmlFor="wzr-custom-folder"
                         hint="Press Enter or click Add to include it.">
              <div style={{ display: "flex", gap: "var(--space-2)" }}>
                <WizardInput id="wzr-custom-folder"
                             placeholder="C:\\Users\\you\\...\\Replays\\Multiplayer"
                             value={customInput || ""}
                             onKeyDown={onKey}
                             onChange={(e) => onCustomInput(e.target.value)} />
                <WizardButton kind="secondary" onClick={onAddCustom}
                              disabled={!canAdd}>Add</WizardButton>
              </div>
            </WizardField>
          </div>
        );
      }

      function WizardSelectedFolders({ selected, onToggle }) {
        const list = selected || [];
        if (list.length === 0) return null;
        return (
          <div style={{
            marginTop: "var(--space-3)",
            padding: "var(--space-3)",
            background: "var(--color-bg-primary)",
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--color-border-subtle)",
          }}>
            <div style={{ fontSize: "var(--font-size-xs)",
                          color: "var(--color-text-secondary)",
                          marginBottom: "var(--space-2)" }}>
              Selected ({list.length}):
            </div>
            <div style={{ display: "flex", flexDirection: "column",
                          gap: "var(--space-1)" }}>
              {list.map((p) => (
                <div key={p} style={{
                  display: "flex", gap: "var(--space-2)",
                  alignItems: "center",
                  fontSize: "var(--font-size-xs)",
                  fontFamily: "var(--font-family-mono)",
                  color: "var(--color-text-primary)",
                }}>
                  <span style={{ flex: 1, wordBreak: "break-all" }}>{p}</span>
                  <button type="button" onClick={() => onToggle(p)}
                    aria-label={`Remove ${p}`}
                    style={{
                      background: "transparent",
                      color: "var(--color-text-muted)",
                      border: "1px solid var(--color-border-subtle)",
                      borderRadius: "var(--radius-sm)",
                      padding: "var(--space-1) var(--space-2)",
                      cursor: "pointer",
                    }}>×</button>
                </div>
              ))}
            </div>
          </div>
        );
      }

      // ---- Step 3: Identity -------------------------------------

      function WizardIdentityRow({ player, selectedIds, battleTag,
                                   onSetBattleTag, onToggle }) {
        const id = `wzr-id-${player.character_id}`;
        const isSel = (selectedIds || []).includes(player.character_id);
        const races = player.races || {};
        const total = (races.Protoss || 0) + (races.Terran || 0)
                    + (races.Zerg || 0) + (races.Random || 0);
        const breakdown = total > 0
          ? WIZARD_RACES
              .map((r) => ({ r, n: races[r] || 0 }))
              .filter((x) => x.n > 0)
              .map((x) => `${x.r[0]} ${Math.round(100 * x.n / total)}%`)
              .join(" · ")
          : "";
        return (
          <tr style={{ borderTop: "1px solid var(--color-divider)" }}>
            <td style={{ padding: "var(--space-1)" }}>
              <input id={id} type="checkbox"
                     checked={isSel}
                     onChange={() => onToggle(player)} />
            </td>
            <td style={{ padding: "var(--space-1)" }}>
              <label htmlFor={id}>{player.name}</label>
              {breakdown ? (
                <div style={{ fontSize: "var(--font-size-xs)",
                               color: "var(--color-text-muted)" }}>
                  {breakdown}
                </div>
              ) : null}
            </td>
            <td style={{ padding: "var(--space-1)" }}>
              <input type="text" value={battleTag || ""}
                     onChange={(e) => onSetBattleTag(
                       player.character_id, e.target.value)}
                     placeholder="Name#1234"
                     style={{ width: "100%", padding: "2px 6px",
                              fontSize: "var(--font-size-sm)",
                              fontFamily: "var(--font-family-mono)",
                              background: "var(--color-bg-input)",
                              border: "1px solid var(--color-border)",
                              borderRadius: "var(--radius-sm)",
                              color: "var(--color-text-primary)" }} />
            </td>
            <td style={{ padding: "var(--space-1)",
                         fontFamily: "var(--font-family-mono)",
                         color: "var(--color-text-muted)" }}>
              {player.character_id}
            </td>
            <td style={{ padding: "var(--space-1)", textAlign: "right" }}>
              {player.games_seen}
            </td>
          </tr>
        );
      }

      function WizardIdentityTable({ identities, selectedIds, battleTags,
                                     onSetBattleTag, onToggle }) {
        return (
          <table style={{ width: "100%", borderCollapse: "collapse",
                           fontSize: "var(--font-size-sm)" }}>
            <thead>
              <tr style={{ color: "var(--color-text-secondary)" }}>
                <th style={{ textAlign: "left",  padding: "var(--space-1)" }}>Pick</th>
                <th style={{ textAlign: "left",  padding: "var(--space-1)" }}>Name</th>
                <th style={{ textAlign: "left",  padding: "var(--space-1)" }}>BattleTag</th>
                <th style={{ textAlign: "left",  padding: "var(--space-1)" }}>Regional folder ID</th>
                <th style={{ textAlign: "right", padding: "var(--space-1)" }}>Games</th>
              </tr>
            </thead>
            <tbody>
              {(identities || []).map((p) => (
                <WizardIdentityRow key={p.character_id} player={p}
                                   selectedIds={selectedIds}
                                   battleTag={(battleTags || {})[p.character_id] || ""}
                                   onSetBattleTag={onSetBattleTag}
                                   onToggle={onToggle} />
              ))}
            </tbody>
          </table>
        );
      }

      function WizardStepIdentity({ scanning, scanError, identities,
                                    selectedIds, battleTags, onSetBattleTag,
                                    onToggle, onRescan,
                                    onNext, onBack }) {
        const count = (selectedIds || []).length;
        return (
          <div style={{ padding: "var(--space-6)" }}>
            <h2 id="wizard-title" style={{ fontSize: "var(--font-size-xl)",
                                            marginBottom: "var(--space-3)" }}>
              Which of these are you?
            </h2>
            <p style={{ fontSize: "var(--font-size-sm)",
                        color: "var(--color-text-secondary)",
                        marginBottom: "var(--space-4)" }}>
              Check every account that's yours &mdash; including alt regions
              and other Battle.net accounts. The most-played one becomes
              your primary identity; the others are tracked for stat
              filtering and SC2Pulse aggregation.
            </p>
            {scanning ? <div style={{ color: "var(--color-text-muted)" }}>Scanning replays…</div> : null}
            <WizardError>{scanError}</WizardError>
            <WizardIdentityTable identities={identities}
                                 selectedIds={selectedIds}
                                 battleTags={battleTags}
                                 onSetBattleTag={onSetBattleTag}
                                 onToggle={onToggle} />
            <WizardNavRow>
              <WizardButton kind="secondary" onClick={onBack}>Back</WizardButton>
              <WizardButton kind="secondary" onClick={onRescan}>Rescan</WizardButton>
              <WizardButton onClick={onNext} disabled={count === 0}>
                Next ({count})
              </WizardButton>
            </WizardNavRow>
          </div>
        );
      }

      // ---- Step 4: Race -----------------------------------------

      function WizardRaceTile({ race, selectedRaces, onToggle }) {
        const id = `wzr-race-${race}`;
        const sel = (selectedRaces || []).includes(race);
        return (
          <label htmlFor={id} style={{
            flex: "1 1 140px",
            background: sel ? "var(--color-bg-elevated)" : "var(--color-bg-primary)",
            border: sel
              ? "1px solid var(--color-info)"
              : "1px solid var(--color-border-default)",
            borderRadius: "var(--radius-md)",
            padding: "var(--space-3)", cursor: "pointer",
            display: "flex", alignItems: "center", gap: "var(--space-2)",
          }}>
            <input id={id} type="checkbox"
                   checked={sel} onChange={() => onToggle(race)} />
            <span>{race}</span>
          </label>
        );
      }

      function WizardStepRace({ selectedRaces, onToggle, onNext, onBack }) {
        const list = selectedRaces || [];
        const hasRandom = list.includes("Random");
        const hasMulti = list.length > 1;
        return (
          <div style={{ padding: "var(--space-6)" }}>
            <h2 id="wizard-title" style={{ fontSize: "var(--font-size-xl)",
                                            marginBottom: "var(--space-3)" }}>
              Which races do you play?
            </h2>
            <fieldset style={{ border: "none", padding: 0 }}>
              <legend style={{ fontSize: "var(--font-size-sm)",
                               color: "var(--color-text-secondary)",
                               marginBottom: "var(--space-3)" }}>
                Pick every race you regularly play. Single-race players
                check one; off-race or Random players check multiple.
              </legend>
              <div style={{ display: "flex", gap: "var(--space-2)",
                            flexWrap: "wrap" }}>
                {WIZARD_RACES.map((r) => (
                  <WizardRaceTile key={r} race={r}
                                  selectedRaces={list}
                                  onToggle={onToggle} />
                ))}
              </div>
            </fieldset>
            {hasRandom ? (
              <p style={{ fontSize: "var(--font-size-sm)",
                          color: "var(--color-text-secondary)",
                          marginTop: "var(--space-3)" }}>
                With Random selected we'll track per-race stats whenever
                the actual race is known.
              </p>
            ) : null}
            {hasMulti && !hasRandom ? (
              <p style={{ fontSize: "var(--font-size-sm)",
                          color: "var(--color-text-secondary)",
                          marginTop: "var(--space-3)" }}>
                Multi-race players: stats default to a per-race breakdown.
              </p>
            ) : null}
            <WizardNavRow>
              <WizardButton kind="secondary" onClick={onBack}>Back</WizardButton>
              <WizardButton onClick={onNext} disabled={list.length === 0}>
                Next ({list.length})
              </WizardButton>
            </WizardNavRow>
          </div>
        );
      }

      // ---- Step 5: Integrations (3 collapsible cards) -----------


  // Expose to global so inline-block JSX in index.html can render
  // these as bare identifiers.
  Object.assign(window, {
    WizardStepWelcome,
    WizardFolderRow,
    WizardStepReplays,
    WizardCustomFolderRow,
    WizardSelectedFolders,
    WizardIdentityRow,
    WizardIdentityTable,
    WizardStepIdentity,
    WizardRaceTile,
    WizardStepRace
  });
})();
