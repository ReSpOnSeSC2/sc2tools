"use client";

/**
 * MultiChatMessageList — the presentational core of the multichat
 * overlay. Renders an appearance-driven list of chat messages; used
 * by BOTH the OBS widget (MultiChatWidget) and the Settings live
 * preview (SettingsMultiChatAppearance), so the preview is pixel-
 * honest about what OBS will show.
 *
 * Layout modes:
 *   rows      — single line: chip · badges · name · text
 *   two-line  — name line above the message text (Twitch-app style)
 *   bubbles   — one rounded card per message
 *
 * All styling derives from the sanitized ChatAppearance; entry
 * animations are injected once per list (not per row) and respect
 * prefers-reduced-motion.
 */

import { useMemo, type CSSProperties } from "react";
import { fallbackColor } from "@/lib/multichat/feed";
import {
  appearanceStyles,
  type ChatAppearance,
} from "@/lib/multichat/appearance";
import type {
  ChatBadge,
  ChatMessage,
  ChatPlatform,
} from "@/lib/multichat/types";

export const PLATFORM_META: Record<
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

const ANIMATION_CSS: Record<string, string> = {
  fade: "from { opacity: 0; } to { opacity: 1; }",
  "slide-up": "from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; }",
  "slide-left": "from { opacity: 0; transform: translateX(14px); } to { opacity: 1; transform: none; }",
  pop: "from { opacity: 0; transform: scale(0.85); } to { opacity: 1; transform: scale(1); }",
};

