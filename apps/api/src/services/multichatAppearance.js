"use strict";

/**
 * Server-side sanitizer for the multichat widget's appearance blob —
 * the exact JS mirror of apps/web/lib/multichat/appearance.ts
 * (sanitizeAppearance). The blob is written by the Clerk-authed
 * settings page but SERVED on a token-authed route, so the API
 * whitelist-shapes it before it ever leaves: unknown keys drop, enums
 * fall back to defaults, numbers clamp to the documented bounds, and
 * free-text (blockedUsers) is length-capped.
 *
 * Keep the bounds and defaults in lockstep with the web module — the
 * jest suite pins the contract from this side, the vitest suite from
 * the client side.
 */

const FONT_FAMILIES = ["inter", "system", "rounded", "mono", "serif"];
const FONT_WEIGHTS = ["normal", "medium", "bold"];
const DENSITIES = ["compact", "cozy", "comfortable"];
const LAYOUTS = ["rows", "two-line", "bubbles"];
const NEWEST_AT = ["bottom", "top"];
const ALIGNMENTS = ["left", "right"];
const USERNAME_STYLES = ["platform", "uniform", "white"];
const ENTRY_ANIMATIONS = ["fade", "slide-up", "slide-left", "pop", "none"];

const FONT_SIZE_MIN = 10;
const FONT_SIZE_MAX = 32;
const MAX_VISIBLE_MIN = 5;
const MAX_VISIBLE_MAX = 50;
const TTL_MAX_SEC = 600;
const RADIUS_MAX = 24;
const BLOCKED_USERS_MAX_CHARS = 500;

const DEFAULT_APPEARANCE = Object.freeze({
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
  emoteImages: true,
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
});

/**
 * @param {unknown} v
 * @param {number} lo
 * @param {number} hi
 * @param {number} dflt
 */
function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/**
 * @param {unknown} v
 * @param {string[]} allowed
 * @param {string} dflt
 */
function pick(v, allowed, dflt) {
  return allowed.includes(/** @type {string} */ (v)) ? /** @type {string} */ (v) : dflt;
}

/** @param {unknown} v @param {boolean} dflt */
function bool(v, dflt) {
  return typeof v === "boolean" ? v : dflt;
}

/**
 * @param {unknown} raw
 * @returns {Record<string, string | number | boolean>}
 */
