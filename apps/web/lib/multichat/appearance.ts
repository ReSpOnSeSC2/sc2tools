// Multichat appearance — the streamer-tunable look of the chat
// overlay. Pure module: types, defaults, a strict sanitizer (the wire
// value is untrusted — it round-trips through the preferences blob),
// CSS derivation, and the message-visibility filter (TTL / commands /
// bot & user blocklist / cap).
//
// The SAME appearance object drives the OBS widget and the Settings
// live preview, so what you see in Settings is what OBS renders.
// Stored under `appearance` in /v1/me/preferences/multichat and
// re-read by the widget every minute — tweaks land in OBS without
// touching the Browser Source.

import type { ChatMessage } from "./types";

/* ──────────────── option enums ──────────────── */

export const FONT_FAMILIES = [
  "inter",
  "system",
  "rounded",
  "mono",
  "serif",
] as const;
export type ChatFontFamily = (typeof FONT_FAMILIES)[number];

/** Self-contained stacks only — an OBS source must never fetch a font. */
export const FONT_STACKS: Record<ChatFontFamily, string> = {
  inter: "var(--ov-font, Inter, ui-sans-serif, system-ui, sans-serif)",
  system: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
  rounded:
    "'Nunito', 'Varela Round', 'Comfortaa', ui-rounded, 'Arial Rounded MT Bold', ui-sans-serif, system-ui, sans-serif",
  mono: "ui-monospace, 'Cascadia Code', 'JetBrains Mono', Consolas, 'Courier New', monospace",
  serif: "ui-serif, Georgia, 'Times New Roman', serif",
};

export const FONT_WEIGHTS = ["normal", "medium", "bold"] as const;
export type ChatFontWeight = (typeof FONT_WEIGHTS)[number];

export const DENSITIES = ["compact", "cozy", "comfortable"] as const;
export type ChatDensity = (typeof DENSITIES)[number];

export const LAYOUTS = ["rows", "two-line", "bubbles"] as const;
export type ChatLayout = (typeof LAYOUTS)[number];

export const NEWEST_AT = ["bottom", "top"] as const;
export type ChatNewestAt = (typeof NEWEST_AT)[number];

export const ALIGNMENTS = ["left", "right"] as const;
export type ChatAlign = (typeof ALIGNMENTS)[number];

export const USERNAME_STYLES = ["platform", "uniform", "white"] as const;
export type ChatUsernameStyle = (typeof USERNAME_STYLES)[number];

export const ENTRY_ANIMATIONS = [
  "fade",
  "slide-up",
  "slide-left",
  "pop",
  "none",
] as const;
export type ChatEntryAnimation = (typeof ENTRY_ANIMATIONS)[number];

/* ──────────────── the appearance contract ──────────────── */

export interface ChatAppearance {
  /** Message text size in px. */
  fontSize: number;
  fontFamily: ChatFontFamily;
  /** Weight of the message text (usernames are always bold). */
  fontWeight: ChatFontWeight;
  /** Soft dark halo behind text — for low/zero background opacity. */
  textShadow: boolean;
  /** Row spacing + line-height preset. */
  density: ChatDensity;
  /** rows = single line · two-line = name above text · bubbles = card per message. */
  layout: ChatLayout;
  /** Where new messages appear. */
  newestAt: ChatNewestAt;
  /** Horizontal alignment of rows/bubbles. */
  align: ChatAlign;
  /** platform = author colours · uniform = overlay accent · white = plain. */
  usernameStyle: ChatUsernameStyle;
  showPlatformChips: boolean;
  showBadges: boolean;
  showTimestamps: boolean;
  /** Rows kept on screen. */
  maxVisible: number;
  /** Seconds a message stays before fading out. 0 = keep forever. */
  messageTtlSec: number;
  entryAnimation: ChatEntryAnimation;
  /** Panel background colour (hex) + opacity (0–100). */
  bgColor: string;
  bgOpacity: number;
  cornerRadius: number;
  panelBorder: boolean;
  /** Hide "!command" lines. */
  hideCommands: boolean;
  /** Hide well-known chat bots (Nightbot, StreamElements, …). */
  hideBots: boolean;
  /** Comma-separated additional usernames to hide. */
  blockedUsers: string;
}