function timeLabel(atMs: number): string {
  const d = new Date(atMs);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function MultiChatMessageList({
  messages,
  appearance,
  emptyText,
  translations,
}: {
  /** Oldest → newest; `newestAt` decides which end renders "new". */
  messages: ReadonlyArray<ChatMessage>;
  appearance: ChatAppearance;
  emptyText?: string;
  /** Optional (platform:id) → translated text overlay (useTranslation). */
  translations?: Record<string, string>;
}) {
  const s = useMemo(() => appearanceStyles(appearance), [appearance]);
  const ordered = useMemo(
    () =>
      appearance.newestAt === "top" ? [...messages].reverse() : messages,
    [messages, appearance.newestAt],
  );

  const listStyle: CSSProperties = {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    justifyContent: appearance.newestAt === "top" ? "flex-start" : "flex-end",
    alignItems: appearance.align === "right" ? "flex-end" : "stretch",
    gap: s.rowGap,
    padding: "10px 12px",
    overflow: "hidden",
    fontFamily: s.fontFamily,
    fontSize: appearance.fontSize,
    lineHeight: s.lineHeight,
  };

  const animation = ANIMATION_CSS[appearance.entryAnimation];

  return (
    <div style={listStyle} data-testid="mc-list">
      {animation ? (
        <style>{`
          .mc-msg { animation: mcEntry 180ms ease-out; }
          @keyframes mcEntry { ${animation} }
          @media (prefers-reduced-motion: reduce) { .mc-msg { animation: none; } }
        `}</style>
      ) : null}
      {ordered.length === 0 && emptyText ? (
        <div
          style={{
            fontSize: Math.max(11, appearance.fontSize - 2),
            color: "rgba(255,255,255,0.45)",
            padding: "6px 2px",
            textShadow: s.textShadow,
          }}
        >
          {emptyText}
        </div>
      ) : (
        ordered.map((m) => (
          <MessageRow
            key={`${m.platform}:${m.id}`}
            message={m}
            appearance={appearance}
            textShadow={s.textShadow}
            fontWeight={s.fontWeight}
            translated={translations?.[`${m.platform}:${m.id}`]}
          />
        ))
      )}
    </div>
  );
}

function MessageRow({
  message,
  appearance,
  textShadow,
  fontWeight,
  translated,
}: {
  message: ChatMessage;
  appearance: ChatAppearance;
  textShadow: string | undefined;
  fontWeight: number;
  /** Translated text — rendered in place of the original, marked 🌐. */
  translated?: string;
}) {
  const meta = PLATFORM_META[message.platform];
  const nameColor =
    appearance.usernameStyle === "white"
      ? "rgba(255,255,255,0.95)"
      : appearance.usernameStyle === "uniform"
        ? "var(--ov-accent, #3ec0c7)"
        : message.color || fallbackColor(message.user);

  const chip = appearance.showPlatformChips ? (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: Math.round(appearance.fontSize * 1.55),
        height: Math.round(appearance.fontSize * 1.05),
        borderRadius: 4,
        fontSize: Math.max(8, Math.round(appearance.fontSize * 0.62)),
        fontWeight: 800,
        letterSpacing: "0.04em",
        flexShrink: 0,
        background: meta.color,
        color: meta.fg,
        transform: "translateY(-1px)",
      }}
      title={meta.label}
      aria-label={meta.label}
    >
      {meta.short}
    </span>
  ) : null;

  const badges = appearance.showBadges
    ? message.badges.map((b, i) => (
        <span
          key={`${b}${i}`}
          title={BADGE_GLYPH[b]?.title}
          style={{
            color: "rgba(255,255,255,0.75)",
            fontSize: Math.max(9, appearance.fontSize - 3),
            flexShrink: 0,
            textShadow,
          }}
        >
          {BADGE_GLYPH[b]?.glyph}
        </span>
      ))
    : null;

  const timestamp = appearance.showTimestamps ? (
    <span
      style={{
        color: "rgba(255,255,255,0.4)",
        fontSize: Math.max(9, appearance.fontSize - 4),
        flexShrink: 0,
        fontVariantNumeric: "tabular-nums",
        textShadow,
      }}
    >
      {timeLabel(message.atMs)}
    </span>
  ) : null;

  const name = (
    <span style={{ color: nameColor, fontWeight: 700, textShadow }}>
      {message.user}
    </span>
  );

  const text = (
    <span
      style={{
        color: "var(--ov-text, rgba(255,255,255,0.92))",
        overflowWrap: "anywhere",
        fontWeight,
        textShadow,
      }}
      title={translated ? message.text : undefined}
    >
      {translated ? (
        <>
          <span aria-hidden style={{ opacity: 0.6, marginRight: 3 }}>🌐</span>
          {translated}
        </>
      ) : (
        message.text
      )}
    </span>
  );

  const alignSelf =
    appearance.align === "right" ? ("flex-end" as const) : undefined;

  if (appearance.layout === "rows") {
    return (
      <div
        className="mc-msg"
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 6,
          flexWrap: "wrap",
          alignSelf,
          justifyContent: appearance.align === "right" ? "flex-end" : undefined,
        }}
      >
        {timestamp}
        {chip}
        {badges}
        {name}
        <span style={{ color: "rgba(255,255,255,0.55)", textShadow }}>:</span>
        {text}
      </div>
    );
  }

  const twoLine = (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 6,
          flexWrap: "wrap",
          justifyContent: appearance.align === "right" ? "flex-end" : undefined,
        }}
      >
        {timestamp}
        {chip}
        {badges}
        {name}
      </div>
      <div
        style={{
          marginTop: 2,
          textAlign: appearance.align === "right" ? "right" : "left",
        }}
      >
        {text}
      </div>
    </div>
  );

  if (appearance.layout === "bubbles") {
    return (
      <div
        className="mc-msg"
        style={{
          alignSelf: alignSelf ?? "flex-start",
          maxWidth: "92%",
          background: "rgba(255,255,255,0.07)",
          border: "1px solid rgba(255,255,255,0.09)",
          borderRadius: 10,
          padding: "6px 10px",
        }}
      >
        {twoLine}
      </div>
    );
  }

  // two-line
  return (
    <div className="mc-msg" style={{ alignSelf }}>
      {twoLine}
    </div>
  );
}
