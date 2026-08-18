"use client";

/**
 * Settings · Overlay · Multi-platform chat · Text-to-speech.
 *
 * Controlled TTS editor — part of the same draft/Save as the channel
 * config and appearance. The voice list comes from THIS browser's
 * speech engine, filtered to the voices that also exist inside the OBS
 * Browser Source: the "Google ..." and "... Online (Natural)" voices
 * are synthesised on the vendor's servers and CEF cannot load them, so
 * offering them only produced a silent swap to the engine default.
 * Anything that still has to be substituted keeps the language and the
 * gender of the original pick (lib/voiceCatalog). "Preview voice"
 * speaks a sample line right here so the streamer can audition
 * rate/volume/voice without touching OBS.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Bell, Play, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Toggle } from "@/components/ui/Toggle";
import {
  previewSound,
  type ChatSoundConfig,
  type CustomSound,
} from "@/lib/multichat/sound";
import {
  SOUND_CATEGORY_LABEL,
  SOUND_EFFECTS,
  type SoundEffectCategory,
} from "@/lib/multichat/soundEffects";
import {
  PACK_CATEGORIES,
  PACK_CATEGORY_LABEL,
  PACK_SOUNDS,
} from "@/lib/multichat/soundPack";
import { API_BASE } from "@/lib/clientApi";
import {
  SettingsMultiChatSounds,
  previewableSound,
} from "./SettingsMultiChatSounds";
import {
  CHAT_EVENT_KINDS,
  EVENT_KIND_LABEL,
  type ChatEventKind,
} from "@/lib/multichat/events";
import {
  TTS_MAX_CHARS_MAX,
  TTS_MAX_CHARS_MIN,
  TTS_RATE_MAX,
  TTS_RATE_MIN,
  createChatSpeaker,
  type ChatTtsConfig,
} from "@/lib/multichat/tts";
import { CHAT_PLATFORMS, type ChatPlatform } from "@/lib/multichat/types";
import {
  classifyAvailability,
  describeVoice,
  explainResolution,
  resolveVoice,
  usableVoices,
} from "@/lib/voiceCatalog";

const PLATFORM_LABEL: Record<ChatPlatform, string> = {
  twitch: "Twitch",
  kick: "Kick",
  youtube: "YouTube",
  tiktok: "TikTok",
};

const SOUND_CATEGORIES: readonly SoundEffectCategory[] = [
  "classic",
  "cool",
  "arcade",
  "funny",
];

/**
 * Grouped picker over the WHOLE sound namespace: the bundled
 * real-recording pack, the synthesized effects, and the streamer's
 * custom sounds ("Your sounds").
 */
