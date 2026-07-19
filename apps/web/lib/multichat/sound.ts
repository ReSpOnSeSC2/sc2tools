// Multichat sounds — a short synthesized effect per incoming chat
// line, plus per-event-kind alert sounds for the ChatAlertsWidget.
// Everything is synthesized with WebAudio (lib/multichat/soundEffects)
// so the OBS Browser Source never fetches an audio asset; volumes are
// configurable and bursts are throttled so a raid doesn't machine-gun
// the stream audio.
//
// The sanitizer mirrors the API's (services/multichatAppearance —
// sanitizeChatSound) exactly.

import {
  EFFECT_MAX_DURATION_MS,
  isSoundEffectId,
  playEffect,
  type SoundEffectId,
} from "./soundEffects";
import { CHAT_EVENT_KINDS, type ChatEventKind } from "./events";

export interface ChatSoundConfig {
  enabled: boolean;
  /** 0–100. Message-ding volume. */
  volume: number;
  /** Effect played per incoming chat line. */
  messageSound: SoundEffectId;
  /** Alert sounds for the event toaster (subs, raids, gifts…). */
  eventSoundsEnabled: boolean;
  /** 0–100. Alert-sound volume, independent of the chat ding. */
  eventVolume: number;
  /** Per-event-kind effect; "none" silences that kind. */
  eventSounds: Record<ChatEventKind, SoundEffectId | "none">;
}

/**
 * Default per-kind mapping — hype events get hype sounds. Every kind
 * is always present in a sanitized config (stable JSON identity for
 * the widget's config-section diffing).
 */
export const DEFAULT_EVENT_SOUNDS: Record<
  ChatEventKind,
  SoundEffectId | "none"
> = {
  sub: "victory",
  resub: "victory",
  giftsub: "airhorn",
  raid: "airhorn",
  member: "sparkle",
  superchat: "coin",
  gift: "coin",
  follow: "pop",
};

export const DEFAULT_SOUND: ChatSoundConfig = {
  enabled: false,
  volume: 60,
  messageSound: "ding",
  eventSoundsEnabled: false,
  eventVolume: 70,
  eventSounds: { ...DEFAULT_EVENT_SOUNDS },
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

export function sanitizeSoundConfig(raw: unknown): ChatSoundConfig {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const rawEvents = (
    s.eventSounds && typeof s.eventSounds === "object" ? s.eventSounds : {}
  ) as Record<string, unknown>;
  const eventSounds = {} as Record<ChatEventKind, SoundEffectId | "none">;
  for (const kind of CHAT_EVENT_KINDS) {
    const v = rawEvents[kind];
    eventSounds[kind] =
      v === "none" || isSoundEffectId(v)
        ? (v as SoundEffectId | "none")
        : DEFAULT_EVENT_SOUNDS[kind];
  }
  return {
    enabled: typeof s.enabled === "boolean" ? s.enabled : DEFAULT_SOUND.enabled,
    volume: clampVolume(s.volume, DEFAULT_SOUND.volume),
    messageSound: isSoundEffectId(s.messageSound)
      ? s.messageSound
      : DEFAULT_SOUND.messageSound,
    eventSoundsEnabled:
      typeof s.eventSoundsEnabled === "boolean"
        ? s.eventSoundsEnabled
        : DEFAULT_SOUND.eventSoundsEnabled,
    eventVolume: clampVolume(s.eventVolume, DEFAULT_SOUND.eventVolume),
    eventSounds,
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
    /** Context ready to schedule into, or null (unsupported/refused). */
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

export interface ChatDinger {
  /** Request a ding; throttled internally. */
  ping(): void;
  close(): void;
}

/** Create a throttled message-ding player. */
export function createDinger(config: ChatSoundConfig): ChatDinger {
  const holder = createContextHolder();
  let lastPingMs = 0;
  return {
    ping() {
      if (config.volume <= 0) return;
      const now = Date.now();
      if (now - lastPingMs < SOUND_MIN_GAP_MS) return;
      const ctx = holder.acquire();
      if (!ctx) return;
      lastPingMs = now;
      playEffect(ctx, config.messageSound, config.volume);
    },
    close: () => holder.close(),
  };
}

export interface EventSounder {
  /** Play the configured effect for an event kind; throttled. */
  play(kind: ChatEventKind): void;
  close(): void;
}

/** Create a throttled per-event-kind alert-sound player. */
export function createEventSounder(config: ChatSoundConfig): EventSounder {
  const holder = createContextHolder();
  let lastPlayMs = 0;
  return {
    play(kind) {
      if (config.eventVolume <= 0) return;
      const effect = config.eventSounds[kind];
      if (!effect || effect === "none") return;
      const now = Date.now();
      if (now - lastPlayMs < EVENT_SOUND_MIN_GAP_MS) return;
      const ctx = holder.acquire();
      if (!ctx) return;
      lastPlayMs = now;
      playEffect(ctx, effect, config.eventVolume);
    },
    close: () => holder.close(),
  };
}

/**
 * One-shot preview for Settings pickers — plays the effect in a
 * throwaway context released after the longest effect finishes.
 * The settings click IS the autoplay gesture.
 */
export function previewEffect(id: SoundEffectId | "none", volume: number): void {
  if (id === "none" || volume <= 0) return;
  const holder = createContextHolder();
  const ctx = holder.acquire();
  if (!ctx) return;
  playEffect(ctx, id, volume);
  setTimeout(() => holder.close(), EFFECT_MAX_DURATION_MS + 200);
}
