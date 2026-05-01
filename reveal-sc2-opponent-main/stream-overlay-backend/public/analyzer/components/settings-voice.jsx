/**
 * Settings voice — Web Speech API readout panel.
 *
 * Loaded from index.html via:
 *   <script type="text/babel" data-presets="react" src="..."></script>
 *
 * Mirrors the legacy public/voice-settings.html standalone page, but
 * lives inside the analyzer Settings tab. Persists to config.voice via
 * the standard onPatch(["voice", <field>], value) protocol used by the
 * other panels. The Test button speaks a generic line through the
 * browser's Web Speech API; no data is fabricated about opponents.
 *
 * DO NOT DUPLICATE THIS BODY INSIDE index.html.
 */
(function () {
  "use strict";
  const React = window.React;
  const { useEffect, useMemo, useState } = React;

      // Defaults mirror data/config.schema.json + voice-settings.html.
      const VOICE_DEFAULTS = Object.freeze({
        enabled: true,
        volume: 1.0,
        rate: 0.95,
        pitch: 1.0,
        delay_ms: 600,
        preferred_voice: ""
      });

      // Sample line for the Test button. Deliberately generic — not
      // styled as a real scouting report (Stage 0 hard rule: no
      // synthetic stats anywhere in shipping code paths).
      const VOICE_TEST_LINE =
        "Voice test. This is how scouting reports will sound "
        + "when an opponent is detected.";

      function voiceFieldValue(voice, key) {
        if (voice && voice[key] != null) return voice[key];
        return VOICE_DEFAULTS[key];
      }

      function voiceClampNumber(raw, lo, hi, fallback) {
        const n = parseFloat(raw);
        if (!Number.isFinite(n)) return fallback;
        if (n < lo) return lo;
        if (n > hi) return hi;
        return n;
      }

      function voiceClampInt(raw, lo, hi, fallback) {
        const n = parseInt(raw, 10);
        if (!Number.isFinite(n)) return fallback;
        if (n < lo) return lo;
        if (n > hi) return hi;
        return n;
      }

      function useBrowserVoices() {
        const [voices, setVoices] = useState(() => {
          if (typeof window === "undefined") return [];
          if (!window.speechSynthesis) return [];
          return window.speechSynthesis.getVoices() || [];
        });
        useEffect(() => {
          if (typeof window === "undefined") return undefined;
          const synth = window.speechSynthesis;
          if (!synth) return undefined;
          const refresh = () => setVoices(synth.getVoices() || []);
          refresh();
          if (synth.onvoiceschanged !== undefined) {
            synth.addEventListener("voiceschanged", refresh);
            return () => synth.removeEventListener("voiceschanged", refresh);
          }
          return undefined;
        }, []);
        return voices;
      }

      function SettingsVoiceSlider({ id, label, suffix, min, max, step,
                                     value, onChange, hint, error }) {
        return (
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <SettingsLabel htmlFor={id}>{label}</SettingsLabel>
              <span className="text-xs font-mono text-accent-300
                               bg-base-900 px-2 py-0.5 rounded">
                {suffix}
              </span>
            </div>
            <input id={id} type="range"
                   min={min} max={max} step={step} value={value}
                   onChange={(e) => onChange(parseFloat(e.target.value))}
                   className="w-full accent-accent-500" />
            {hint ? (
              <div className="text-[11px] text-neutral-500">{hint}</div>
            ) : null}
            <SettingsErrorList errors={error} />
          </div>
        );
      }

      function SettingsVoiceTestStatus({ status }) {
        if (!status) return null;
        const tone = status.kind === "error"
          ? "text-loss-500"
          : status.kind === "ok"
            ? "text-win-500"
            : "text-accent-300";
        return (
          <span className={"text-xs " + tone} aria-live="polite">
            {status.message}
          </span>
        );
      }

      function settingsVoiceBuildUtterance(voice) {
        const utter = new window.SpeechSynthesisUtterance(VOICE_TEST_LINE);
        utter.volume = voiceFieldValue(voice, "volume");
        utter.rate = voiceFieldValue(voice, "rate");
        utter.pitch = voiceFieldValue(voice, "pitch");
        const want = voiceFieldValue(voice, "preferred_voice");
        if (want && window.speechSynthesis) {
          const list = window.speechSynthesis.getVoices() || [];
          const match = list.find((v) => v.name === want);
          if (match) utter.voice = match;
        }
        return utter;
      }

      function SettingsVoicePanel({ voice, errors, onPatch }) {
        const v = voice || {};
        const browserVoices = useBrowserVoices();
        const [testStatus, setTestStatus] = useState(null);
        const errKey = (k) => errors && errors["voice." + k];
        const set = (key, value) => onPatch(["voice", key], value);

        const enabled = voiceFieldValue(v, "enabled");
        const volume = voiceFieldValue(v, "volume");
        const rate = voiceFieldValue(v, "rate");
        const pitch = voiceFieldValue(v, "pitch");
        const delayMs = voiceFieldValue(v, "delay_ms");
        const preferred = voiceFieldValue(v, "preferred_voice");

        const voiceOptions = useMemo(() => {
          const opts = [{ id: "", label: "Auto (best available English voice)" }];
          browserVoices.forEach((vc) => {
            opts.push({ id: vc.name, label: vc.name + " (" + vc.lang + ")" });
          });
          return opts;
        }, [browserVoices]);

        const supportsSpeech =
          typeof window !== "undefined" && !!window.speechSynthesis;

        const onTest = () => {
          if (!supportsSpeech) {
            setTestStatus({ kind: "error",
              message: "Web Speech API is not available in this browser." });
            return;
          }
          try {
            window.speechSynthesis.cancel();
            const utter = settingsVoiceBuildUtterance(v);
            utter.onend = () => setTestStatus(null);
            utter.onerror = (ev) => setTestStatus({ kind: "error",
              message: "Speech error: " + (ev && ev.error ? ev.error : "unknown") });
            setTestStatus({ kind: "info", message: "Playing test…" });
            window.setTimeout(() => window.speechSynthesis.speak(utter), 50);
          } catch (e) {
            setTestStatus({ kind: "error", message: "Speech error: " + e.message });
          }
        };

        return (
          <div className="space-y-4 max-w-2xl">
            <div className="px-4 py-3 bg-base-900 border border-base-700 rounded">
              <h3 className="text-sm font-semibold text-neutral-100 mb-1">
                Scouting voice readout
              </h3>
              <p className="text-xs text-neutral-400 leading-relaxed">
                Uses the browser's built-in Web Speech API (no API key
                required). Reads opponent info aloud when a new game
                loads. Settings save into <code>config.voice</code> and
                take effect on the next game.
              </p>
            </div>

            <div className="px-4 py-3 bg-base-900 border border-base-700
                            rounded space-y-4">
              <SettingsCheckbox id="settings-voice-enabled"
                checked={enabled}
                onChange={(checked) => set("enabled", checked)}
                label="Enable voice readout"
                hint="Master switch. When off, the overlay stays silent." />
              <SettingsErrorList errors={errKey("enabled")} />
            </div>

            <div className="px-4 py-3 bg-base-900 border border-base-700
                            rounded space-y-4">
              <SettingsVoiceSlider id="settings-voice-volume"
                label="Volume"
                suffix={Math.round(volume * 100) + "%"}
                min="0" max="1" step="0.05" value={volume}
                onChange={(n) => set("volume",
                  voiceClampNumber(n, 0, 1, VOICE_DEFAULTS.volume))}
                error={errKey("volume")} />
              <SettingsVoiceSlider id="settings-voice-rate"
                label="Speed"
                suffix={rate.toFixed(2) + "×"}
                min="0.5" max="2" step="0.05" value={rate}
                onChange={(n) => set("rate",
                  voiceClampNumber(n, 0.5, 2, VOICE_DEFAULTS.rate))}
                hint="0.85 = deliberate · 1.0 = normal · 1.2 = fast"
                error={errKey("rate")} />
              <SettingsVoiceSlider id="settings-voice-pitch"
                label="Pitch"
                suffix={pitch.toFixed(1)}
                min="0" max="2" step="0.1" value={pitch}
                onChange={(n) => set("pitch",
                  voiceClampNumber(n, 0, 2, VOICE_DEFAULTS.pitch))}
                hint="Lower = deeper · 1.0 = neutral · Higher = brighter"
                error={errKey("pitch")} />
              <SettingsVoiceSlider id="settings-voice-delay"
                label="Delay after game start"
                suffix={(delayMs / 1000).toFixed(1) + "s"}
                min="0" max="5000" step="100" value={delayMs}
                onChange={(n) => set("delay_ms",
                  voiceClampInt(n, 0, 5000, VOICE_DEFAULTS.delay_ms))}
                hint="Waits this long after the scouting card appears
                      before speaking."
                error={errKey("delay_ms")} />
            </div>

            <div className="px-4 py-3 bg-base-900 border border-base-700
                            rounded space-y-2">
              <SettingsLabel htmlFor="settings-voice-preferred">
                Voice
              </SettingsLabel>
              <SettingsSelect id="settings-voice-preferred"
                value={preferred}
                onChange={(e) => set("preferred_voice",
                  e.target.value || "")}
                options={voiceOptions}
                invalid={!!errKey("preferred_voice")} />
              <div className="text-[11px] text-neutral-500">
                List shows voices installed on this machine. "Auto"
                lets the overlay pick the best available English voice.
              </div>
              <SettingsErrorList errors={errKey("preferred_voice")} />
            </div>

            <div className="flex items-center gap-3">
              <SettingsButton kind="secondary" onClick={onTest}
                              disabled={!supportsSpeech}
                              ariaLabel="Play a sample of the voice">
                ▶ Test voice
              </SettingsButton>
              <SettingsVoiceTestStatus status={testStatus} />
              {!supportsSpeech ? (
                <span className="text-xs text-loss-500">
                  This browser does not support the Web Speech API.
                </span>
              ) : null}
            </div>
          </div>
        );
      }

  // Expose to global so inline-block JSX in index.html can render
  // these as bare identifiers.
  Object.assign(window, {
    VOICE_DEFAULTS,
    VOICE_TEST_LINE,
    voiceFieldValue,
    voiceClampNumber,
    voiceClampInt,
    useBrowserVoices,
    SettingsVoiceSlider,
    SettingsVoiceTestStatus,
    settingsVoiceBuildUtterance,
    SettingsVoicePanel
  });
})();
