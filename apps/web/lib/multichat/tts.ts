// Multichat TTS — reads incoming chat aloud through the Web Speech
// API, so the streamer hears chat without a second monitor.
//
// Design constraints:
//   - The OBS Browser Source and the streamer's desktop browser have
//     DIFFERENT voice inventories; the config stores a voice NAME and
//     the speaker falls back to the platform default when that name
//     isn't installed where it runs.
//   - Chat can burst far faster than speech. A small queue with a hard
//     cap keeps the readout near-real-time: when the queue is full the
//     OLDEST unspoken lines drop — being seconds behind a raid spam is
//     worse than skipping some of it.
//   - Speech text is scrubbed (URLs → "link", :emote: tokens dropped,
//     length-capped) so the voice never drones through a paste bomb.
//   - Browser autoplay policy may require one user gesture before
//     speech plays. The same persistence the scouting voice readout
//     uses (components/overlay/useVoiceReadout.gesture) carries the
//     unlock across OBS restarts; the widget shows the standard
//     gesture banner when speech is blocked.
//
// The sanitizer mirrors the API's (services/multichatAppearance —
// sanitizeChatTts) exactly.

import { clearPersistedUnlock } from "@/components/overlay/useVoiceReadout.gesture";
import type { ChatMessage, ChatPlatform } from "./types";
import { CHAT_PLATFORMS } from "./types";

/* ──────────────── config contract ──────────────── */

export interface ChatTtsConfig {
  enabled: boolean;
  /** Platforms to read. Empty = all. */
  platforms: ChatPlatform[];
  /** Prefix messages with the author name ("Name: text"). */
  readNames: boolean;
  /** Preferred voice NAME (browser-specific); "" = default voice. */
  voiceName: string;
  /** Speech rate 0.5–2.0. */
  rate: number;
  /** Volume 0–100. */
  volume: number;
  /** Hard cap on spoken characters per message. */
  maxChars: number;
  /** Skip "!command" lines. */
  skipCommands: boolean;
}

export const DEFAULT_TTS: ChatTtsConfig = {
  enabled: false,
  platforms: [],
  readNames: true,
  voiceName: "",
  rate: 1.0,
  volume: 100,
  maxChars: 200,
  skipCommands: true,
};

export const TTS_RATE_MIN = 0.5;
export const TTS_RATE_MAX = 2;
export const TTS_MAX_CHARS_MIN = 50;
export const TTS_MAX_CHARS_MAX = 500;
/** Unspoken-message queue cap — beyond this the oldest lines drop. */
export const TTS_QUEUE_CAP = 3;

export function sanitizeTtsConfig(raw: unknown): ChatTtsConfig {
  const t = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const d = DEFAULT_TTS;
  const rate = Number(t.rate);
  const volume = Number(t.volume);
  const maxChars = Number(t.maxChars);
  const platforms = Array.isArray(t.platforms)
    ? (t.platforms.filter((p) =>
        CHAT_PLATFORMS.includes(p as ChatPlatform),
      ) as ChatPlatform[])
    : d.platforms;
  return {
    enabled: typeof t.enabled === "boolean" ? t.enabled : d.enabled,
    platforms: [...new Set(platforms)],
    readNames: typeof t.readNames === "boolean" ? t.readNames : d.readNames,
    voiceName:
      typeof t.voiceName === "string" ? t.voiceName.slice(0, 120) : d.voiceName,
    rate: Number.isFinite(rate)
      ? Math.min(TTS_RATE_MAX, Math.max(TTS_RATE_MIN, rate))
      : d.rate,
    volume: Number.isFinite(volume)
      ? Math.min(100, Math.max(0, Math.round(volume)))
      : d.volume,
    maxChars: Number.isFinite(maxChars)
      ? Math.min(TTS_MAX_CHARS_MAX, Math.max(TTS_MAX_CHARS_MIN, Math.round(maxChars)))
      : d.maxChars,
    skipCommands:
      typeof t.skipCommands === "boolean" ? t.skipCommands : d.skipCommands,
  };
}

/* ──────────────── speech-text scrubbing ──────────────── */

