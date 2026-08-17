"use client";

/**
 * MultiChatWidget — every chat, one overlay.
 *
 * Combines Twitch, Kick, YouTube and TikTok live chat into a single
 * broadcast-ready feed. Connection model per platform:
 *
 *   - Twitch — anonymous read-only IRC WebSocket, straight from this
 *     Browser Source. Channel name only, no OAuth.
 *   - Kick — Kick's public Pusher WebSocket, straight from this
 *     Browser Source. Chatroom id resolved once at setup.
 *   - YouTube — the cloud's stateless resolve/poll relay (YouTube has
 *     no CORS); the widget owns the polling loop.
 *   - TikTok — the cloud's SSE relay (TikTok's webcast socket needs
 *     signed URLs). Username only — NO stream key required — and an
 *     offline TikTok simply idles with a status dot until it goes
 *     live; the other platforms are never affected.
 *
 * The widget is self-driven for data (no game payloads), but it DOES
 * read the shared ``overlay:live`` socket payload for one thing: the
 * Settings Test button. A test-stamped payload targeting "multichat"
 * plays a scripted demo chat stream (lib/multichat/testMessages) for
 * the standard test window so the streamer can place and style the
 * source without waiting for real chat.
 *
 * Appearance (font, layout, animation, background, filters …) comes
 * from the same server-stored config blob as the channels and is
 * re-read every minute — Settings changes land in OBS untouched.
 * Rendering itself lives in MultiChatMessageList, shared with the
 * Settings live preview so the preview is pixel-honest.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { API_BASE } from "@/lib/clientApi";
import {
  DEFAULT_APPEARANCE,
  appearanceStyles,
  blockedUserSet,
  excludeBlockedUsers,
  sanitizeAppearance,
  visibleMessages,
  type ChatAppearance,
} from "@/lib/multichat/appearance";
import { useEngagementReporter } from "@/lib/multichat/useEngagementReporter";
import { useMultiChat } from "@/lib/multichat/useMultiChat";
import { useStudioState } from "@/lib/multichat/useStudioState";
import {
  TEST_MESSAGE_INTERVAL_MS,
  TEST_SEQUENCE_LENGTH,
  testChatMessage,
} from "@/lib/multichat/testMessages";
import { TEST_DURATION_MS } from "@/components/overlay/widgetLifecycle";
import { VoiceGestureBanner } from "@/components/overlay/VoiceGestureBanner";
import {
  overlayFeedTailIsQuiet,
  useOverlayBuildRefresh,
} from "@/components/overlay/useOverlayBuildRefresh";
import { useChatSound } from "@/lib/multichat/useChatSound";
import { useChatTts } from "@/lib/multichat/useChatTts";
import { sanitizeSoundConfig } from "@/lib/multichat/sound";
import {
  DEFAULT_ALERTS,
  sanitizeAlertConfig,
  type AlertConfig,
} from "@/lib/multichat/alerts";
import { useCommandAnswers } from "@/lib/multichat/useCommandAnswers";
import { sanitizeRankRace } from "@/lib/multichat/rankLadders";
import { useTranslation } from "@/lib/multichat/useTranslation";
import { MultiChatMessageList, PLATFORM_META } from "./MultiChatMessageList";
import type {
  ChatMessage,
  ChatPlatform,
  MultichatConfig,
  PlatformState,
} from "@/lib/multichat/types";
import type { LiveGamePayload } from "@/components/overlay/types";
import { chatEventIdentity } from "@/lib/multichat/events";
import {
  useSpeechSynthesisIdle,
  useWidgetAudioOwner,
} from "./widgetAudio";

/** Re-read the streamer's platform + appearance config on this cadence. */
const CONFIG_REFRESH_MS = 60_000;
/** Wait for a short chat lull before applying a newly deployed widget build. */
const BUILD_REFRESH_QUIET_MS = 15_000;

const STATE_DOT: Record<PlatformState, string> = {
  off: "#6b7280",
  connecting: "#f5b942",
  connected: "#3ec07a",
  offline: "#6b7280",
  ended: "#6b7280",
  error: "#ff6b6b",
};

