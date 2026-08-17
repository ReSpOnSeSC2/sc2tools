// Multichat sounds — a short effect per incoming chat line, plus
// per-event-kind alert sounds for the ChatAlertsWidget. Three sound
// families share one id namespace (ids unique across all three,
// pinned by tests):
//
//   - synthesized effects (soundEffects.ts) — WebAudio, zero assets
//   - the bundled real-recording pack (soundPack.ts) — 35 curated
//     clips under /sounds/multichat/, free-license sources only
//   - the streamer's CUSTOM sounds (this module's CustomSound):
//       url    — a direct MP3/OGG link they pasted (e.g. MyInstants)
//       upload — a file they uploaded, stored by the API and served
//                on the token route /v1/multichat/:token/sound/:id
//       tts    — a typed phrase spoken by the browser's speech engine
//
// The sanitizer mirrors the API's (services/multichatAppearance —
// sanitizeChatSound) exactly.

import {
  EFFECT_MAX_DURATION_MS,
  isSoundEffectId,
  playEffect,
  type SoundEffectId,
} from "./soundEffects";
import { isPackSoundId, packSoundUrl } from "./soundPack";
import { CHAT_EVENT_KINDS, type ChatEventKind } from "./events";

export const CUSTOM_SOUNDS_MAX = 12;
export const CUSTOM_LABEL_MAX = 40;
export const CUSTOM_URL_MAX = 400;
export const CUSTOM_TTS_TEXT_MAX = 200;
/** Custom ids are namespaced ``c-…`` so they can never collide with a
 * synth or pack id. */
export const CUSTOM_ID_RE = /^c-[a-z0-9-]{1,24}$/;

export interface CustomSound {
  id: string;
  label: string;
  kind: "url" | "upload" | "tts";
  /** kind url: https link. kind upload: token-route path injected by
   * the API config route (settings sees ``uploadId`` instead). */
  url?: string;
  /** kind upload, prefs-side: the stored file's id. */
  uploadId?: string;
  /** kind tts. */
  text?: string;
  voiceName?: string;
  rate?: number;
}

export interface ChatSoundConfig {
  enabled: boolean;
  /** 0–100. Message-ding volume. */
  volume: number;
  /** Sound id (synth | pack | custom) played per incoming chat line. */
  messageSound: string;
  /** Alert sounds for the event toaster (subs, raids, gifts…). */
  eventSoundsEnabled: boolean;
  /** 0–100. Alert-sound volume, independent of the chat ding. */
  eventVolume: number;
  /** Per-event-kind sound id; "none" silences that kind. */
  eventSounds: Record<ChatEventKind, string>;
  /** The streamer's own sounds — selectable anywhere an id is. */
  customSounds: CustomSound[];
}

/**
 * Default per-kind mapping — hype events get hype sounds. Every kind
 * is always present in a sanitized config (stable JSON identity for
 * the widget's config-section diffing).
 */
export const DEFAULT_EVENT_SOUNDS: Record<ChatEventKind, string> = {
  sub: "victory",
  resub: "victory",
  giftsub: "airhorn",
  raid: "airhorn",
  member: "sparkle",
  superchat: "coin",
  gift: "coin",
  follow: "pop",
  cheer: "coin",
  share: "pop",
  reward: "sparkle",
};

export const DEFAULT_SOUND: ChatSoundConfig = {
  enabled: false,
  volume: 60,
  messageSound: "ding",
  eventSoundsEnabled: false,
  eventVolume: 70,
  eventSounds: { ...DEFAULT_EVENT_SOUNDS },
  customSounds: [],
};

/** Minimum gap between dings — chat bursts collapse into one. */
export const SOUND_MIN_GAP_MS = 1500;

/** Minimum gap between alert sounds — a gift train isn't a siren. */
export const EVENT_SOUND_MIN_GAP_MS = 1200;

function clampVolume(raw: unknown, fallback: number): number {
  const v = Number(raw);
  return Number.isFinite(v)
    ? Math.min(100, Math.max(0, Math.round(v)))
    : fallback;
}

