/**
 * Settings profile — extracted from index.html for size-rule compliance.
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

      function SettingsProfileBattleNetGroup({ bn, errors, onPatch }) {
        return (
          <>
            <div>
              <SettingsLabel htmlFor="settings-battle-tag"
                hint="Blizzard handle, e.g. ReSpOnSe#1872">BattleTag</SettingsLabel>
              <SettingsInput id="settings-battle-tag"
                value={bn.battle_tag || ""}
                onChange={(e) => onPatch(
                  ["battlenet", "battle_tag"], e.target.value)}
                placeholder="ReSpOnSe#0"
                invalid={!!errors["battlenet.battle_tag"]} />
              <SettingsErrorList errors={errors["battlenet.battle_tag"]} />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <SettingsLabel htmlFor="settings-character-id"
                  hint="e.g. 1-S2-1-267727 — the folder under Documents\StarCraft II\Accounts\<acct>\">
                  Regional profile / replay-folder ID</SettingsLabel>
                <SettingsInput id="settings-character-id"
                  value={bn.character_id || ""}
                  onChange={(e) => onPatch(
                    ["battlenet", "character_id"], e.target.value)}
                  placeholder="1-S2-1-267727"
                  invalid={!!errors["battlenet.character_id"]} />
                <SettingsErrorList errors={errors["battlenet.character_id"]} />
              </div>
              <div>
                <SettingsLabel htmlFor="settings-account-id"
                  hint="e.g. 50983875 — the parent folder under Documents\StarCraft II\Accounts\">
                  Battle.net account number</SettingsLabel>
                <SettingsInput id="settings-account-id"
                  value={bn.account_id || ""}
                  onChange={(e) => onPatch(
                    ["battlenet", "account_id"], e.target.value)}
                  placeholder="50983875"
                  invalid={!!errors["battlenet.account_id"]} />
                <SettingsErrorList errors={errors["battlenet.account_id"]} />
              </div>
            </div>
            <div>
              <SettingsLabel htmlFor="settings-region">Region</SettingsLabel>
              <SettingsSelect id="settings-region" value={bn.region || "us"}
                onChange={(e) => onPatch(
                  ["battlenet", "region"], e.target.value)}
                options={SETTINGS_REGIONS}
                invalid={!!errors["battlenet.region"]} />
              <SettingsErrorList errors={errors["battlenet.region"]} />
            </div>
          </>
        );
      }

      function SettingsProfileRacesGroup({ races, errors, onPatch }) {
        const list = races || [];
        const toggle = (race) => {
          const next = list.includes(race)
            ? list.filter(r => r !== race)
            : [...list, race];
          onPatch(["races"], next);
        };
        return (
          <div>
            <SettingsLabel>Races you regularly play</SettingsLabel>
            <div className="flex flex-wrap gap-3 mt-1">
              {SETTINGS_RACES.map(r => (
                <SettingsCheckbox key={r} id={"settings-race-" + r}
                  checked={list.includes(r)} onChange={() => toggle(r)}
                  label={r} />
              ))}
            </div>
            <SettingsErrorList errors={errors["races"]} />
          </div>
        );
      }

      function SettingsProfileTuningGroup({ profile, errors, onPatch }) {
        const mmrChange = (e) => {
          if (e.target.value === "") { onPatch(["mmr_target"], null); return; }
          const v = Number(e.target.value);
          onPatch(["mmr_target"], Number.isFinite(v) ? v : null);
        };
        return (
          <>
            <div>
              <SettingsLabel htmlFor="settings-mmr-target" hint="optional">
                MMR target
              </SettingsLabel>
              <SettingsInput id="settings-mmr-target" type="number"
                min="0" max="8000"
                value={profile.mmr_target == null
                  ? "" : String(profile.mmr_target)}
                onChange={mmrChange}
                placeholder="e.g. 4500"
                invalid={!!errors["mmr_target"]} />
              <SettingsErrorList errors={errors["mmr_target"]} />
            </div>
            <div>
              <SettingsLabel htmlFor="settings-replay-name">
                In-replay player name
              </SettingsLabel>
              <SettingsInput id="settings-replay-name"
                value={profile.preferred_player_name_in_replays || ""}
                onChange={(e) => onPatch(
                  ["preferred_player_name_in_replays"], e.target.value)}
                placeholder="ReSpOnSe"
                invalid={!!errors["preferred_player_name_in_replays"]} />
              <SettingsErrorList
                errors={errors["preferred_player_name_in_replays"]} />
            </div>
          </>
        );
      }

      function SettingsProfilePanel({ profile, config,
                                      errors, onPatch, onPatchConfig }) {
        const identities = (config && config.identities) || [];
        const pulseIds = settingsPulseIdsFromConfig(config);
        // Backfill: existing onboarding only stored a flat global
        // pulse_character_ids[]. If any identity row is missing pulse_id
        // and we have IDs in the global array, copy them in by index.
        // Runs once per dataset shape change; the user just clicks Save
        // to persist the migration.
        useEffect(() => {
          if (identities.length === 0 || pulseIds.length === 0) return;
          const needsBackfill = identities.some((row, i) =>
            !row.pulse_id && !!pulseIds[i]);
          if (!needsBackfill) return;
          const next = identities.map((row, i) => row.pulse_id
            ? row : { ...row, pulse_id: String(pulseIds[i] || "") });
          // Drop empty-string pulse_id keys so the schema (pattern
          // ^[0-9]+$) doesn't reject the row.
          const cleaned = next.map((row) => {
            if (row.pulse_id) return row;
            const { pulse_id: _drop, ...rest } = row;
            return rest;
          });
          onPatchConfig(["identities"], cleaned);
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [identities.length, pulseIds.join(",")]);
        // Keep profile.battlenet in sync with the primary identity row
        // (most-played, falling back to the first). Schema requires
        // battlenet on profile.json; we derive it instead of asking the
        // user to maintain two copies.
        useEffect(() => {
          const primary = settingsPickPrimaryIdentity(identities);
          if (!primary) return;
          const next = settingsBattlenetFromIdentity(primary,
            (profile && profile.battlenet) || {});
          if (next && !settingsShallowEqual(next, profile.battlenet)) {
            onPatch(["battlenet"], next);
          }
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [JSON.stringify(identities)]);
        return (
          <div className="space-y-4 max-w-3xl">
            <SettingsProfileIdentitiesGroup
              identities={identities}
              pulseIds={pulseIds}
              errors={errors} onPatchConfig={onPatchConfig} />
            <SettingsProfileRacesGroup races={profile.races}
              errors={errors} onPatch={onPatch} />
            <SettingsProfileTuningGroup profile={profile}
              errors={errors} onPatch={onPatch} />
          </div>
        );
      }

      // --- Identities (multi-region) -----------------------------
      // Sourced from the data onboarding already saved:
      //   config.identities[]                  (one per Bnet account/region)
      //   config.stream_overlay.pulse_character_ids[]  (SC2Pulse numeric ids)
      // BattleTag isn't captured at onboarding (it stubs as Name#0), so the
      // user fills it per-row here. The schema (Stage settings-pr1b) carries
      // optional battle_tag + pulse_id per identity for round-tripping.

      function settingsPulseIdsFromConfig(config) {
        const so = (config && config.stream_overlay) || {};
        const ids = Array.isArray(so.pulse_character_ids)
          ? so.pulse_character_ids.slice() : [];
        return ids;
      }

      function settingsRegionFromCharacterId(cid) {
        if (typeof cid !== "string") return "";
        const m = cid.match(/^([1-5])-S2-/);
        if (!m) return "";
        return ({ "1": "us", "2": "eu", "3": "kr", "5": "cn", "6": "sea" })[m[1]] || "";
      }

      function settingsBlankIdentity() {
        return { name: "", battle_tag: "", character_id: "",
                 account_id: "", region: "us" };
      }

      function settingsPickPrimaryIdentity(identities) {
        if (!Array.isArray(identities) || identities.length === 0) return null;
        // Pick the first row that has a battle_tag + character_id; fall back
        // to the first row overall. (We don't have games_seen at this point;
        // the user can re-order rows in a future PR.)
        for (const row of identities) {
          if (row && row.battle_tag && row.character_id) return row;
        }
        return identities[0];
      }

      function settingsBattlenetFromIdentity(row, current) {
        // Only emit a battlenet object once we have all four required
        // fields; otherwise leave the existing one alone so the schema
        // doesn't reject mid-edit states.
        if (!row || !row.battle_tag || !row.character_id
            || !row.account_id || !row.region) {
          return null;
        }
        return {
          battle_tag: row.battle_tag,
          character_id: row.character_id,
          account_id: row.account_id,
          region: row.region,
        };
      }

      function settingsShallowEqual(a, b) {
        if (a === b) return true;
        if (!a || !b) return false;
        const ka = Object.keys(a), kb = Object.keys(b);
        if (ka.length !== kb.length) return false;
        for (const k of ka) if (a[k] !== b[k]) return false;
        return true;
      }


      function SettingsProfileIdentitiesGroup({ identities, pulseIds,
                                                errors, onPatchConfig }) {
        const rows = identities.length > 0 ? identities : [];
        const setRow = (idx, key, value) => {
          const next = rows.map((r, i) => {
            if (i !== idx) return r;
            const merged = { ...r, [key]: value };
            // Optional fields with regex patterns (battle_tag, pulse_id,
            // account_id) can't be empty strings -- ajv pattern check
            // rejects "". Drop the key when the user clears it.
            if ((key === "battle_tag" || key === "pulse_id"
                 || key === "account_id") && value === "") {
              delete merged[key];
            }
            return merged;
          });
          if (key === "character_id") {
            const region = settingsRegionFromCharacterId(value);
            if (region) next[idx].region = region;
          }
          onPatchConfig(["identities"], next);
        };
        const addRow = () => onPatchConfig(["identities"],
          [...rows, settingsBlankIdentity()]);
        const removeRow = (idx) => onPatchConfig(["identities"],
          rows.filter((_, i) => i !== idx));
        return (
          <fieldset className="border border-base-700 rounded p-4">
            <legend className="px-2 text-sm font-semibold text-neutral-100">
              Connected Battle.net accounts
            </legend>
            <p className="text-xs text-neutral-400 mb-3 leading-relaxed">
              One row per region you play on. Onboarding pre-filled the
              in-replay name, regional folder ID, account number, and the
              SC2Pulse numeric ID for each identity it found. BattleTag
              isn't captured automatically &mdash; type yours in. Stored as
              <code className="text-neutral-300 mx-1">config.identities[]</code>
              + <code className="text-neutral-300 ml-1">
              stream_overlay.pulse_character_ids[]</code>.
            </p>
            {pulseIds.length > 0 && rows.length > 0 ? (
              <p className="text-xs text-neutral-500 mb-3">
                SC2Pulse IDs captured globally:
                <span className="text-neutral-300 ml-1 font-mono">
                  {pulseIds.join(", ")}
                </span>
              </p>
            ) : null}
            {rows.length === 0 ? (
              <p className="text-xs text-neutral-500 mb-3">
                No identities saved yet. Run the onboarding wizard or add
                one manually below.
              </p>
            ) : null}
            <ul className="space-y-3">
              {rows.map((row, i) => (
                <SettingsIdentityRow key={i} row={row} index={i}
                  errors={errors} onChange={setRow} onRemove={removeRow} />
              ))}
            </ul>
            <div className="mt-3">
              <SettingsButton kind="secondary" onClick={addRow}>
                + Add identity
              </SettingsButton>
            </div>
          </fieldset>
        );
      }

      function SettingsIdentityRow({ row, index, errors, onChange, onRemove }) {
        const errBase = "identities[" + index + "].";
        return (
          <li className="bg-base-900 border border-base-700 rounded p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-neutral-400">
                Identity #{index + 1}
                {row.region ? (
                  <span className="ml-2 px-1.5 py-0.5 bg-base-800 rounded
                                  text-neutral-300 uppercase">
                    {row.region}
                  </span>
                ) : null}
              </span>
              <SettingsButton kind="danger"
                onClick={() => onRemove(index)}
                ariaLabel={"Remove identity " + (index + 1)}>
                Remove
              </SettingsButton>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <SettingsLabel htmlFor={"settings-id-name-" + index}
                  hint="from replay player slot">In-replay name</SettingsLabel>
                <SettingsInput id={"settings-id-name-" + index}
                  value={row.name || ""}
                  onChange={(e) => onChange(index, "name", e.target.value)}
                  placeholder="ReSpOnSe"
                  invalid={!!errors[errBase + "name"]} />
                <SettingsErrorList errors={errors[errBase + "name"]} />
              </div>
              <div>
                <SettingsLabel htmlFor={"settings-id-bt-" + index}
                  hint="Blizzard handle, e.g. ReSpOnSe#1872">BattleTag</SettingsLabel>
                <SettingsInput id={"settings-id-bt-" + index}
                  value={row.battle_tag || ""}
                  onChange={(e) => onChange(index, "battle_tag", e.target.value)}
                  placeholder="Name#1234"
                  invalid={!!errors[errBase + "battle_tag"]} />
                <SettingsErrorList errors={errors[errBase + "battle_tag"]} />
              </div>
              <div>
                <SettingsLabel htmlFor={"settings-id-cid-" + index}
                  hint="folder name under Documents\StarCraft II\Accounts\<acct>\">
                  Regional profile / replay-folder ID</SettingsLabel>
                <SettingsInput id={"settings-id-cid-" + index}
                  value={row.character_id || ""}
                  onChange={(e) => onChange(index, "character_id", e.target.value)}
                  placeholder="1-S2-1-267727"
                  invalid={!!errors[errBase + "character_id"]} />
                <SettingsErrorList errors={errors[errBase + "character_id"]} />
              </div>
              <div>
                <SettingsLabel htmlFor={"settings-id-acct-" + index}
                  hint="parent folder under Documents\StarCraft II\Accounts\">
                  Battle.net account number</SettingsLabel>
                <SettingsInput id={"settings-id-acct-" + index}
                  value={row.account_id || ""}
                  onChange={(e) => onChange(index, "account_id", e.target.value)}
                  placeholder="50983875"
                  invalid={!!errors[errBase + "account_id"]} />
                <SettingsErrorList errors={errors[errBase + "account_id"]} />
              </div>
              <div>
                <SettingsLabel htmlFor={"settings-id-pulse-" + index}
                  hint="from sc2pulse.nephest.com URL, e.g. ?id=994428">
                  SC2Pulse character ID</SettingsLabel>
                <SettingsInput id={"settings-id-pulse-" + index}
                  value={row.pulse_id || ""}
                  onChange={(e) => onChange(index, "pulse_id", e.target.value)}
                  placeholder="994428"
                  invalid={!!errors[errBase + "pulse_id"]} />
                <SettingsErrorList errors={errors[errBase + "pulse_id"]} />
              </div>
              <div>
                <SettingsLabel htmlFor={"settings-id-region-" + index}>
                  Region</SettingsLabel>
                <SettingsSelect id={"settings-id-region-" + index}
                  value={row.region || "us"}
                  onChange={(e) => onChange(index, "region", e.target.value)}
                  options={SETTINGS_REGIONS}
                  invalid={!!errors[errBase + "region"]} />
                <SettingsErrorList errors={errors[errBase + "region"]} />
              </div>
            </div>
          </li>
        );
      }


  // Expose to global so inline-block JSX in index.html can render
  // these as bare identifiers.
  Object.assign(window, {
    SettingsProfileBattleNetGroup,
    SettingsProfileRacesGroup,
    SettingsProfileTuningGroup,
    SettingsProfilePanel,
    settingsPulseIdsFromConfig,
    settingsRegionFromCharacterId,
    settingsBlankIdentity,
    settingsPickPrimaryIdentity,
    settingsBattlenetFromIdentity,
    settingsShallowEqual,
    SettingsProfileIdentitiesGroup,
    SettingsIdentityRow
  });
})();
