/**
 * Wizard integrations — extracted from index.html for size-rule compliance.
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

      function WizardIntegrationCard({ title, expanded, onToggle, children }) {
        return (
          <div style={{
            background: "var(--color-bg-elevated)",
            border: "1px solid var(--color-border-subtle)",
            borderRadius: "var(--radius-md)",
            marginBottom: "var(--space-2)",
          }}>
            <button type="button" onClick={onToggle} aria-expanded={expanded}
              style={{
                width: "100%", textAlign: "left", padding: "var(--space-3)",
                background: "transparent", color: "var(--color-text-primary)",
                border: "none", cursor: "pointer", fontWeight: 500,
                fontSize: "var(--font-size-sm)",
              }}>
              {expanded ? "▾ " : "▸ "}{title}
            </button>
            {expanded
              ? <div style={{ padding: "0 var(--space-3) var(--space-3)" }}>
                  {children}
                </div>
              : null}
          </div>
        );
      }

      function WizardTestStatus({ status }) {
        if (!status) return null;
        const colorMap = {
          ok:      "var(--color-success)",
          fail:    "var(--color-danger)",
          testing: "var(--color-text-muted)",
        };
        return (
          <div role="status" aria-live="polite"
               style={{ marginTop: "var(--space-2)",
                        fontSize: "var(--font-size-xs)",
                        color: colorMap[status.kind] || "var(--color-text-muted)" }}>
            {status.message}
          </div>
        );
      }

      function WizardHowTo({ title, steps }) {
        return (
          <details style={{
            marginBottom: "var(--space-3)",
            background: "var(--color-bg-primary)",
            border: "1px solid var(--color-border-subtle)",
            borderRadius: "var(--radius-md)",
            padding: "var(--space-2) var(--space-3)",
          }}>
            <summary style={{
              cursor: "pointer", fontSize: "var(--font-size-sm)",
              color: "var(--color-text-secondary)",
            }}>
              {title}
            </summary>
            <ol style={{
              margin: "var(--space-2) 0 0",
              paddingLeft: "var(--space-6)",
              fontSize: "var(--font-size-sm)",
              lineHeight: "var(--line-height-relaxed)",
              color: "var(--color-text-primary)",
            }}>
              {steps.map((step, i) => (
                <li key={i} style={{ marginBottom: "var(--space-1)" }}>
                  {step}
                </li>
              ))}
            </ol>
          </details>
        );
      }

      function WizardCopyBox({ value }) {
        const [copied, setCopied] = useState(false);
        const onCopy = async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch (_e) { /* no-op */ }
        };
        return (
          <div style={{ display: "flex", gap: "var(--space-2)",
                        marginBottom: "var(--space-3)" }}>
            <code style={{
              flex: 1,
              padding: "var(--space-2) var(--space-3)",
              background: "var(--color-bg-primary)",
              border: "1px solid var(--color-border-default)",
              borderRadius: "var(--radius-md)",
              fontFamily: "var(--font-family-mono)",
              fontSize: "var(--font-size-sm)",
              wordBreak: "break-all",
            }}>{value}</code>
            <WizardButton kind="secondary" onClick={onCopy}>
              {copied ? "Copied!" : "Copy"}
            </WizardButton>
          </div>
        );
      }

      const PULSE_LEAGUE_LABEL = {
        0: "Bronze", 1: "Silver", 2: "Gold", 3: "Platinum",
        4: "Diamond", 5: "Master", 6: "Grandmaster",
      };

      function WizardPulseMatchRow({ match, selectedIds, onPick }) {
        const isSel = (selectedIds || []).includes(match.pulse_id);
        const league = PULSE_LEAGUE_LABEL[match.league_max];
        const meta = [
          (match.region || "?").toUpperCase(),
          league || null,
          (match.rating_max != null) ? `MMR ${match.rating_max}` : null,
          (match.games_played != null) ? `${match.games_played} games` : null,
        ].filter(Boolean).join(" · ");
        return (
          <div style={{
            display: "flex", gap: "var(--space-2)",
            alignItems: "center", padding: "var(--space-2)",
            background: isSel
              ? "var(--color-bg-elevated)" : "var(--color-bg-primary)",
            border: isSel
              ? "1px solid var(--color-info)"
              : "1px solid var(--color-border-subtle)",
            borderRadius: "var(--radius-md)",
            marginBottom: "var(--space-2)",
          }}>
            <div style={{ flex: 1, fontSize: "var(--font-size-sm)" }}>
              <div style={{ color: "var(--color-text-primary)" }}>
                {match.name || "(unnamed)"}
              </div>
              <div style={{
                color: "var(--color-text-muted)",
                fontSize: "var(--font-size-xs)",
                fontFamily: "var(--font-family-mono)",
              }}>
                pulse_id={match.pulse_id} {meta ? "· " + meta : ""}
              </div>
            </div>
            <WizardButton kind={isSel ? "primary" : "secondary"}
                          onClick={() => onPick(match)}>
              {isSel ? "Picked ✓" : "This one"}
            </WizardButton>
          </div>
        );
      }

      function WizardPulseSearchResults({ pulse, onPick }) {
        const matches = pulse.matches || [];
        if (pulse.searchStatus?.kind === "fail") {
          return <WizardError>{pulse.searchStatus.message}</WizardError>;
        }
        if (matches.length === 0 && pulse.searchStatus?.kind === "ok") {
          return (
            <p style={{ fontSize: "var(--font-size-sm)",
                        color: "var(--color-text-secondary)" }}>
              No SC2Pulse profile found for that name. Try a different
              spelling or check the player exists on
              sc2pulse.nephest.com.
            </p>
          );
        }
        if (matches.length === 0) return null;
        return (
          <div style={{ marginBottom: "var(--space-3)" }}>
            <div style={{ fontSize: "var(--font-size-xs)",
                          color: "var(--color-text-secondary)",
                          marginBottom: "var(--space-2)" }}>
              Multiple matches? Pick every row that's yours &mdash;
              multi-region / alt accounts are normal here.
            </div>
            {matches.map((m) => (
              <WizardPulseMatchRow key={m.pulse_id} match={m}
                                   selectedIds={pulse.character_ids}
                                   onPick={onPick} />
            ))}
          </div>
        );
      }

      function WizardPulseCard({ pulse, onChange, onSearch, onPickMatch,
                                  onTest, expanded, onToggle }) {
        const busy = pulse.status?.kind === "testing";
        const searching = pulse.searchStatus?.kind === "searching";
        const term = pulse.search_term || "";
        return (
          <WizardIntegrationCard title="SC2Pulse (recommended) — live MMR"
                                 expanded={expanded} onToggle={onToggle}>
            <p style={{ fontSize: "var(--font-size-sm)",
                        color: "var(--color-text-secondary)",
                        marginBottom: "var(--space-3)" }}>
              SC2Pulse is the community ladder API. Search by your in-game
              name and pick your profile from the list &mdash; we save the
              SC2Pulse ID for you, no manual ID hunting required.
            </p>
            <WizardField label="Search by name" htmlFor="wzr-pulse-name"
                         hint="Default-filled from your Step 3 identity. Change if needed.">
              <div style={{ display: "flex", gap: "var(--space-2)" }}>
                <WizardInput id="wzr-pulse-name"
                             placeholder="e.g. ReSpOnSe"
                             value={term}
                             onChange={(e) => onChange({ search_term: e.target.value })} />
                <WizardButton kind="secondary" onClick={onSearch}
                              disabled={!term || searching}>
                  {searching ? "Searching…" : "Search"}
                </WizardButton>
              </div>
            </WizardField>
            <WizardPulseSearchResults pulse={pulse} onPick={onPickMatch} />
            {(pulse.character_ids || []).length > 0 ? (
              <div style={{
                fontSize: "var(--font-size-xs)",
                color: "var(--color-text-muted)",
                marginBottom: "var(--space-2)",
              }}>
                Picked {(pulse.character_ids || []).length}:
                {" "}{(pulse.character_ids || []).join(", ")}
              </div>
            ) : null}
            <WizardButton kind="secondary" onClick={onTest}
                          disabled={(pulse.character_ids || []).length === 0 || busy}>
              {busy ? "Testing…" : "Test connection"}
            </WizardButton>
            <WizardTestStatus status={pulse.status} />
          </WizardIntegrationCard>
        );
      }

      function WizardTwitchCard({ twitch, onChange, onTest, expanded, onToggle }) {
        const busy = twitch.status?.kind === "testing";
        return (
          <WizardIntegrationCard title="Twitch — chat bot for !commands"
                                 expanded={expanded} onToggle={onToggle}>
            <p style={{ fontSize: "var(--font-size-sm)",
                        color: "var(--color-text-secondary)",
                        marginBottom: "var(--space-3)" }}>
              The bot replies to <code>!session</code> / <code>!record</code>
              in your chat. Skip this if you don't stream.
            </p>
            <WizardHowTo title="How do I generate an OAuth token?"
              steps={[
                <span key="s1">Open <a href="https://twitchtokengenerator.com"
                  target="_blank" rel="noopener noreferrer"
                  style={{ color: "var(--color-info)" }}>
                  twitchtokengenerator.com</a> in a new tab.</span>,
                "Pick \"Bot Chat Token\" (the 2nd option).",
                "Authorize with the Twitch account that should send the messages — usually your own.",
                "Copy the \"ACCESS TOKEN\" value (starts with letters/numbers, NOT \"oauth:\" prefix).",
                "Paste it below. Channel = your Twitch login (lowercase).",
              ]} />
            <WizardField label="Channel" htmlFor="wzr-twitch-ch"
                         hint="Your Twitch login, lowercase (no #)">
              <WizardInput id="wzr-twitch-ch"
                           value={twitch.channel || ""}
                           onChange={(e) => onChange({ channel: e.target.value })} />
            </WizardField>
            <WizardField label="OAuth token" htmlFor="wzr-twitch-tok"
                         hint="The Access Token from twitchtokengenerator.com.">
              <WizardInput id="wzr-twitch-tok" type="password"
                           value={twitch.oauth_token || ""}
                           onChange={(e) => onChange({ oauth_token: e.target.value })} />
            </WizardField>
            <WizardButton kind="secondary" onClick={onTest}
                          disabled={!twitch.oauth_token || busy}>
              {busy ? "Testing…" : "Test connection"}
            </WizardButton>
            <WizardTestStatus status={twitch.status} />
          </WizardIntegrationCard>
        );
      }

      function WizardObsCard({ obs, onChange, onTest, expanded, onToggle }) {
        const busy = obs.status?.kind === "testing";
        return (
          <WizardIntegrationCard title="OBS Studio — control + overlay"
                                 expanded={expanded} onToggle={onToggle}>
            <p style={{ fontSize: "var(--font-size-sm)",
                        color: "var(--color-text-secondary)",
                        marginBottom: "var(--space-3)" }}>
              Lets us flip scenes and read OBS state. Pair with the Browser
              Source URL below to also display the live overlay in OBS.
            </p>
            <WizardHowTo title="How do I enable OBS WebSocket?"
              steps={[
                "In OBS Studio (must be 28.0 or newer), open the menu: Tools → WebSocket Server Settings.",
                "Tick \"Enable WebSocket server\".",
                "Leave the Server Port at 4455 unless something else is using it.",
                "Tick \"Enable Authentication\" and click Generate Password.",
                "Copy the generated password.",
                "Click Apply / OK in OBS.",
                "Paste host (127.0.0.1), port (4455), and the generated password below, then Test connection.",
              ]} />
            <WizardHowTo title="How do I add the live overlay as a Browser Source?"
              steps={[
                "In OBS, click the + under Sources and pick \"Browser\".",
                "Name it (e.g. \"SC2 Overlay\") and click OK.",
                "Paste the URL from the Streamlabs / Browser-source card below.",
                "Set the Width to 1920 and Height to 1080.",
                "Tick \"Refresh browser when scene becomes active\".",
              ]} />
            <WizardField label="Host" htmlFor="wzr-obs-host"
                         hint="127.0.0.1 if OBS runs on this same PC.">
              <WizardInput id="wzr-obs-host"
                           value={obs.host || WIZARD_DEFAULT_OBS_HOST}
                           onChange={(e) => onChange({ host: e.target.value })} />
            </WizardField>
            <WizardField label="Port" htmlFor="wzr-obs-port"
                         hint="4455 unless you changed it.">
              <WizardInput id="wzr-obs-port" type="number"
                           value={obs.port || WIZARD_DEFAULT_OBS_PORT}
                           onChange={(e) => onChange({ port: Number(e.target.value) })} />
            </WizardField>
            <WizardField label="Password" htmlFor="wzr-obs-pw"
                         hint="The one OBS generated above.">
              <WizardInput id="wzr-obs-pw" type="password"
                           value={obs.password || ""}
                           onChange={(e) => onChange({ password: e.target.value })} />
            </WizardField>
            <WizardButton kind="secondary" onClick={onTest}
                          disabled={!obs.port || busy}>
              {busy ? "Testing…" : "Test connection"}
            </WizardButton>
            <WizardTestStatus status={obs.status} />
          </WizardIntegrationCard>
        );
      }


  // Expose to global so inline-block JSX in index.html can render
  // these as bare identifiers.
  Object.assign(window, {
    WizardIntegrationCard,
    WizardTestStatus,
    WizardHowTo,
    WizardCopyBox,
    PULSE_LEAGUE_LABEL,
    WizardPulseMatchRow,
    WizardPulseSearchResults,
    WizardPulseCard,
    WizardTwitchCard,
    WizardObsCard
  });
})();