function sanitizeCustomSounds(raw: unknown): CustomSound[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomSound[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= CUSTOM_SOUNDS_MAX) break;
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const id = typeof c.id === "string" ? c.id : "";
    const label =
      typeof c.label === "string" ? c.label.trim().slice(0, CUSTOM_LABEL_MAX) : "";
    if (!CUSTOM_ID_RE.test(id) || !label || seen.has(id)) continue;
    if (c.kind === "url") {
      const url = typeof c.url === "string" ? c.url.trim() : "";
      if (!/^https:\/\//.test(url) || url.length > CUSTOM_URL_MAX) continue;
      out.push({ id, label, kind: "url", url });
    } else if (c.kind === "upload") {
      // Prefs-side entries carry uploadId; the token config route
      // rewrites them to a served ``url`` under /v1/multichat/.
      const uploadId = typeof c.uploadId === "string" ? c.uploadId.trim() : "";
      const url = typeof c.url === "string" ? c.url.trim() : "";
      const okUpload = /^[a-f0-9-]{8,40}$/.test(uploadId);
      const okUrl = url.startsWith("/v1/multichat/") && url.length <= CUSTOM_URL_MAX;
      if (!okUpload && !okUrl) continue;
      out.push({
        id,
        label,
        kind: "upload",
        ...(okUpload ? { uploadId } : {}),
        ...(okUrl ? { url } : {}),
      });
    } else if (c.kind === "tts") {
      const text =
        typeof c.text === "string"
          ? c.text.trim().slice(0, CUSTOM_TTS_TEXT_MAX)
          : "";
      if (!text) continue;
      const rate = Number(c.rate);
      out.push({
        id,
        label,
        kind: "tts",
        text,
        voiceName:
          typeof c.voiceName === "string" ? c.voiceName.slice(0, 120) : "",
        rate: Number.isFinite(rate) ? Math.min(2, Math.max(0.5, rate)) : 1,
      });
    } else {
      continue;
    }
    seen.add(id);
  }
  return out;
}

/** True when ``id`` names a playable sound in this config. */
export function isKnownSoundId(id: unknown, customs: CustomSound[]): boolean {
  return (
    isSoundEffectId(id) ||
    isPackSoundId(id) ||
    (typeof id === "string" && customs.some((c) => c.id === id))
  );
}

export function sanitizeSoundConfig(raw: unknown): ChatSoundConfig {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const customSounds = sanitizeCustomSounds(s.customSounds);
  const rawEvents = (
    s.eventSounds && typeof s.eventSounds === "object" ? s.eventSounds : {}
  ) as Record<string, unknown>;
  const eventSounds = {} as Record<ChatEventKind, string>;
  for (const kind of CHAT_EVENT_KINDS) {
    const v = rawEvents[kind];
    eventSounds[kind] =
      v === "none" || isKnownSoundId(v, customSounds)
        ? (v as string)
        : DEFAULT_EVENT_SOUNDS[kind];
  }
  return {
    enabled: typeof s.enabled === "boolean" ? s.enabled : DEFAULT_SOUND.enabled,
    volume: clampVolume(s.volume, DEFAULT_SOUND.volume),
    messageSound: isKnownSoundId(s.messageSound, customSounds)
      ? (s.messageSound as string)
      : DEFAULT_SOUND.messageSound,
    eventSoundsEnabled:
      typeof s.eventSoundsEnabled === "boolean"
        ? s.eventSoundsEnabled
        : DEFAULT_SOUND.eventSoundsEnabled,
    eventVolume: clampVolume(s.eventVolume, DEFAULT_SOUND.eventVolume),
    eventSounds,
    customSounds,
  };
}

/* ──────────────── resolution ──────────────── */

export type ResolvedSound =
  | { type: "synth"; id: SoundEffectId }
  | { type: "file"; url: string }
  | { type: "tts"; text: string; voiceName: string; rate: number };

/**
 * Turn a sound id into something playable. ``apiBase`` prefixes
 * upload paths (they're served by the API, not the web app).
 * Returns null for "none" / unknown / unplayable entries.
 */
export function resolveSound(
  id: string,
  config: ChatSoundConfig,
  apiBase = "",
): ResolvedSound | null {
  if (!id || id === "none") return null;
  if (isSoundEffectId(id)) return { type: "synth", id };
  if (isPackSoundId(id)) return { type: "file", url: packSoundUrl(id) };
  const custom = config.customSounds.find((c) => c.id === id);
  if (!custom) return null;
  if (custom.kind === "tts") {
    return {
      type: "tts",
      text: custom.text ?? "",
      voiceName: custom.voiceName ?? "",
      rate: custom.rate ?? 1,
    };
  }
  const url = custom.url ?? "";
  if (!url) return null;
  return {
    type: "file",
    url: url.startsWith("/") ? `${apiBase}${url}` : url,
  };
}

/* ──────────────── players ──────────────── */

/**
 * Shared lazy AudioContext holder — constructed on first play (by
 * then OBS/autoplay policy has usually settled), resumed on demand,
 * safe in environments without WebAudio (no-ops).
 */
function createContextHolder() {
  let ctx: AudioContext | null = null;
  let closed = false;
  return {
    acquire(): AudioContext | null {
      if (closed) return null;
      if (!ctx) {
        const Ctor =
          typeof window !== "undefined"
            ? (window.AudioContext ??
              (window as unknown as { webkitAudioContext?: typeof AudioContext })
                .webkitAudioContext)
            : undefined;
        if (!Ctor) return null;
        try {
          ctx = new Ctor();
        } catch {
          return null;
        }
      }
      if (ctx.state === "suspended") {
        // Autoplay policy — try to resume; if the browser refuses,
        // this play is skipped and a later one (post-gesture) works.
        void ctx.resume().catch(() => undefined);
        if (ctx.state === "suspended") return null;
      }
      return ctx;
    },
    close() {
      closed = true;
      try {
        void ctx?.close();
      } catch {
        /* already down */
      }
      ctx = null;
    },
  };
}

