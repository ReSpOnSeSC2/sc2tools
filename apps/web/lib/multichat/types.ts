// Multichat — shared contracts for the unified chat overlay widget.
//
// One message shape across four platforms so the feed, the widget and
// the tests never branch on platform-specific payloads. Engines
// normalise at the edge; everything downstream is platform-agnostic.

// Type-only import — erased at compile time, so the events ⇄ types
// reference cycle never exists at runtime.
import type { ChatEvent, ChatEventKind } from "./events";

export type ChatPlatform = "twitch" | "kick" | "youtube" | "tiktok";

export const CHAT_PLATFORMS: readonly ChatPlatform[] = [
  "twitch",
  "kick",
  "youtube",
  "tiktok",
] as const;

/** Normalised badge tags rendered as tiny glyphs by the widget. */
export type ChatBadge =
  | "owner"
  | "moderator"
  | "member"
  | "verified"
  | "vip";

export interface ChatMessage {
  platform: ChatPlatform;
  /** Platform-scoped id — deduped on (platform, id). */
  id: string;
  user: string;
  text: string;
  /** Author colour when the platform provides one (Twitch/Kick). */
  color?: string;
  badges: ChatBadge[];
  atMs: number;
  /**
   * Historical chat restored by a relay after this surface attached.
   * It remains visible in the feed, but must not trigger speech,
   * sounds, commands, or engagement a second time.
   */
  backlog?: boolean;
  /**
   * The platform also emitted a dedicated supporter event for this message.
   * Audio surfaces use the event sound instead of stacking generic chat audio.
   */
  pairedEventKind?: ChatEventKind;
  /** Presentation-only audio suppression; the message still renders normally. */
  suppressAudio?: boolean;
  emotes?: import("./emotes").ChatEmote[];
}

export type PlatformState =
  | "off"
  | "connecting"
  | "connected"
  | "offline"
  | "ended"
  | "error";

export interface PlatformStatus {
  platform: ChatPlatform;
  state: PlatformState;
  detail?: string;
}

/** Callbacks every engine reports through. */
export interface EngineCallbacks {
  onMessage(message: ChatMessage): void;
  onStatus(state: PlatformState, detail?: string): void;
  /** Platform events (subs, raids, gifts…) — optional, events-aware hosts only. */
  onEvent?(event: ChatEvent): void;
}

/** Every engine exposes exactly one lifecycle affordance. */
export interface ChatEngine {
  close(): void;
}

/** The per-platform config blob stored at /v1/me/preferences/multichat. */
export interface MultichatConfig {
  twitch?: { enabled: boolean; channel?: string };
  kick?: { enabled: boolean; channel?: string; chatroomId?: number };
  youtube?: { enabled: boolean; channel?: string };
  tiktok?: { enabled: boolean; username?: string };
  /**
   * Widget styling — untyped on the wire; always pass through
   * lib/multichat/appearance.sanitizeAppearance before use.
   */
  appearance?: Record<string, unknown>;
  /**
   * Text-to-speech settings — untyped on the wire; always pass
   * through lib/multichat/tts.sanitizeTtsConfig before use.
   */
  tts?: Record<string, unknown>;
  /**
   * Message-ding settings — untyped on the wire; always pass through
   * lib/multichat/sound.sanitizeSoundConfig before use.
   */
  sound?: Record<string, unknown>;
}
