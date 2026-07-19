"use client";

/**
 * Settings · Overlay · Multi-platform chat · Text-to-speech.
 *
 * Controlled TTS editor — part of the same draft/Save as the channel
 * config and appearance. The voice list comes from THIS browser's
 * speech engine; the OBS machine may have a different inventory, so
 * the stored value is a voice NAME and the widget falls back to the
 * OBS machine's default when that name isn't installed there (the
 * caveat is surfaced inline). "Preview voice" speaks a sample line
 * right here so the streamer can audition rate/volume/voice without
 * touching OBS.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Bell, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Toggle } from "@/components/ui/Toggle";
import { createDinger, type ChatSoundConfig } from "@/lib/multichat/sound";
import {
  TTS_MAX_CHARS_MAX,
  TTS_MAX_CHARS_MIN,
  TTS_RATE_MAX,
  TTS_RATE_MIN,
  createChatSpeaker,
  type ChatTtsConfig,
} from "@/lib/multichat/tts";
import { CHAT_PLATFORMS, type ChatPlatform } from "@/lib/multichat/types";

const PLATFORM_LABEL: Record<ChatPlatform, string> = {
  twitch: "Twitch",
  kick: "Kick",
  youtube: "YouTube",
  tiktok: "TikTok",
};

/** Empty platforms array means "all" — the UI shows all four checked. */
function platformChecked(config: ChatTtsConfig, p: ChatPlatform): boolean {
  return config.platforms.length === 0 || config.platforms.includes(p);
}

function togglePlatform(
  config: ChatTtsConfig,
  p: ChatPlatform,
  on: boolean,
): ChatPlatform[] {
  const current = new Set(
    config.platforms.length === 0 ? CHAT_PLATFORMS : config.platforms,
  );
  if (on) current.add(p);
  else current.delete(p);
  // All four selected collapses back to the "all" sentinel.
  return current.size === CHAT_PLATFORMS.length
    ? []
    : CHAT_PLATFORMS.filter((x) => current.has(x));
}

function useBrowserVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () =>
      window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);
  return voices;
}