export interface LoadedConfig {
  /** Platform entries ONLY — identity changes reconnect chat engines. */
  platforms: MultichatConfig | null;
  appearance: ChatAppearance;
  /** Raw TTS blob — stable identity; sanitized inside useChatTts. */
  tts: Record<string, unknown> | null;
  /** Raw ding blob — stable identity; sanitized inside useChatSound. */
  sound: Record<string, unknown> | null;
  /** Visual treatment for the event-alert Browser Source. */
  alerts: AlertConfig;
  loaded: boolean;
}

/**
 * Shared config loader for the multichat widget family — exported so
 * the studio widgets (chat-poll, chat-alerts) can run their own
 * useMultiChat feed off the same platform config without duplicating
 * the fetch/split/identity logic.
 */
export function useMultichatConfig(token: string): LoadedConfig {
  const [platforms, setPlatforms] = useState<MultichatConfig | null>(null);
  const [appearance, setAppearance] = useState<ChatAppearance>(DEFAULT_APPEARANCE);
  const [tts, setTts] = useState<Record<string, unknown> | null>(null);
  const [sound, setSound] = useState<Record<string, unknown> | null>(null);
  const [alerts, setAlerts] = useState<AlertConfig>(DEFAULT_ALERTS);
  // Readiness belongs to the token, not merely to this hook instance. A
  // Settings preview can reuse the component for another overlay token; mask
  // the previous token's channels and moderation config until the new token's
  // authoritative response succeeds.
  const [loadedToken, setLoadedToken] = useState<string | null>(null);
  const loaded = loadedToken === token;

  useEffect(() => {
    let cancelled = false;
    // Identity is tracked PER SECTION: useMultiChat tears down and
    // reconnects every chat engine when its config object changes, so
    // a styling or TTS tweak must never mint a new platforms object —
    // pre-split, a font-size nudge disconnected Twitch/Kick/TikTok on
    // stream and re-burned the YouTube resolve budget.
    let lastPlatformsJson = "";
    let lastAppearanceJson = "";
    let lastTtsJson = "";
    let lastSoundJson = "";
    let lastAlertsJson = "";
    const load = async () => {
      try {
        const res = await fetch(
          `${API_BASE}/v1/multichat/${encodeURIComponent(token)}/config`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const body: unknown = await res.json();
        if (!body || typeof body !== "object" || Array.isArray(body)) return;
        const rawConfig = (body as Record<string, unknown>).config;
        if (
          rawConfig != null
          && (typeof rawConfig !== "object" || Array.isArray(rawConfig))
        ) return;
        if (cancelled) return;
        const next = (rawConfig ?? {}) as MultichatConfig;
        const {
          appearance: nextAppearance,
          tts: nextTts,
          sound: nextSound,
          alerts: nextAlerts,
          ...nextPlatforms
        } = next;

        const platformsJson = JSON.stringify(nextPlatforms);
        if (platformsJson !== lastPlatformsJson) {
          lastPlatformsJson = platformsJson;
          setPlatforms(nextPlatforms);
        }
        const appearanceJson = JSON.stringify(nextAppearance ?? null);
        if (appearanceJson !== lastAppearanceJson) {
          lastAppearanceJson = appearanceJson;
          setAppearance(sanitizeAppearance(nextAppearance));
        }
        const ttsJson = JSON.stringify(nextTts ?? null);
        if (ttsJson !== lastTtsJson) {
          lastTtsJson = ttsJson;
          setTts(nextTts ?? null);
        }
        const soundJson = JSON.stringify(nextSound ?? null);
        if (soundJson !== lastSoundJson) {
          lastSoundJson = soundJson;
          setSound(nextSound ?? null);
        }
        const alertsJson = JSON.stringify(nextAlerts ?? null);
        if (alertsJson !== lastAlertsJson) {
          lastAlertsJson = alertsJson;
          setAlerts(sanitizeAlertConfig(nextAlerts));
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
  }, [token]);

  return {
    platforms: loaded ? platforms : null,
    appearance: loaded ? appearance : DEFAULT_APPEARANCE,
    tts: loaded ? tts : null,
    sound: loaded ? sound : null,
    alerts: loaded ? alerts : DEFAULT_ALERTS,
    loaded,
  };
}

/**
 * Test-fire demo stream. Each test-stamped ``overlay:live`` payload
 * targeting this widget (re)starts the scripted sequence — first
 * message immediately, the rest on a cadence — self-capped at the
 * standard test window (the widget bypasses the payload visibility
 * timer, so it caps itself).
 *
 * Latch semantics: a running demo survives NON-test payload
 * deliveries (socket resync replays the latest REAL snapshot; a game
 * can end mid-test) — only ``overlay:clear`` (live → null, the
 * Settings Stop button) or the window expiring stops it early.
 */
function useTestFire(live: LiveGamePayload | null | undefined): ChatMessage[] {
  const [testMessages, setTestMessages] = useState<ChatMessage[]>([]);
  const timersRef = useRef<{
    feed: ReturnType<typeof setInterval> | null;
    stop: ReturnType<typeof setTimeout> | null;
  }>({ feed: null, stop: null });

  const clearTimers = () => {
    if (timersRef.current.feed) clearInterval(timersRef.current.feed);
    if (timersRef.current.stop) clearTimeout(timersRef.current.stop);
    timersRef.current.feed = null;
    timersRef.current.stop = null;
  };

  useEffect(() => {
    if (live === null) {
      // overlay:clear — the Stop button. End the demo immediately.
      clearTimers();
      setTestMessages([]);
      return;
    }
    const isTestPayload = Boolean(
      live?.isTest && (!live.testWidget || live.testWidget === "multichat"),
    );
    // Real payloads mid-demo (resync replay, an actual game ending)
    // must NOT abort the run — leave the timers alone.
    if (!isTestPayload) return;

    clearTimers();
    const first = testChatMessage(0, Date.now());
    setTestMessages(first ? [first] : []);
    let index = 1;
    timersRef.current.feed = setInterval(() => {
      const message = testChatMessage(index, Date.now());
      index += 1;
      if (message) setTestMessages((prev) => [...prev, message]);
      if (!message || index >= TEST_SEQUENCE_LENGTH) {
        // Sequence done — stop feeding, but leave the stop timer to
        // clear the demo at the standard test window.
        if (timersRef.current.feed) clearInterval(timersRef.current.feed);
        timersRef.current.feed = null;
      }
    }, TEST_MESSAGE_INTERVAL_MS);
    timersRef.current.stop = setTimeout(() => {
      clearTimers();
      setTestMessages([]);
    }, TEST_DURATION_MS);
  }, [live]);

  // Unmount-only cleanup — per-dep cleanup would defeat the latch.
  useEffect(() => clearTimers, []);

  return testMessages;
}

export function MultiChatWidget({
  token,
  live,
  studioEvent,
}: {
  token: string;
  /** Shared overlay payload — read ONLY for the Test-fire flag. */
  live?: LiveGamePayload | null;
  /** Shared Stream Dock state, including its moderation blocklist. */
  studioEvent?: unknown;
}) {
  const audioOwner = useWidgetAudioOwner();
  const { platforms, appearance, tts, sound, loaded } = useMultichatConfig(token);
  const studio = useStudioState(token, studioEvent ?? null);
  const { messages, events: feedEvents, statuses, active } = useMultiChat({
    apiBase: API_BASE,
    token,
    config: platforms,
  });
  const blockedUsers = useMemo(
    () => blockedUserSet(appearance, studio.blockedUsers),
    [appearance, studio.blockedUsers],
  );
  const moderationReady = loaded && studio.snapshotReady;
  const moderatedMessages = useMemo(
    () => moderationReady ? excludeBlockedUsers(messages, blockedUsers) : [],
    [blockedUsers, messages, moderationReady],
  );
  const moderatedEvents = useMemo(
    () => moderationReady ? excludeBlockedUsers(feedEvents, blockedUsers) : [],
    [blockedUsers, feedEvents, moderationReady],
  );
  useEngagementReporter(token, moderatedMessages, moderatedEvents);
  const testMessages = useTestFire(live);
  const testActive = testMessages.length > 0;
  const latestFeedAtMs = Math.max(
    moderatedMessages.at(-1)?.atMs ?? 0,
    moderatedEvents.at(-1)?.atMs ?? 0,
  );
  const lastMessage = moderatedMessages.at(-1);
  const lastEvent = moderatedEvents.at(-1);
  const latestFeedTailIdentity = [
    lastMessage
      ? `m:${lastMessage.platform}:${lastMessage.id}:${lastMessage.atMs}`
      : "m:none",
    lastEvent
      ? `e:${chatEventIdentity(lastEvent)}:${lastEvent.atMs}:${lastEvent.amount ?? ""}`
      : "e:none",
  ].join("|");
  const initiallyQuiet =
    latestFeedAtMs === 0
    || Date.now() - latestFeedAtMs >= BUILD_REFRESH_QUIET_MS;
  const [buildRefreshQuiet, setBuildRefreshQuiet] = useState(initiallyQuiet);
  const [quietConfirmedTail, setQuietConfirmedTail] = useState<string | null>(
    () => initiallyQuiet ? latestFeedTailIdentity : null,
  );
  const buildRefreshInitializedRef = useRef(false);
  useEffect(() => {
    const firstObservation = !buildRefreshInitializedRef.current;
    buildRefreshInitializedRef.current = true;
    if (latestFeedAtMs === 0) {
      setBuildRefreshQuiet(true);
      setQuietConfirmedTail(latestFeedTailIdentity);
      return;
    }
    // Only the initial replay/backlog may use its platform timestamp. Every
    // tail change observed after mount gets a full local quiet window: clocks
    // across Twitch/YouTube/TikTok/Kick are not ordered with each other.
    const remaining = firstObservation
      ? BUILD_REFRESH_QUIET_MS
        - Math.max(0, Date.now() - latestFeedAtMs)
      : BUILD_REFRESH_QUIET_MS;
    if (remaining <= 0) {
      setBuildRefreshQuiet(true);
      setQuietConfirmedTail(latestFeedTailIdentity);
      return;
    }
    setBuildRefreshQuiet(false);
    const timer = window.setTimeout(() => {
      setQuietConfirmedTail(latestFeedTailIdentity);
      setBuildRefreshQuiet(true);
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [latestFeedAtMs, latestFeedTailIdentity]);
  const feedTailQuiet = overlayFeedTailIsQuiet(
    buildRefreshQuiet,
    latestFeedTailIdentity,
    quietConfirmedTail,
  );

  // TTL needs a clock: tick once a second only while a TTL is set,
  // so expired lines actually leave the screen between messages. The
  // immediate set covers TTL flipping on mid-session — without it the
  // first filter pass would run against the mount-era clock.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (appearance.messageTtlSec <= 0) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [appearance.messageTtlSec]);

  // nowMs only advances while a TTL is set; visibleMessages ignores it
  // otherwise, so the stale value is harmless with TTL off.
  const visible = useMemo(
    () => visibleMessages(
      testActive ? testMessages : moderatedMessages,
      appearance,
      nowMs,
    ),
    [testActive, testMessages, moderatedMessages, appearance, nowMs],
  );
  // Event cards obey the same on-screen lifetime as chat lines. The Dock keeps
  // the full session timeline; the overlay should not leave an old follow or
  // sub card pinned forever after its dedicated alert has dismissed.
  const visibleEvents = useMemo(() => {
    if (testActive) return [];
    if (appearance.messageTtlSec <= 0) return moderatedEvents;
    const ttlMs = appearance.messageTtlSec * 1000;
    return moderatedEvents.filter((event) => nowMs - event.atMs < ttlMs);
  }, [testActive, moderatedEvents, appearance.messageTtlSec, nowMs]);

  // TTS + the message ding read the same filtered stream the panel
  // shows (blocklists and command-hiding apply to both). Test fires
  // trigger them too — the streamer can verify audio from the
  // Settings Test button.
  const audioTts = useMemo(
    () => audioOwner ? tts : { ...(tts ?? {}), enabled: false },
    [audioOwner, tts],
  );
  const audioSound = useMemo(
    () => audioOwner ? sound : { ...(sound ?? {}), enabled: false },
    [audioOwner, sound],
  );
  const eventSoundConfig = useMemo(() => sanitizeSoundConfig(sound), [sound]);
  const audioMessages = useMemo(
    () => visible.map((message) => {
      const kind = message.pairedEventKind;
      if (
        !audioOwner ||
        !kind ||
        !eventSoundConfig.eventSoundsEnabled ||
        eventSoundConfig.eventVolume <= 0 ||
        eventSoundConfig.eventSounds[kind] === "none"
      ) {
        return message;
      }
      // Twitch cheers are both a chat line and a supporter event. Preserve the
      // line visually, but let its dedicated alert sound be the only audio so
      // one action never stacks TTS + a generic ding + a cheer effect.
      return { ...message, suppressAudio: true };
    }),
    [audioOwner, eventSoundConfig, visible],
  );
  const voice = useChatTts(audioMessages, audioTts);
  useChatSound(audioMessages, audioSound);
  const speechIdle = useSpeechSynthesisIdle(audioOwner);
  useOverlayBuildRefresh({
    enabled: !testActive,
    safeToReload:
      feedTailQuiet
      && (
        !audioOwner
        || (speechIdle && !voice.needsGesture)
      ),
  });

  // BRB scene mode (?mode=brb on the Browser Source URL): centered,
  // larger-type layout for "be right back" scenes — same feed, same
  // appearance, just presented as the main attraction.
  const brbMode = useMemo(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("mode") === "brb";
  }, []);

  // !opponent / !mmr / !build / !rank asked in ANY connected chat get
  // answered on stream (chatbot lines; !rank = the asker's loyalty XP,
  // themed by the Settings rank race riding the platforms blob).
  const answer = useCommandAnswers(visible, {
    apiBase: API_BASE,
    token,
    enabled: true,
    rankRace: sanitizeRankRace(
      (platforms as { engagement?: { rankRace?: string } } | null)?.engagement
        ?.rankRace,
    ),
  });

  // Inline translation — enabled from Settings. The translate blob
  // rides on `platforms` (part of that JSON identity — existing
  // behavior); the widget only ever learns {enabled, mode, targetLang}
  // — provider endpoint/key never leave the server.
  const translateConfig = useMemo(() => {
    const t = (
      platforms as
        | (MultichatConfig & {
            translate?: { enabled?: boolean; mode?: string; targetLang?: string };
          })
        | null
    )?.translate;
    if (!t || t.enabled !== true) return null;
    return {
      enabled: true,
      mode: t.mode === "provider" ? ("provider" as const) : ("local" as const),
      targetLang: typeof t.targetLang === "string" ? t.targetLang : "en",
    };
  }, [platforms]);
  const translations = useTranslation(visible, {
    apiBase: API_BASE,
    token,
    config: translateConfig,
  });

  const configuredPlatforms = useMemo(() => {
    if (!platforms) return [] as ChatPlatform[];
    const out: ChatPlatform[] = [];
    if (platforms.twitch?.enabled && platforms.twitch.channel) out.push("twitch");
    if (platforms.kick?.enabled && platforms.kick.chatroomId) out.push("kick");
    if (platforms.youtube?.enabled && platforms.youtube.channel) out.push("youtube");
    if (platforms.tiktok?.enabled && platforms.tiktok.username) out.push("tiktok");
    return out;
  }, [platforms]);

  const allConnected =
    configuredPlatforms.length > 0 &&
    configuredPlatforms.every((p) => statuses[p]?.state === "connected");

  const effectiveAppearance = useMemo(
    () =>
      brbMode
        ? {
            ...appearance,
            fontSize: Math.min(40, Math.round(appearance.fontSize * 1.5)),
            align: "left" as const,
          }
        : appearance,
    [appearance, brbMode],
  );
  const styles = useMemo(
    () => appearanceStyles(effectiveAppearance),
    [effectiveAppearance],
  );
  const shell: CSSProperties = {
    width: "100%",
    minWidth: 240,
    display: "flex",
    flexDirection: "column",
    height: "100%",
    background: styles.panelBackground,
    border: appearance.panelBorder
      ? "var(--ov-shell-border, 1px solid rgba(255,255,255,0.10))"
      : "none",
    borderRadius: appearance.cornerRadius,
    boxShadow:
      appearance.bgOpacity > 5 ? "0 6px 20px rgba(0,0,0,0.45)" : "none",
    overflow: "hidden",
  };

  if (!loaded) return <div style={{ background: "transparent" }} />;

  if (platforms && configuredPlatforms.length === 0 && !testActive) {
    return (
      <div style={frameStyle}>
        <div style={{ ...shell, height: "auto" }}>
          <div style={{ padding: "14px 16px" }}>
            <div style={titleStyle}>MULTI-CHAT</div>
            <div
              style={{
                fontSize: 13,
                color: "rgba(255,255,255,0.85)",
                marginTop: 6,
                lineHeight: 1.5,
                fontFamily: styles.fontFamily,
              }}
            >
              No chat platforms configured yet. Open{" "}
              <b>Settings → Overlay → Multi-platform chat</b> on sc2tools.com,
              add your channels, and this source lights up automatically.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      style={
        brbMode
          ? { ...frameStyle, justifyContent: "center", padding: "4vh 6vw" }
          : frameStyle
      }
    >
      <div style={brbMode ? { ...shell, maxWidth: 900, margin: "0 auto" } : shell}>
        {testActive || (!allConnected && active) ? (
          <div style={statusRowStyle}>
            {testActive ? (
              <span
                style={{
                  ...statusChipStyle,
                  color: "#f5b942",
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                }}
              >
                TEST
              </span>
            ) : null}
            {!testActive
              ? configuredPlatforms.map((p) => {
                  const st = statuses[p]?.state ?? "connecting";
                  return (
                    <span
                      key={p}
                      style={statusChipStyle}
                      title={statuses[p]?.detail}
                    >
                      <span
                        style={{
                          display: "inline-block",
                          width: 7,
                          height: 7,
                          borderRadius: 99,
                          background: STATE_DOT[st],
                        }}
                      />
                      <span style={{ opacity: 0.9 }}>
                        {PLATFORM_META[p].label}
                      </span>
                      <span style={{ opacity: 0.55 }}>{statusLabel(st)}</span>
                    </span>
                  );
                })
              : null}
          </div>
        ) : null}
        {answer ? (
          <div style={answerCardStyle}>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.12em", color: "var(--ov-accent, #3ec0c7)" }}>
              !{answer.command} · asked by {answer.user}
            </div>
            <div style={{ marginTop: 3, fontSize: 13, lineHeight: 1.45, color: "rgba(255,255,255,0.92)" }}>
              {answer.text}
            </div>
          </div>
        ) : null}
        <MultiChatMessageList
          messages={visible}
          events={visibleEvents}
          appearance={effectiveAppearance}
          translations={translations}
          emptyText={
            configuredPlatforms.length > 0
              ? "Connected — waiting for chat…"
              : undefined
          }
        />
      </div>
      {voice.needsGesture ? (
        <VoiceGestureBanner onClick={voice.onUserGesture} />
      ) : null}
    </div>
  );
}

function statusLabel(state: PlatformState): string {
  switch (state) {
    case "connected":
      return "";
    case "connecting":
      return "connecting…";
    case "offline":
      return "offline";
    case "ended":
      return "stream ended";
    case "error":
      return "error";
    default:
      return "";
  }
}

/* ──────────────── styles ──────────────── */

const frameStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "stretch",
};

const titleStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: "0.14em",
  color: "var(--ov-accent, #3ec0c7)",
};

const statusRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 10,
  padding: "8px 12px",
  borderBottom: "1px solid rgba(255,255,255,0.08)",
  fontSize: 11,
  color: "rgba(255,255,255,0.85)",
  flexShrink: 0,
  fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
};

const answerCardStyle: CSSProperties = {
  margin: "8px 10px 0",
  padding: "8px 10px",
  borderRadius: 8,
  background: "rgba(62,192,199,0.12)",
  border: "1px solid rgba(62,192,199,0.35)",
  flexShrink: 0,
  fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
};

const statusChipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
};
