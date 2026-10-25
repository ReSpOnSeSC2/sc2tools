"use client";

import { useEffect, useState } from "react";
import { API_BASE } from "@/lib/clientApi";
import { DEFAULT_APPEARANCE, sanitizeAppearance, type ChatAppearance } from "@/lib/multichat/appearance";
import type { MultichatConfig } from "@/lib/multichat/types";
import { sanitizeTtsConfig, type ChatTtsConfig } from "@/lib/multichat/tts";
import { DOCK_CONFIG_REFRESH_MS as CONFIG_REFRESH_MS } from "./dockConstants";

const DEFAULT_MODERATION_APPEARANCE = {
  blockedUsers: DEFAULT_APPEARANCE.blockedUsers,
  hideBots: DEFAULT_APPEARANCE.hideBots,
};

/**
 * Platform entries only, identity-stable across refetches — same
 * contract as the widget's config loader: useMultiChat reconnects
 * every engine when the object identity changes, so styling blobs
 * must never ride along and equal payloads must not mint new objects.
 */
export function useDockPlatformConfig(token: string, onInvalid: () => void): {
  platforms: MultichatConfig | null;
  moderationAppearance: Pick<ChatAppearance, "blockedUsers" | "hideBots">;
  /** Read-aloud voice settings, shared with the OBS multichat widget. */
  tts: ChatTtsConfig;
  loaded: boolean;
} {
  const [platforms, setPlatforms] = useState<MultichatConfig | null>(null);
  const [moderationAppearance, setModerationAppearance] = useState<
    Pick<ChatAppearance, "blockedUsers" | "hideBots">
  >(DEFAULT_MODERATION_APPEARANCE);
  const [tts, setTts] = useState<ChatTtsConfig>(() => sanitizeTtsConfig(null));
  const [loadedToken, setLoadedToken] = useState<string | null>(null);
  const loaded = loadedToken === token;

  useEffect(() => {
    let cancelled = false;
    let lastJson = "";
    let lastModerationJson = "";
    let lastTtsJson = "";
    const load = async () => {
      try {
        const res = await fetch(
          `${API_BASE}/v1/multichat/${encodeURIComponent(token)}/config`,
          { cache: "no-store" },
        );
        if (!cancelled && res.status === 401) { onInvalid(); return; }
        if (!res.ok) return;
        const body: unknown = await res.json();
        if (!body || typeof body !== "object" || Array.isArray(body)) return;
        const rawConfig = (body as Record<string, unknown>).config;
        if (
          rawConfig != null
          && (typeof rawConfig !== "object" || Array.isArray(rawConfig))
        ) return;
        if (cancelled) return;
        const config = (rawConfig ?? {}) as MultichatConfig;
        const {
          appearance,
          tts: rawTts,
          sound: _sound,
          alerts: _alerts,
          ...next
        } = config;
        const json = JSON.stringify(next);
        if (json !== lastJson) {
          lastJson = json;
          setPlatforms(next);
        }
        // Appearance styling must not enter the platform object above: doing
        // so reconnects every chat engine.  Keep only the two moderation
        // fields the Dock needs, strictly sanitized and identity-stable.
        const sanitized = sanitizeAppearance(appearance);
        const nextModeration = {
          blockedUsers: sanitized.blockedUsers,
          hideBots: sanitized.hideBots,
        };
        const moderationJson = JSON.stringify(nextModeration);
        if (moderationJson !== lastModerationJson) {
          lastModerationJson = moderationJson;
          setModerationAppearance(nextModeration);
        }
        // Read-aloud voice. Kept OUT of the platform object above for
        // the same reason appearance is: a new identity there would
        // reconnect every chat engine.
        const nextTts = sanitizeTtsConfig(rawTts);
        const ttsJson = JSON.stringify(nextTts);
        if (ttsJson !== lastTtsJson) {
          lastTtsJson = ttsJson;
          setTts(nextTts);
        }
        setLoadedToken(token);
      } catch {
        /* transient — next tick retries */
      }
    };
    void load();
    const timer = setInterval(load, CONFIG_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [token, onInvalid]);

  return {
    platforms: loaded ? platforms : null,
    moderationAppearance: loaded
      ? moderationAppearance
      : DEFAULT_MODERATION_APPEARANCE,
    tts,
    loaded,
  };
}