export function SettingsMultiChatTts({
  value,
  onChange,
  sound,
  onSoundChange,
}: {
  value: ChatTtsConfig;
  onChange: (next: ChatTtsConfig) => void;
  sound: ChatSoundConfig;
  onSoundChange: (next: ChatSoundConfig) => void;
}) {
  const voices = useBrowserVoices();
  const previewRef = useRef<ReturnType<typeof createChatSpeaker> | null>(null);
  const set = (patch: Partial<ChatTtsConfig>) =>
    onChange({ ...value, ...patch });

  // One preview speaker per current settings; recreated lazily on click
  // so sliders don't spawn speakers mid-drag.
  const preview = () => {
    previewRef.current?.close();
    const speaker = createChatSpeaker(value);
    previewRef.current = speaker;
    speaker.unlock(); // settings click IS the gesture
    speaker.speak({
      platform: "twitch",
      id: `preview-${Date.now()}`,
      user: "PreviewViewer",
      text: "This is how chat sounds with these settings.",
      badges: [],
      atMs: Date.now(),
    });
  };
  useEffect(() => () => previewRef.current?.close(), []);

  const supported = useMemo(
    () => typeof window === "undefined" || "speechSynthesis" in window,
    [],
  );

  const previewDing = () => {
    const dinger = createDinger({ ...sound, enabled: true });
    dinger.ping();
    // Give the blip time to play before releasing the context.
    setTimeout(() => dinger.close(), 600);
  };

  return (
    <div className="min-w-0 space-y-3">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <Toggle
            checked={sound.enabled}
            onChange={(on) => onSoundChange({ ...sound, enabled: on })}
            label="Enable message sound"
          />
          <span className="text-body font-medium text-text">
            Message sound
          </span>
        </div>
        <p className="text-caption text-text-dim">
          A short ding whenever new chat arrives (bursts collapse into one
          ding). Synthesized in the Browser Source — no audio files.
        </p>
        {sound.enabled ? (
          <div className="flex flex-wrap items-end gap-4">
            <label className="block w-56 min-w-0">
              <div className="mb-1 text-caption text-text-dim">
                Ding volume{" "}
                <span className="tabular-nums text-text">{sound.volume}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={sound.volume}
                onChange={(e) =>
                  onSoundChange({ ...sound, volume: Number(e.target.value) })
                }
                className="w-full accent-[var(--accent,#3ec0c7)]"
              />
            </label>
            <Button size="sm" variant="secondary" onClick={previewDing}>
              <Bell className="mr-1 h-3.5 w-3.5" aria-hidden />
              Preview ding
            </Button>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
        <Toggle
          checked={value.enabled}
          onChange={(on) => set({ enabled: on })}
          label="Enable text-to-speech"
        />
        <span className="text-body font-medium text-text">
          Read chat aloud (TTS)
        </span>
      </div>
      <p className="text-caption text-text-dim">
        Speaks incoming messages through the Browser Source, so you hear
        chat without watching it. Voices are per-machine — if the voice
        picked here isn't installed on your OBS PC, it falls back to that
        machine's default. Filters above (hidden commands, blocked users)
        apply to the voice too.
      </p>
      {!supported ? (
        <p className="text-caption text-warning">
          This browser doesn't expose speech synthesis — the preview is
          unavailable here, but the OBS Browser Source can still speak.
        </p>
      ) : null}

      {value.enabled ? (
        <div className="space-y-4">
          <div>
            <div className="mb-1 text-caption text-text-dim">
              Read messages from{" "}
              <span className="text-text-muted">(at least one platform)</span>
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {CHAT_PLATFORMS.map((p) => {
                const checked = platformChecked(value, p);
                const checkedCount = CHAT_PLATFORMS.filter((x) =>
                  platformChecked(value, x),
                ).length;
                // The wire sentinel is "empty = all platforms", so an
                // empty selection can't exist — unchecking the last box
                // would silently flip everything back ON. Lock it
                // instead; "no platforms" is the Enable toggle's job.
                const lastOne = checked && checkedCount === 1;
                return (
                  <label
                    key={p}
                    className={`flex items-center gap-1.5 text-caption text-text ${lastOne ? "opacity-60" : ""}`}
                    title={lastOne ? "At least one platform must stay selected — use the Enable toggle to turn TTS off" : undefined}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={lastOne}
                      onChange={(e) =>
                        set({ platforms: togglePlatform(value, p, e.target.checked) })
                      }
                      className="h-3.5 w-3.5 accent-[var(--accent,#3ec0c7)]"
                    />
                    {PLATFORM_LABEL[p]}
                  </label>
                );
              })}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block min-w-0">
              <div className="mb-1 text-caption text-text-dim">Voice</div>
              <select
                value={value.voiceName}
                onChange={(e) => set({ voiceName: e.target.value })}
                className="w-full min-w-0 rounded-lg border border-border bg-bg-elevated px-2.5 py-1.5 text-body text-text focus:border-accent focus:outline-none"
              >
                <option value="">Machine default</option>
                {voices.map((v) => (
                  <option key={`${v.name}|${v.lang}`} value={v.name}>
                    {v.name} ({v.lang})
                  </option>
                ))}
              </select>
            </label>
            <label className="block min-w-0">
              <div className="mb-1 text-caption text-text-dim">
                Speed{" "}
                <span className="tabular-nums text-text">{value.rate.toFixed(2)}×</span>
              </div>
              <input
                type="range"
                min={TTS_RATE_MIN}
                max={TTS_RATE_MAX}
                step={0.05}
                value={value.rate}
                onChange={(e) => set({ rate: Number(e.target.value) })}
                className="w-full accent-[var(--accent,#3ec0c7)]"
              />
            </label>
            <label className="block min-w-0">
              <div className="mb-1 text-caption text-text-dim">
                Volume{" "}
                <span className="tabular-nums text-text">{value.volume}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={value.volume}
                onChange={(e) => set({ volume: Number(e.target.value) })}
                className="w-full accent-[var(--accent,#3ec0c7)]"
              />
            </label>
            <label className="block min-w-0">
              <div className="mb-1 text-caption text-text-dim">
                Max spoken length{" "}
                <span className="tabular-nums text-text">
                  {value.maxChars} chars
                </span>
              </div>
              <input
                type="range"
                min={TTS_MAX_CHARS_MIN}
                max={TTS_MAX_CHARS_MAX}
                step={10}
                value={value.maxChars}
                onChange={(e) => set({ maxChars: Number(e.target.value) })}
                className="w-full accent-[var(--accent,#3ec0c7)]"
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <label className="flex items-center gap-2 text-caption text-text">
              <Toggle
                checked={value.readNames}
                onChange={(on) => set({ readNames: on })}
                label="Read usernames"
              />
              Read usernames
            </label>
            <label className="flex items-center gap-2 text-caption text-text">
              <Toggle
                checked={value.skipCommands}
                onChange={(on) => set({ skipCommands: on })}
                label="Skip !commands"
              />
              Skip !commands
            </label>
            <Button
              size="sm"
              variant="secondary"
              disabled={!supported}
              onClick={preview}
            >
              <Volume2 className="mr-1 h-3.5 w-3.5" aria-hidden />
              Preview voice
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