/**
 * One player over the whole unified namespace: WebAudio for synth
 * ids, a preloaded HTMLAudioElement per file URL, speechSynthesis for
 * tts lines. Everything degrades to a silent no-op when the backing
 * API is missing (SSR, jsdom, denied autoplay).
 */
function createUnifiedPlayer(config: ChatSoundConfig, apiBase: string) {
  const holder = createContextHolder();
  const files = new Map<string, HTMLAudioElement>();
  let closed = false;

  const fileFor = (url: string): HTMLAudioElement | null => {
    if (typeof Audio === "undefined") return null;
    let el = files.get(url);
    if (!el) {
      try {
        el = new Audio(url);
        el.preload = "auto";
        files.set(url, el);
      } catch {
        return null;
      }
    }
    return el;
  };

  return {
    /** Warm the HTTP cache for every file this config can play. */
    preload(ids: Iterable<string>) {
      for (const id of ids) {
        const r = resolveSound(id, config, apiBase);
        if (r?.type === "file") fileFor(r.url);
      }
    },
    play(id: string, volume: number) {
      if (closed || volume <= 0) return;
      const resolved = resolveSound(id, config, apiBase);
      if (!resolved) return;
      if (resolved.type === "synth") {
        const ctx = holder.acquire();
        if (ctx) playEffect(ctx, resolved.id, volume);
        return;
      }
      if (resolved.type === "file") {
        const el = fileFor(resolved.url);
        if (!el) return;
        try {
          el.currentTime = 0;
          el.volume = Math.min(1, Math.max(0, volume / 100));
          void el.play().catch(() => undefined);
        } catch {
          /* audio backend hiccup — skip this play */
        }
        return;
      }
      // tts line
      if (typeof window === "undefined" || !window.speechSynthesis) return;
      try {
        const u = new SpeechSynthesisUtterance(resolved.text);
        u.volume = Math.min(1, Math.max(0, volume / 100));
        u.rate = resolved.rate;
        if (resolved.voiceName) {
          const voice = window.speechSynthesis
            .getVoices()
            .find((v) => v.name === resolved.voiceName);
          if (voice) u.voice = voice;
        }
        window.speechSynthesis.speak(u);
      } catch {
        /* speech backend hiccup — skip this line */
      }
    },
    close() {
      closed = true;
      holder.close();
      for (const el of files.values()) {
        try {
          el.pause();
          el.src = "";
        } catch {
          /* already down */
        }
      }
      files.clear();
    },
  };
}

export interface ChatDinger {
  /** Request a ding; throttled internally. */
  ping(): void;
  close(): void;
}

/** Create a throttled message-ding player. */
export function createDinger(
  config: ChatSoundConfig,
  apiBase = "",
): ChatDinger {
  const player = createUnifiedPlayer(config, apiBase);
  player.preload([config.messageSound]);
  let lastPingMs = 0;
  return {
    ping() {
      if (config.volume <= 0) return;
      const now = Date.now();
      if (now - lastPingMs < SOUND_MIN_GAP_MS) return;
      lastPingMs = now;
      player.play(config.messageSound, config.volume);
    },
    close: () => player.close(),
  };
}

export interface EventSounder {
  /** Play the configured sound for an event kind; throttled. */
  play(kind: ChatEventKind): void;
  close(): void;
}

/** Create a throttled per-event-kind alert-sound player. */
export function createEventSounder(
  config: ChatSoundConfig,
  apiBase = "",
): EventSounder {
  const player = createUnifiedPlayer(config, apiBase);
  player.preload(Object.values(config.eventSounds));
  let lastPlayMs = 0;
  return {
    play(kind) {
      if (config.eventVolume <= 0) return;
      const id = config.eventSounds[kind];
      if (!id || id === "none") return;
      const now = Date.now();
      if (now - lastPlayMs < EVENT_SOUND_MIN_GAP_MS) return;
      lastPlayMs = now;
      player.play(id, config.eventVolume);
    },
    close: () => player.close(),
  };
}

/**
 * One-shot preview for Settings pickers — plays any id from the
 * unified namespace in a throwaway player released after the longest
 * effect finishes. The settings click IS the autoplay gesture.
 */
export function previewSound(
  id: string,
  volume: number,
  config: ChatSoundConfig = DEFAULT_SOUND,
  apiBase = "",
): void {
  if (!id || id === "none" || volume <= 0) return;
  const player = createUnifiedPlayer(config, apiBase);
  player.play(id, volume);
  setTimeout(() => player.close(), Math.max(EFFECT_MAX_DURATION_MS, 8_000));
}

/** Back-compat preview alias for synthesized effect pickers. */
export function previewEffect(id: SoundEffectId | "none", volume: number): void {
  previewSound(id, volume);
}
