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
 * The widget is fully self-driven: no agent, no game payloads. Config
 * comes from Settings → Overlay (stored server-side) and is re-read
 * every minute so settings changes land without touching OBS.
 *
 * Rendering rules for a clean stream look: bottom-anchored feed,
 * hidden overflow (no scrollbars in OBS), platform chip + colored
 * author + message, role glyphs for owner/mod/member. When every
 * configured platform is connected the status row hides itself.
 */

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { API_BASE } from "@/lib/clientApi";
import { fallbackColor } from "@/lib/multichat/feed";
import { useMultiChat } from "@/lib/multichat/useMultiChat";
import type {
  ChatBadge,
  ChatMessage,
  ChatPlatform,
  MultichatConfig,
  PlatformState,
} from "@/lib/multichat/types";

/** Re-read the streamer's platform config on this cadence. */
const CONFIG_REFRESH_MS = 60_000;

/** Show at most this many rows — older lines clip away silently. */
const VISIBLE_ROWS = 30;

const PLATFORM_META: Record<
  ChatPlatform,
  { label: string; short: string; color: string; fg: string }
> = {
  twitch: { label: "Twitch", short: "TW", color: "#9146FF", fg: "#fff" },
  kick: { label: "Kick", short: "KK", color: "#53FC18", fg: "#06230a" },
  youtube: { label: "YouTube", short: "YT", color: "#FF0000", fg: "#fff" },
  tiktok: { label: "TikTok", short: "TT", color: "#25F4EE", fg: "#062a2e" },
};

const BADGE_GLYPH: Record<ChatBadge, { glyph: string; title: string }> = {
  owner: { glyph: "♛", title: "Broadcaster" },
  moderator: { glyph: "⚔", title: "Moderator" },
  member: { glyph: "♥", title: "Member / Sub" },
  verified: { glyph: "✓", title: "Verified" },
  vip: { glyph: "◆", title: "VIP" },
};

const STATE_DOT: Record<PlatformState, string> = {
  off: "#6b7280",
  connecting: "#f5b942",
  connected: "#3ec07a",
  offline: "#6b7280",
  ended: "#6b7280",
  error: "#ff6b6b",
};