function EffectSelect({
  value,
  onChange,
  allowNone,
  ariaLabel,
  customSounds,
}: {
  value: string;
  onChange: (next: string) => void;
  allowNone?: boolean;
  ariaLabel: string;
  customSounds: ReadonlyArray<CustomSound>;
}) {
  return (
    <select
      value={value}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
      className="w-full min-w-0 rounded-lg border border-border bg-bg-elevated px-2.5 py-1.5 text-body text-text focus:border-accent focus:outline-none"
    >
      {allowNone ? <option value="none">None (silent)</option> : null}
      {customSounds.length > 0 ? (
        <optgroup label="Your sounds">
          {customSounds.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </optgroup>
      ) : null}
      {PACK_CATEGORIES.map((cat) => (
        <optgroup key={cat} label={PACK_CATEGORY_LABEL[cat]}>
          {PACK_SOUNDS.filter((s) => s.category === cat).map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </optgroup>
      ))}
      {SOUND_CATEGORIES.map((cat) => (
        <optgroup key={cat} label={`Synth · ${SOUND_CATEGORY_LABEL[cat]}`}>
          {SOUND_EFFECTS.filter((e) => e.category === cat).map((e) => (
            <option key={e.id} value={e.id} title={e.description}>
              {e.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

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
  overlayToken = null,
}: {
  value: ChatTtsConfig;
  onChange: (next: ChatTtsConfig) => void;
  sound: ChatSoundConfig;
  onSoundChange: (next: ChatSoundConfig) => void;
  /** Overlay token — lets previews reach uploaded-sound bytes. */
  overlayToken?: string | null;
}) {
  const voices = useBrowserVoices();
  // Only the voices that survive the trip into OBS, unless the streamer
  // explicitly asks to see this browser's private ones.
  const [showBrowserOnly, setShowBrowserOnly] = useState(false);
  const portable = useMemo(() => usableVoices(voices), [voices]);
  const offeredVoices = showBrowserOnly ? voices : portable;
  const hiddenVoiceCount = voices.length - portable.length;
  const voiceWish = useMemo(
    () => ({ name: value.voiceName || undefined }),
    [value.voiceName],
  );
  const obsVoiceNote = explainResolution(
    resolveVoice(portable, voiceWish),
    voiceWish,
  );
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

  const setSound = (patch: Partial<ChatSoundConfig>) =>
    onSoundChange({ ...sound, ...patch });

  // Preview any id from the unified namespace — upload entries get a
  // token-route URL injected so their bytes are reachable from here.
  const auditionSound = (id: string, volume: number) =>
    previewSound(id, volume, previewableSound(sound, overlayToken), API_BASE);

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
          A short sound whenever new chat arrives (bursts collapse into
          one). Pick from real recordings (memes, crowd, cartoon),
          synthesized effects, or your own sounds below.
        </p>
        {sound.enabled ? (
          <div className="flex flex-wrap items-end gap-4">
            <label className="block w-56 min-w-0">
              <div className="mb-1 text-caption text-text-dim">Sound</div>
              <EffectSelect
                ariaLabel="Message sound effect"
                value={sound.messageSound}
                customSounds={sound.customSounds}
                onChange={(messageSound) => setSound({ messageSound })}
              />
            </label>
            <label className="block w-56 min-w-0">
              <div className="mb-1 text-caption text-text-dim">
                Volume{" "}
                <span className="tabular-nums text-text">{sound.volume}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={sound.volume}
                onChange={(e) => setSound({ volume: Number(e.target.value) })}
                className="w-full accent-[var(--accent,#3ec0c7)]"
              />
            </label>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => auditionSound(sound.messageSound, sound.volume)}
            >
              <Bell className="mr-1 h-3.5 w-3.5" aria-hidden />
              Preview
            </Button>
          </div>
        ) : null}
      </div>

      <div className="space-y-2 border-t border-border pt-3">
        <div className="flex flex-wrap items-center gap-3">
          <Toggle
            checked={sound.eventSoundsEnabled}
            onChange={(on) => setSound({ eventSoundsEnabled: on })}
            label="Enable alert sounds"
          />
          <span className="text-body font-medium text-text">Alert sounds</span>
        </div>
        <p className="text-caption text-text-dim">
          Plays on the <b>Chat event alerts</b> widget when a sub, raid,
          gift, or other platform event lands — pick a vibe per event, from
          classy chimes to the airhorn. The widget&apos;s Test button
          auditions them on stream.
        </p>
        {sound.eventSoundsEnabled ? (
          <div className="space-y-3">
            <label className="block w-56 min-w-0">
              <div className="mb-1 text-caption text-text-dim">
                Alert volume{" "}
                <span className="tabular-nums text-text">
                  {sound.eventVolume}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={sound.eventVolume}
                onChange={(e) =>
                  setSound({ eventVolume: Number(e.target.value) })
                }
                className="w-full accent-[var(--accent,#3ec0c7)]"
              />
            </label>
            <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
              {CHAT_EVENT_KINDS.map((kind: ChatEventKind) => (
                <div key={kind} className="flex min-w-0 items-end gap-1.5">
                  <label className="block min-w-0 flex-1">
                    <div className="mb-1 text-caption text-text-dim">
                      {EVENT_KIND_LABEL[kind]}
                    </div>
                    <EffectSelect
                      ariaLabel={`${EVENT_KIND_LABEL[kind]} sound effect`}
                      allowNone
                      customSounds={sound.customSounds}
                      value={sound.eventSounds[kind]}
                      onChange={(next) =>
                        setSound({
                          eventSounds: { ...sound.eventSounds, [kind]: next },
                        })
                      }
                    />
                  </label>
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={`Preview ${EVENT_KIND_LABEL[kind]} sound`}
                    disabled={sound.eventSounds[kind] === "none"}
                    onClick={() =>
                      auditionSound(sound.eventSounds[kind], sound.eventVolume)
                    }
                  >
                    <Play className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div className="space-y-2 border-t border-border pt-3">
        <span className="text-body font-medium text-text">
          Your sounds &amp; voice lines
        </span>
        <SettingsMultiChatSounds
          sound={sound}
          onSoundChange={onSoundChange}
          overlayToken={overlayToken}
        />
        <p className="text-micro text-text-dim">
          Bundled sounds: Mixkit (Mixkit Sound Effects Free License) and
          SoundBible — Airhorn &amp; Metal pipe by Mike Koenig, Cha-ching
          by Muska666 (CC BY 3.0). Full list in the app repo under
          public/sounds/multichat/CREDITS.md.
        </p>
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
                {offeredVoices.map((v) => (
                  <option key={`${v.name}|${v.lang}`} value={v.name}>
                    {describeVoice(v)} ({v.lang})
                    {classifyAvailability(v) === "chromeOnly"
                      ? " - this browser only"
                      : ""}
                  </option>
                ))}
              </select>
              {obsVoiceNote ? (
                <div className="mt-1 text-caption text-text-dim">
                  {obsVoiceNote}
                </div>
              ) : null}
              {hiddenVoiceCount > 0 ? (
                <label className="mt-1 flex items-start gap-1.5 text-caption text-text-dim">
                  <input
                    type="checkbox"
                    checked={showBrowserOnly}
                    onChange={(e) => setShowBrowserOnly(e.target.checked)}
                    className="mt-0.5 h-3.5 w-3.5 accent-[var(--accent,#3ec0c7)]"
                  />
                  <span>
                    Show {hiddenVoiceCount} browser-only voice
                    {hiddenVoiceCount === 1 ? "" : "s"} (OBS can&apos;t load
                    these)
                  </span>
                </label>
              ) : null}
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