export const DEFAULT_APPEARANCE: ChatAppearance = {
  fontSize: 14,
  fontFamily: "inter",
  fontWeight: "normal",
  textShadow: false,
  density: "cozy",
  layout: "rows",
  newestAt: "bottom",
  align: "left",
  usernameStyle: "platform",
  showPlatformChips: true,
  showBadges: true,
  showTimestamps: false,
  maxVisible: 30,
  messageTtlSec: 0,
  entryAnimation: "fade",
  bgColor: "#11141b",
  bgOpacity: 88,
  cornerRadius: 12,
  panelBorder: true,
  hideCommands: false,
  hideBots: false,
  blockedUsers: "",
};

/** Clamp bounds — mirrored by the API's sanitizer. */
export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 32;
export const MAX_VISIBLE_MIN = 5;
export const MAX_VISIBLE_MAX = 50;
export const TTL_MAX_SEC = 600;
export const RADIUS_MAX = 24;
export const BLOCKED_USERS_MAX_CHARS = 500;

/**
 * Chat bots hidden by the "hide bots" toggle. Matched case-insensitively
 * against the author name across all four platforms.
 */
export const KNOWN_BOTS = [
  "nightbot",
  "streamelements",
  "streamlabs",
  "moobot",
  "fossabot",
  "wizebot",
  "botrix",
  "sery_bot",
  "soundalerts",
  "kofistreambot",
] as const;

/* ──────────────── sanitizer ──────────────── */

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

function pick<T extends string>(
  v: unknown,
  allowed: readonly T[],
  dflt: T,
): T {
  return allowed.includes(v as T) ? (v as T) : dflt;
}

function bool(v: unknown, dflt: boolean): boolean {
  return typeof v === "boolean" ? v : dflt;
}

/**
 * Strict-sanitize an untrusted appearance blob into a complete,
 * render-safe ChatAppearance. Unknown fields drop; bad values fall
 * back to defaults; numbers clamp to the documented bounds.
 */
export function sanitizeAppearance(
  raw: unknown,
): ChatAppearance {
  const a = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const d = DEFAULT_APPEARANCE;
  const bgColor =
    typeof a.bgColor === "string" && /^#[0-9a-fA-F]{6}$/.test(a.bgColor)
      ? a.bgColor.toLowerCase()
      : d.bgColor;
  return {
    fontSize: clampInt(a.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX, d.fontSize),
    fontFamily: pick(a.fontFamily, FONT_FAMILIES, d.fontFamily),
    fontWeight: pick(a.fontWeight, FONT_WEIGHTS, d.fontWeight),
    textShadow: bool(a.textShadow, d.textShadow),
    density: pick(a.density, DENSITIES, d.density),
    layout: pick(a.layout, LAYOUTS, d.layout),
    newestAt: pick(a.newestAt, NEWEST_AT, d.newestAt),
    align: pick(a.align, ALIGNMENTS, d.align),
    usernameStyle: pick(a.usernameStyle, USERNAME_STYLES, d.usernameStyle),
    showPlatformChips: bool(a.showPlatformChips, d.showPlatformChips),
    showBadges: bool(a.showBadges, d.showBadges),
    showTimestamps: bool(a.showTimestamps, d.showTimestamps),
    maxVisible: clampInt(a.maxVisible, MAX_VISIBLE_MIN, MAX_VISIBLE_MAX, d.maxVisible),
    messageTtlSec: clampInt(a.messageTtlSec, 0, TTL_MAX_SEC, d.messageTtlSec),
    entryAnimation: pick(a.entryAnimation, ENTRY_ANIMATIONS, d.entryAnimation),
    bgColor,
    bgOpacity: clampInt(a.bgOpacity, 0, 100, d.bgOpacity),
    cornerRadius: clampInt(a.cornerRadius, 0, RADIUS_MAX, d.cornerRadius),
    panelBorder: bool(a.panelBorder, d.panelBorder),
    hideCommands: bool(a.hideCommands, d.hideCommands),
    hideBots: bool(a.hideBots, d.hideBots),
    blockedUsers:
      typeof a.blockedUsers === "string"
        ? a.blockedUsers.slice(0, BLOCKED_USERS_MAX_CHARS)
        : d.blockedUsers,
  };
}