function useMultichatConfig(token: string): {
  config: MultichatConfig | null;
  loaded: boolean;
} {
  const [config, setConfig] = useState<MultichatConfig | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let lastJson = "";
    const load = async () => {
      try {
        const res = await fetch(
          `${API_BASE}/v1/multichat/${encodeURIComponent(token)}/config`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const body = (await res.json()) as { config?: MultichatConfig };
        const next = body?.config ?? {};
        const json = JSON.stringify(next);
        if (cancelled || json === lastJson) return;
        lastJson = json;
        // New object identity only on real change — useMultiChat
        // tears down / reconnects engines when config changes.
        setConfig(next);
      } catch {
        /* transient — next tick retries */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    };
    void load();
    const timer = setInterval(load, CONFIG_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [token]);

  return { config, loaded };
}

export function MultiChatWidget({ token }: { token: string }) {
  const { config, loaded } = useMultichatConfig(token);
  const { messages, statuses, active } = useMultiChat({
    apiBase: API_BASE,
    token,
    config,
  });

  const visible = useMemo(
    () => messages.slice(-VISIBLE_ROWS),
    [messages],
  );

  const configuredPlatforms = useMemo(() => {
    if (!config) return [] as ChatPlatform[];
    const out: ChatPlatform[] = [];
    if (config.twitch?.enabled && config.twitch.channel) out.push("twitch");
    if (config.kick?.enabled && config.kick.chatroomId) out.push("kick");
    if (config.youtube?.enabled && config.youtube.channel) out.push("youtube");
    if (config.tiktok?.enabled && config.tiktok.username) out.push("tiktok");
    return out;
  }, [config]);

  const allConnected =
    configuredPlatforms.length > 0 &&
    configuredPlatforms.every((p) => statuses[p]?.state === "connected");

  if (!loaded) return <div style={{ background: "transparent" }} />;

  if (loaded && config && configuredPlatforms.length === 0) {
    return (
      <div style={frameStyle}>
        <div style={shellStyle}>
          <div style={{ padding: "14px 16px" }}>
            <div style={titleStyle}>MULTI-CHAT</div>
            <div style={{ fontSize: 13, color: "rgba(255,255,255,0.85)", marginTop: 6, lineHeight: 1.5 }}>
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
    <div style={frameStyle}>
      <div style={{ ...shellStyle, display: "flex", flexDirection: "column", height: "100%" }}>
        {!allConnected && active ? (
          <div style={statusRowStyle}>
            {configuredPlatforms.map((p) => {
              const st = statuses[p]?.state ?? "connecting";
              return (
                <span key={p} style={statusChipStyle} title={statuses[p]?.detail}>
                  <span
                    style={{
                      display: "inline-block",
                      width: 7,
                      height: 7,
                      borderRadius: 99,
                      background: STATE_DOT[st],
                    }}
                  />
                  <span style={{ opacity: 0.9 }}>{PLATFORM_META[p].label}</span>
                  <span style={{ opacity: 0.55 }}>{statusLabel(st)}</span>
                </span>
              );
            })}
          </div>
        ) : null}
        <div style={feedStyle}>
          {visible.length === 0 ? (
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", padding: "6px 2px" }}>
              Connected — waiting for chat…
            </div>
          ) : (
            visible.map((m) => <MessageRow key={`${m.platform}:${m.id}`} message={m} />)
          )}
        </div>
      </div>
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

function MessageRow({ message }: { message: ChatMessage }) {
  const meta = PLATFORM_META[message.platform];
  const color = message.color || fallbackColor(message.user);
  return (
    <div style={rowStyle} className="mc-row">
      <span
        style={{
          ...chipStyle,
          background: meta.color,
          color: meta.fg,
        }}
        title={meta.label}
        aria-label={meta.label}
      >
        {meta.short}
      </span>
      {message.badges.map((b, i) => (
        <span
          key={`${b}${i}`}
          title={BADGE_GLYPH[b]?.title}
          style={{ color: "rgba(255,255,255,0.75)", fontSize: 11, flexShrink: 0 }}
        >
          {BADGE_GLYPH[b]?.glyph}
        </span>
      ))}
      <span style={{ color, fontWeight: 700, flexShrink: 0 }}>
        {message.user}
      </span>
      <span style={{ color: "rgba(255,255,255,0.55)", flexShrink: 0 }}>:</span>
      <span style={{ color: "var(--ov-text, rgba(255,255,255,0.92))", overflowWrap: "anywhere" }}>
        {message.text}
      </span>
      <style>{`
        .mc-row { animation: mcFadeIn 160ms ease-out; }
        @keyframes mcFadeIn {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: none; }
        }
        @media (prefers-reduced-motion: reduce) {
          .mc-row { animation: none; }
        }
      `}</style>
    </div>
  );
}

/* ──────────────── styles ──────────────── */

const frameStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "stretch",
  fontFamily: "var(--ov-font, Inter, ui-sans-serif, system-ui, sans-serif)",
};

const shellStyle: CSSProperties = {
  width: "100%",
  minWidth: 260,
  background:
    "var(--ov-panel-bg, linear-gradient(135deg, rgba(11,13,18,0.88) 0%, rgba(22,26,35,0.88) 100%))",
  border: "var(--ov-shell-border, 1px solid rgba(255,255,255,0.10))",
  borderRadius: "var(--ov-radius, 12px)",
  boxShadow: "0 6px 20px rgba(0,0,0,0.45)",
  overflow: "hidden",
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
};

const statusChipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
};

const feedStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  justifyContent: "flex-end",
  gap: 6,
  padding: "10px 12px",
  overflow: "hidden",
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 6,
  fontSize: "var(--ov-chat-font-size, 14px)",
  lineHeight: 1.35,
  flexWrap: "wrap",
};

const chipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 22,
  height: 15,
  borderRadius: 4,
  fontSize: 9,
  fontWeight: 800,
  letterSpacing: "0.04em",
  flexShrink: 0,
  transform: "translateY(-1px)",
};