/**
 * Turn a chat message into speakable text, or null when it shouldn't
 * be spoken at all (filtered platform, command, emote-only …). Pure —
 * fully unit-tested.
 */
export function speakableText(
  message: ChatMessage,
  config: ChatTtsConfig,
): string | null {
  if (
    config.platforms.length > 0 &&
    !config.platforms.includes(message.platform)
  ) {
    return null;
  }
  if (config.skipCommands && message.text.startsWith("!")) return null;
  let text = message.text
    // URLs read as the word "link" instead of letter soup.
    .replace(/https?:\/\/\S+/gi, "link")
    // :emote: tokens are visual, not speech.
    .replace(/:[a-z0-9_]+:/gi, " ")
    // Collapse whitespace and long character runs ("aaaaaaaa" → "aaa").
    .replace(/(.)\1{4,}/g, "$1$1$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!text) return null;
  if (text.length > config.maxChars) {
    text = `${text.slice(0, config.maxChars)}…`;
  }
  return config.readNames ? `${message.user}: ${text}` : text;
}

/* ──────────────── the speaker ──────────────── */

export interface ChatSpeaker {
  /** Queue a message; drops oldest when the queue is full. */
  speak(message: ChatMessage): void;
  /** True when the browser refused speech pending a user gesture. */
  readonly blocked: boolean;
  /** Call from a click/key handler to retry after a gesture. */
  unlock(): void;
  close(): void;
}

/**
 * Create a queued speaker bound to one ChatTtsConfig. Uses the global
 * speechSynthesis; safe to construct in environments without it (every
 * method no-ops).
 */
export function createChatSpeaker(
  config: ChatTtsConfig,
  onBlockedChange?: (blocked: boolean) => void,
): ChatSpeaker {
  const synth =
    typeof window !== "undefined" ? window.speechSynthesis : undefined;
  let queue: string[] = [];
  let speaking = false;
  let blocked = false;
  let closed = false;

  const setBlocked = (next: boolean) => {
    if (blocked === next) return;
    blocked = next;
    onBlockedChange?.(next);
  };

  const pickVoice = (): SpeechSynthesisVoice | null => {
    if (!synth || !config.voiceName) return null;
    return (
      synth.getVoices().find((v) => v.name === config.voiceName) ?? null
    );
  };

  const pump = () => {
    if (!synth || closed || speaking) return;
    const next = queue.shift();
    if (next === undefined) return;
    const utterance = new SpeechSynthesisUtterance(next);
    utterance.rate = config.rate;
    utterance.volume = config.volume / 100;
    const voice = pickVoice();
    if (voice) utterance.voice = voice;
    speaking = true;
    utterance.onend = () => {
      speaking = false;
      pump();
    };
    utterance.onerror = (event) => {
      speaking = false;
      if (event.error === "not-allowed") {
        // Autoplay policy — surface the gesture banner and hold the
        // line for retry after the unlock instead of dropping it.
        // Also drop the persisted unlock (same contract as the
        // scouting readout) so the banner shows promptly on the next
        // OBS boot rather than after another lost line.
        queue.unshift(next);
        while (queue.length > TTS_QUEUE_CAP) queue.pop();
        clearPersistedUnlock();
        setBlocked(true);
        return;
      }
      pump();
    };
    try {
      synth.speak(utterance);
    } catch {
      speaking = false;
    }
  };

  return {
    speak(message: ChatMessage) {
      if (!synth || closed) return;
      const text = speakableText(message, config);
      if (!text) return;
      queue.push(text);
      while (queue.length > TTS_QUEUE_CAP) queue.shift();
      pump();
    },
    get blocked() {
      return blocked;
    },
    unlock() {
      if (!synth) return;
      setBlocked(false);
      // A zero-length utterance inside the gesture handler satisfies
      // the autoplay policy for subsequent speech.
      try {
        synth.speak(new SpeechSynthesisUtterance(""));
      } catch {
        /* best effort */
      }
      pump();
    },
    close() {
      closed = true;
      queue = [];
      try {
        synth?.cancel();
      } catch {
        /* already down */
      }
    },
  };
}
