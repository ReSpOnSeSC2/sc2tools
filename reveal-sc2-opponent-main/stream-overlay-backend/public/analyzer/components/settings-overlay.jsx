/**
 * Settings overlay — extracted from index.html for size-rule compliance.
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

      function SettingsOverlayTwitchCard({ overlay, errors, onPatch }) {
        const [status, setStatus] = useState(null);
        const onTest = async () => {
          setStatus({ ok: null, message: "Testing…" });
          setStatus(await settingsRunOverlayTest(
            "/api/onboarding/test/twitch",
            { channel: overlay.twitch_channel || "" }));
        };
        return (
          <div className="px-4 py-3 bg-base-900 border border-base-700
                          rounded space-y-3">
            <div className="text-sm font-semibold text-neutral-200">Twitch</div>
            <div>
              <SettingsLabel htmlFor="settings-twitch-channel">
                Channel handle
              </SettingsLabel>
              <SettingsInput id="settings-twitch-channel"
                value={overlay.twitch_channel || ""}
                onChange={(e) => onPatch(
                  ["stream_overlay", "twitch_channel"],
                  e.target.value || null)}
                placeholder="your_twitch_handle"
                invalid={!!errors["stream_overlay.twitch_channel"]} />
              <SettingsErrorList
                errors={errors["stream_overlay.twitch_channel"]} />
            </div>
            <div className="flex items-center gap-2">
              <SettingsButton kind="secondary" onClick={onTest}>
                Test
              </SettingsButton>
              {status ? (
                <span className={settingsOverlayStatusClass(status)}>
                  {status.message}
                </span>
              ) : null}
            </div>
          </div>
        );
      }

      function SettingsObsHostPort({ obs, errors, onPatch }) {
        return (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <SettingsLabel htmlFor="settings-obs-host">Host</SettingsLabel>
              <SettingsInput id="settings-obs-host"
                value={obs.host || ""}
                onChange={(e) => onPatch(
                  ["stream_overlay", "obs_websocket", "host"], e.target.value)}
                placeholder="127.0.0.1"
                invalid={!!errors["stream_overlay.obs_websocket.host"]} />
              <SettingsErrorList
                errors={errors["stream_overlay.obs_websocket.host"]} />
            </div>
            <div>
              <SettingsLabel htmlFor="settings-obs-port">Port</SettingsLabel>
              <SettingsInput id="settings-obs-port" type="number"
                min="1" max="65535"
                value={obs.port == null ? "" : String(obs.port)}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  onPatch(["stream_overlay", "obs_websocket", "port"],
                    Number.isFinite(v) ? v : 4455);
                }}
                placeholder="4455"
                invalid={!!errors["stream_overlay.obs_websocket.port"]} />
              <SettingsErrorList
                errors={errors["stream_overlay.obs_websocket.port"]} />
            </div>
          </div>
        );
      }

      function SettingsOverlayObsCard({ overlay, errors, onPatch }) {
        const obs = overlay.obs_websocket || {};
        const [status, setStatus] = useState(null);
        const onTest = async () => {
          setStatus({ ok: null, message: "Testing…" });
          setStatus(await settingsRunOverlayTest("/api/onboarding/test/obs", {
            host: obs.host || "127.0.0.1",
            port: obs.port || 4455,
            password: obs.password || "",
          }));
        };
        return (
          <div className="px-4 py-3 bg-base-900 border border-base-700
                          rounded space-y-3">
            <div className="text-sm font-semibold text-neutral-200">
              OBS WebSocket
            </div>
            <SettingsObsHostPort obs={obs} errors={errors} onPatch={onPatch} />
            <div>
              <SettingsLabel htmlFor="settings-obs-pass"
                hint="leave empty if auth disabled">Password</SettingsLabel>
              <SettingsInput id="settings-obs-pass" type="password"
                value={obs.password || ""}
                onChange={(e) => onPatch(
                  ["stream_overlay", "obs_websocket", "password"],
                  e.target.value || null)}
                invalid={!!errors["stream_overlay.obs_websocket.password"]} />
            </div>
            <div className="flex items-center gap-2">
              <SettingsButton kind="secondary" onClick={onTest}>
                Test
              </SettingsButton>
              {status ? (
                <span className={settingsOverlayStatusClass(status)}>
                  {status.message}
                </span>
              ) : null}
            </div>
          </div>
        );
      }

      // settings-pr1k: Twitch card removed (only the owner uses it via
      // .env-loaded creds; nothing for other users to configure). The
      // dead master toggle ('Enable stream overlay event bus') is gone
      // too -- the event bus runs unconditionally as part of Socket.io.
      // OBS card retained because some users actually use scene control.
      // settings-pr1l: top-level Widgets tab folded in here as the
      // canonical place to set up streaming. Three layers:
      //   1. Plain-English "what this is" header.
      //   2. Widget catalog -- grab Browser Source URLs for each.
      //   3. <details> Advanced -- OBS WebSocket for the small power-
      //      user audience that wants the analyzer to drive scenes.
      function SettingsOverlayPanel({ overlay, errors, onPatch }) {
        const o = overlay || {};
        const w = useWizardStreamlabsState();
        return (
          <div className="space-y-4 max-w-3xl">
            <div className="px-4 py-3 bg-base-900 border border-base-700 rounded">
              <h3 className="text-sm font-semibold text-neutral-100 mb-1">
                Stream overlay
              </h3>
              <p className="text-xs text-neutral-400 leading-relaxed">
                The widget event bus runs automatically as part of the
                backend &mdash; no setup needed. Pick a widget below,
                copy its URL, and add it as a Browser Source in your
                streaming app. Same URL works in both Streamlabs
                Desktop and OBS Studio.
              </p>
            </div>

            <div className="px-4 py-3 bg-base-900 border border-base-700
                            rounded space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-neutral-100">
                  Widgets
                </h3>
                <span className="text-xs text-neutral-500">
                  {w.visible.length} of {WIZARD_OVERLAY_WIDGETS.length}
                  {" "}shown
                </span>
              </div>
              <p className="text-xs text-neutral-400">
                The four <span className="text-win-500 font-semibold">
                RECOMMENDED</span> widgets cover the highest-impact
                moments: live session, pre-game scouting, post-game
                reveal, and streak splashes.
              </p>
              <WizardStreamlabsToolbar
                showAll={w.showAll}
                onToggleShowAll={() => w.setShowAll(!w.showAll)}
                visibleCount={w.visible.length}
                totalCount={WIZARD_OVERLAY_WIDGETS.length}
                onCopyAll={w.copyAllUrls}
                allCopied={w.allCopied} />
              <div className="space-y-2">
                {w.visible.map((widget) => (
                  <WizardWidgetRow key={widget.file} widget={widget}
                                   baseUrl={WIZARD_OVERLAY_URL} />
                ))}
              </div>
              <WizardStreamlabsAllInOne />
            </div>

            <details className="group">
              <summary className="cursor-pointer text-sm text-neutral-300
                                  hover:text-neutral-100 select-none px-1">
                How do I add a widget? (Streamlabs / OBS step-by-step)
              </summary>
              <div className="mt-2 space-y-3">
                <WizardHowTo
                  title="How do I add a widget in Streamlabs Desktop?"
                  steps={WIZARD_STREAMLABS_HOWTO_STREAMLABS} />
                <WizardHowTo
                  title="How do I add a widget in OBS Studio?"
                  steps={WIZARD_STREAMLABS_HOWTO_OBS} />
              </div>
            </details>

            <details className="group">
              <summary className="cursor-pointer text-sm text-neutral-300
                                  hover:text-neutral-100 select-none px-1">
                Advanced &mdash; OBS Studio scene control (most users skip this)
              </summary>
              <div className="mt-2 space-y-2">
                <p className="text-xs text-neutral-500 px-1 leading-relaxed">
                  Optional. Only needed if you want the analyzer to
                  drive OBS Studio (auto-switch scenes on game events,
                  start/stop recording, etc.). Browser Source widgets
                  above do <em>not</em> need this. Streamlabs Desktop
                  doesn't expose the same WebSocket protocol, so this
                  applies to OBS Studio (28+) only.
                </p>
                <SettingsOverlayObsCard overlay={o} errors={errors}
                  onPatch={onPatch} />
              </div>
            </details>
          </div>
        );
      }

  // Expose to global so inline-block JSX in index.html can render
  // these as bare identifiers.
  Object.assign(window, {
    SettingsOverlayTwitchCard,
    SettingsObsHostPort,
    SettingsOverlayObsCard,
    SettingsOverlayPanel
  });
})();
