// Multichat message sound — a short synthesized "ding" per incoming
// chat line. Synthesized with WebAudio (two-tone sine blip) so the
// OBS Browser Source never fetches an audio asset; volume is
// configurable and bursts are throttled so a raid doesn't machine-gun
// the stream audio.
//
// The sanitizer mirrors the API's (services/multichatAppearance —
// sanitizeChatSound) exactly.

export interface ChatSoundConfig {
  enabled: boolean;
  /** 0–100. */
  volume: number;
}

export const DEFAULT_SOUND: ChatSoundConfig = {
  enabled: false,
  volume: 60,
};

/** Minimum gap between dings — chat bursts collapse into one. */
export const SOUND_MIN_GAP_MS = 1500;

export function sanitizeSoundConfig(raw: unknown): ChatSoundConfig {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const volume = Number(s.volume);
  return {
    enabled: typeof s.enabled === "boolean" ? s.enabled : DEFAULT_SOUND.enabled,
    volume: Number.isFinite(volume)
      ? Math.min(100, Math.max(0, Math.round(volume)))
      : DEFAULT_SOUND.volume,
  };
}

export interface ChatDinger {
  /** Request a ding; throttled internally. */
  ping(): void;
  close(): void;
}

/**
 * Create a throttled ding player. Uses a lazily-created AudioContext
 * (constructed on first ping — by then OBS/autoplay policy has
 * usually settled). Safe in environments without WebAudio: no-ops.
 */
export function createDinger(config: ChatSoundConfig): ChatDinger {
  let ctx: AudioContext | null = null;
  let lastPingMs = 0;
  let closed = false;

  const ensureContext = (): AudioContext | null => {
    if (closed) return null;
    if (ctx) return ctx;
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
    return ctx;
  };

  return {
    ping() {
      if (closed || config.volume <= 0) return;
      const now = Date.now();
      if (now - lastPingMs < SOUND_MIN_GAP_MS) return;
      const context = ensureContext();
      if (!context) return;
      if (context.state === "suspended") {
        // Autoplay policy — try to resume; if the browser refuses,
        // this ding is skipped and a later one (post-gesture) works.
        void context.resume().catch(() => undefined);
        if (context.state === "suspended") return;
      }
      lastPingMs = now;
      try {
        const t0 = context.currentTime;
        const gain = context.createGain();
        const peak = 0.25 * (config.volume / 100);
        gain.gain.setValueAtTime(0, t0);
        gain.gain.linearRampToValueAtTime(peak, t0 + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.35);
        gain.connect(context.destination);
        // Two-tone blip: E6 → B6, the classic friendly notification.
        const osc1 = context.createOscillator();
        osc1.type = "sine";
        osc1.frequency.setValueAtTime(1318.5, t0);
        osc1.connect(gain);
        osc1.start(t0);
        osc1.stop(t0 + 0.12);
        const osc2 = context.createOscillator();
        osc2.type = "sine";
        osc2.frequency.setValueAtTime(1975.5, t0 + 0.1);
        osc2.connect(gain);
        osc2.start(t0 + 0.1);
        osc2.stop(t0 + 0.35);
      } catch {
        /* audio backend hiccup — skip this ding */
      }
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