function sanitizeChatAppearance(raw) {
  const a = /** @type {Record<string, unknown>} */ (
    raw && typeof raw === "object" ? raw : {}
  );
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
    emoteImages: bool(a.emoteImages, d.emoteImages),
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

/* ──────────────── TTS ──────────────── */

const TTS_PLATFORMS = ["twitch", "kick", "youtube", "tiktok"];
const TTS_RATE_MIN = 0.5;
const TTS_RATE_MAX = 2;
const TTS_MAX_CHARS_MIN = 50;
const TTS_MAX_CHARS_MAX = 500;

const DEFAULT_TTS = Object.freeze({
  enabled: false,
  platforms: Object.freeze([]),
  readNames: true,
  voiceName: "",
  rate: 1,
  volume: 100,
  maxChars: 200,
  skipCommands: true,
});

/**
 * Mirror of apps/web/lib/multichat/tts.ts sanitizeTtsConfig — same
 * rationale as sanitizeChatAppearance above: the blob is served on a
 * token-authed route and must be whitelist-shaped first.
 *
 * @param {unknown} raw
 * @returns {Record<string, any>}
 */
function sanitizeChatTts(raw) {
  const t = /** @type {Record<string, unknown>} */ (
    raw && typeof raw === "object" ? raw : {}
  );
  const d = DEFAULT_TTS;
  const rate = Number(t.rate);
  const volume = Number(t.volume);
  const maxChars = Number(t.maxChars);
  const platforms = Array.isArray(t.platforms)
    ? [...new Set(t.platforms.filter((p) => TTS_PLATFORMS.includes(/** @type {string} */ (p))))]
    : [...d.platforms];
  return {
    enabled: typeof t.enabled === "boolean" ? t.enabled : d.enabled,
    platforms,
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

/* ──────────────── sounds (message ding + event alerts) ──────────────── */

/**
 * Whitelisted synthesized-effect ids — mirror of
 * apps/web/lib/multichat/soundEffects.ts SOUND_EFFECT_IDS.
 */
const SOUND_EFFECT_IDS = [
  "ding",
  "pop",
  "doorbell",
  "sparkle",
  "laser",
  "power-up",
  "riser",
  "boom",
  "coin",
  "victory",
  "airhorn",
  "bass-drop",
  "sad-trombone",
  "boing",
  "slide-whistle",
  "drumroll",
];

/** Event kinds — mirror of apps/web/lib/multichat/events.ts. */
const CHAT_EVENT_KINDS = [
  "sub",
  "resub",
  "giftsub",
  "raid",
  "member",
  "superchat",
  "gift",
  "follow",
];

/** Per-kind defaults — mirror of sound.ts DEFAULT_EVENT_SOUNDS. */
const DEFAULT_EVENT_SOUNDS = Object.freeze({
  sub: "victory",
  resub: "victory",
  giftsub: "airhorn",
  raid: "airhorn",
  member: "sparkle",
  superchat: "coin",
  gift: "coin",
  follow: "pop",
});

const DEFAULT_SOUND = Object.freeze({
  enabled: false,
  volume: 60,
  messageSound: "ding",
  eventSoundsEnabled: false,
  eventVolume: 70,
});

/**
 * @param {unknown} raw
 * @param {number} fallback
 */
function clampVolume(raw, fallback) {
  const v = Number(raw);
  return Number.isFinite(v)
    ? Math.min(100, Math.max(0, Math.round(v)))
    : fallback;
}

/**
 * Mirror of apps/web/lib/multichat/sound.ts sanitizeSoundConfig.
 * Always emits every event kind ("none" silences one) so the widget's
 * config-section JSON diffing sees a stable shape.
 *
 * @param {unknown} raw
 */
function sanitizeChatSound(raw) {
  const s = /** @type {Record<string, unknown>} */ (
    raw && typeof raw === "object" ? raw : {}
  );
  const rawEvents = /** @type {Record<string, unknown>} */ (
    s.eventSounds && typeof s.eventSounds === "object" ? s.eventSounds : {}
  );
  /** @type {Record<string, string>} */
  const eventSounds = {};
  for (const kind of CHAT_EVENT_KINDS) {
    const v = rawEvents[kind];
    eventSounds[kind] =
      v === "none" || SOUND_EFFECT_IDS.includes(/** @type {string} */ (v))
        ? /** @type {string} */ (v)
        : DEFAULT_EVENT_SOUNDS[/** @type {keyof typeof DEFAULT_EVENT_SOUNDS} */ (kind)];
  }
  return {
    enabled: typeof s.enabled === "boolean" ? s.enabled : DEFAULT_SOUND.enabled,
    volume: clampVolume(s.volume, DEFAULT_SOUND.volume),
    messageSound: SOUND_EFFECT_IDS.includes(/** @type {string} */ (s.messageSound))
      ? /** @type {string} */ (s.messageSound)
      : DEFAULT_SOUND.messageSound,
    eventSoundsEnabled:
      typeof s.eventSoundsEnabled === "boolean"
        ? s.eventSoundsEnabled
        : DEFAULT_SOUND.eventSoundsEnabled,
    eventVolume: clampVolume(s.eventVolume, DEFAULT_SOUND.eventVolume),
    eventSounds,
  };
}

module.exports = {
  sanitizeChatAppearance,
  sanitizeChatTts,
  sanitizeChatSound,
  DEFAULT_APPEARANCE,
  DEFAULT_TTS,
  DEFAULT_SOUND,
  SOUND_EFFECT_IDS,
  DEFAULT_EVENT_SOUNDS,
};