/* ──────────────── derived styling ──────────────── */

export interface AppearanceStyles {
  fontFamily: string;
  fontWeight: number;
  lineHeight: number;
  /** Vertical gap between rows, px. */
  rowGap: number;
  /** rgba() background for the panel. */
  panelBackground: string;
  textShadow: string | undefined;
}

const DENSITY_PRESETS: Record<ChatDensity, { gap: number; lineHeight: number }> = {
  compact: { gap: 2, lineHeight: 1.25 },
  cozy: { gap: 6, lineHeight: 1.35 },
  comfortable: { gap: 10, lineHeight: 1.5 },
};

const WEIGHT_VALUES: Record<ChatFontWeight, number> = {
  normal: 400,
  medium: 500,
  bold: 700,
};

/** hex "#rrggbb" + opacity 0-100 → "rgba(r,g,b,a)". */
export function hexToRgba(hex: string, opacityPct: number): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  const value = m ? m[1] : "11141b";
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  const a = Math.min(100, Math.max(0, opacityPct)) / 100;
  return `rgba(${r},${g},${b},${a})`;
}

export function appearanceStyles(a: ChatAppearance): AppearanceStyles {
  const density = DENSITY_PRESETS[a.density];
  return {
    fontFamily: FONT_STACKS[a.fontFamily],
    fontWeight: WEIGHT_VALUES[a.fontWeight],
    lineHeight: density.lineHeight,
    rowGap: density.gap,
    panelBackground: hexToRgba(a.bgColor, a.bgOpacity),
    textShadow: a.textShadow
      ? "0 1px 2px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.7)"
      : undefined,
  };
}

/* ──────────────── visibility filter ──────────────── */

/** Parse the blockedUsers CSV once per appearance change. */
export function blockedUserSet(a: ChatAppearance): Set<string> {
  const out = new Set<string>();
  for (const part of a.blockedUsers.split(",")) {
    const name = part.trim().toLowerCase().replace(/^@/, "");
    if (name) out.add(name);
  }
  if (a.hideBots) {
    for (const bot of KNOWN_BOTS) out.add(bot);
  }
  return out;
}

/**
 * Apply the appearance's content rules to the feed: blocklist,
 * command-hiding, TTL expiry, then the visible-row cap. Pure —
 * `nowMs` is injected so tests are deterministic. Order is preserved
 * (oldest → newest); the renderer decides which end is "new".
 */
export function visibleMessages(
  messages: ReadonlyArray<ChatMessage>,
  a: ChatAppearance,
  nowMs: number,
): ChatMessage[] {
  const blocked = blockedUserSet(a);
  const ttlMs = a.messageTtlSec > 0 ? a.messageTtlSec * 1000 : null;
  const kept: ChatMessage[] = [];
  for (const m of messages) {
    if (ttlMs !== null && nowMs - m.atMs > ttlMs) continue;
    if (a.hideCommands && m.text.startsWith("!")) continue;
    if (blocked.size > 0 && blocked.has(m.user.trim().toLowerCase())) continue;
    kept.push(m);
  }
  return kept.length > a.maxVisible ? kept.slice(kept.length - a.maxVisible) : kept;
}
