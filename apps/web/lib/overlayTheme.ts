/**
 * Overlay theming — the streamer-facing customization layer for the
 * OBS Browser Source widgets.
 *
 * The theme travels in the overlay URL itself
 * (``/overlay/<token>?theme=<base64url json>``) so an existing Browser
 * Source keeps working with zero re-auth and zero server changes: the
 * Settings page composes the URL, the overlay clients decode the param
 * once at mount and translate it into CSS custom properties that
 * ``WidgetShell`` consumes with the stock values as fallbacks.
 *
 * SECURITY: the ``?theme=`` string arrives on an UNAUTHENTICATED page
 * and must be treated as hostile. Everything here is strict-validated:
 *   - accent must be a literal ``#rgb`` / ``#rrggbb`` hex — nothing
 *     else survives ``normalizeOverlayTheme``.
 *   - numbers are clamped / snapped to a fixed allowlist.
 *   - enum tokens map through fixed lookup tables — user input is
 *     NEVER interpolated into a CSS string. ``themeToCssVars`` only
 *     emits values built from validated hex digits, clamped numbers,
 *     and hardcoded constants.
 *   - malformed input (junk base64, wrong version, oversized payloads)
 *     silently falls back to the default theme.
 */

export const OVERLAY_THEME_VERSION = 1;
export const OVERLAY_THEME_PARAM = "theme";

/** Allowed widget zoom factors — a fixed allowlist, not a free range. */
export const OVERLAY_THEME_SCALES = [0.8, 0.9, 1, 1.1, 1.25] as const;
export type OverlayThemeScale = (typeof OVERLAY_THEME_SCALES)[number];

export type OverlayThemeRadius = "sharp" | "rounded" | "pill";
export type OverlayThemeFont = "default" | "condensed" | "mono";
export type OverlayThemeStyle =
  | "command-grid"
  | "neon-arcade"
  | "arena-broadcast"
  | "void-nebula"
  | "terran-foundry";

export type OverlayTheme = {
  /** Accent bar / rim / glow colour — strict #rgb or #rrggbb hex. */
  accent?: string;
  /** Widget zoom factor. 1 (default) is omitted from the encoded form. */
  scale?: OverlayThemeScale;
  /** Panel background opacity, 0..1. Default 0.94. */
  opacity?: number;
  /** Corner treatment. Default "rounded" (12px). */
  radius?: OverlayThemeRadius;
  /** Type treatment. Default = the stock Inter stack. */
  font?: OverlayThemeFont;
  /** Structural frame treatment. Omitted = the stock classic shell. */
  style?: OverlayThemeStyle;
};

/** Stock accent used when the theme doesn't override it (WidgetShell's
 * "neutral" accent). Exposed for the Settings colour input's initial
 * value — the overlay itself falls back per-widget, not to this. */
export const DEFAULT_OVERLAY_ACCENT = "#7c8cff";
/** Stock panel-gradient alpha in WidgetShell. */
export const DEFAULT_OVERLAY_OPACITY = 0.94;
/**
 * Solid-colour approximation of the panel gradient midpoint
 * (rgba(11,13,18,.94) → rgba(22,26,35,.94)) used for contrast checks.
 */
export const OVERLAY_PANEL_REFERENCE_HEX = "#10141a";

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
/** Encoded themes beyond this length are rejected outright — a valid
 * payload is ~120 chars; anything bigger is garbage or an attack. */
const MAX_ENCODED_LENGTH = 512;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

const RADIUS_PX: Record<OverlayThemeRadius, string> = {
  sharp: "2px",
  rounded: "12px",
  pill: "26px",
};

// Broadcast-safe system stacks only — the overlay must not pull
// webfonts (OBS CEF renders offline / cold-cache constantly).
const FONT_STACKS: Record<OverlayThemeFont, string> = {
  default: "Inter, ui-sans-serif, system-ui, sans-serif",
  condensed:
    '"Arial Narrow", "Roboto Condensed", "Helvetica Neue Condensed", "Liberation Sans Narrow", sans-serif',
  mono: '"Cascadia Code", Consolas, "JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace',
};

export type OverlayThemePresetId =
  | "default"
  | "midnight"
  | "high-contrast"
  | "minimal-glass"
  | "retro-terminal"
  | "command-grid"
  | "neon-arcade"
  | "arena-broadcast"
  | "void-nebula"
  | "terran-foundry";

export type OverlayThemePreset = {
  id: OverlayThemePresetId;
  name: string;
  description: string;
  theme: OverlayTheme;
};

/**
 * Curated broadcast-safe presets. Every accent here must clear the
 * 3:1 contrast bar against ``OVERLAY_PANEL_REFERENCE_HEX`` — enforced
 * by a test so a future tweak can't ship an unreadable preset.
 */
export const OVERLAY_THEME_PRESETS: readonly OverlayThemePreset[] = [
  {
    id: "default",
    name: "Default",
    description: "The stock broadcast look — dark panels, per-widget accents.",
    theme: {},
  },
  {
    id: "midnight",
    name: "Midnight",
    description: "Ice-blue accent on near-opaque panels.",
    theme: { accent: "#8ab4ff", opacity: 0.98 },
  },
  {
    id: "high-contrast",
    name: "High contrast",
    description: "Solid panels, bold gold accent, larger type.",
    theme: { accent: "#ffd166", opacity: 1, radius: "sharp", scale: 1.1 },
  },
  {
    id: "minimal-glass",
    name: "Minimal glass",
    description: "Translucent panels, soft pill corners, smaller type.",
    theme: { accent: "#9adce6", opacity: 0.55, radius: "pill", scale: 0.9 },
  },
  {
    id: "retro-terminal",
    name: "Retro terminal",
    description: "Monospace type, phosphor-green accent, sharp corners.",
    theme: { accent: "#4af626", opacity: 0.9, radius: "sharp", font: "mono" },
  },
  {
    id: "command-grid",
    name: "Command grid",
    description: "Angular cyan HUD with a tactical scan grid and data rails.",
    theme: {
      accent: "#67e8f9",
      opacity: 0.96,
      radius: "sharp",
      font: "mono",
      style: "command-grid",
    },
  },
  {
    id: "neon-arcade",
    name: "Neon arcade",
    description: "Chunky magenta cabinet frame, scanlines and pixel corners.",
    theme: {
      accent: "#ff72d2",
      opacity: 1,
      radius: "sharp",
      font: "mono",
      style: "neon-arcade",
    },
  },
  {
    id: "arena-broadcast",
    name: "Arena broadcast",
    description: "Fast red lower-third geometry built for tournament streams.",
    theme: {
      accent: "#ff7676",
      opacity: 0.98,
      radius: "sharp",
      font: "condensed",
      style: "arena-broadcast",
    },
  },
  {
    id: "void-nebula",
    name: "Void nebula",
    description: "Deep-space violet glass with stars and a soft orbital bloom.",
    theme: {
      accent: "#c4a7ff",
      opacity: 0.9,
      radius: "pill",
      style: "void-nebula",
    },
  },
  {
    id: "terran-foundry",
    name: "Terran foundry",
    description: "Industrial amber plating, hazard rail and riveted texture.",
    theme: {
      accent: "#ffd166",
      opacity: 1,
      radius: "sharp",
      font: "condensed",
      style: "terran-foundry",
    },
  },
];

export const OVERLAY_THEME_STYLE_OPTIONS: readonly {
  value: "classic" | OverlayThemeStyle;
  label: string;
}[] = [
  { value: "classic", label: "Classic panel" },
  { value: "command-grid", label: "Command grid" },
  { value: "neon-arcade", label: "Neon arcade" },
  { value: "arena-broadcast", label: "Arena broadcast" },
  { value: "void-nebula", label: "Void nebula" },
  { value: "terran-foundry", label: "Terran foundry" },
];

const OVERLAY_THEME_STYLE_VALUES = new Set<OverlayThemeStyle>(
  OVERLAY_THEME_STYLE_OPTIONS
    .map((option) => option.value)
    .filter((value): value is OverlayThemeStyle => value !== "classic"),
);

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** Round to 2dp so encoded URLs stay tidy and float-compare is stable. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Strict-validate an untrusted value into an ``OverlayTheme``.
 *
 * - Unknown keys are dropped.
 * - Invalid values are dropped (never coerced from strings).
 * - Out-of-range opacity is clamped to [0, 1].
 * - Values equal to the defaults are dropped so ``{}`` is the one
 *   canonical spelling of "default theme" (keeps URLs clean and makes
 *   preset equality checks trivial).
 */
export function normalizeOverlayTheme(input: unknown): OverlayTheme {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {};
  }
  const raw = input as Record<string, unknown>;
  const theme: OverlayTheme = {};

  if (typeof raw.accent === "string" && HEX_COLOR_RE.test(raw.accent)) {
    theme.accent = raw.accent.toLowerCase();
  }
  if (
    typeof raw.scale === "number"
    && (OVERLAY_THEME_SCALES as readonly number[]).includes(raw.scale)
    && raw.scale !== 1
  ) {
    theme.scale = raw.scale as OverlayThemeScale;
  }
  if (typeof raw.opacity === "number" && Number.isFinite(raw.opacity)) {
    const clamped = round2(clamp01(raw.opacity));
    if (Math.abs(clamped - DEFAULT_OVERLAY_OPACITY) > 0.001) {
      theme.opacity = clamped;
    }
  }
  if (raw.radius === "sharp" || raw.radius === "pill") {
    theme.radius = raw.radius;
  }
  if (raw.font === "condensed" || raw.font === "mono") {
    theme.font = raw.font;
  }
  if (
    typeof raw.style === "string"
    && OVERLAY_THEME_STYLE_VALUES.has(raw.style as OverlayThemeStyle)
  ) {
    theme.style = raw.style as OverlayThemeStyle;
  }
  return theme;
}

export function isDefaultOverlayTheme(theme: OverlayTheme): boolean {
  return Object.keys(normalizeOverlayTheme(theme)).length === 0;
}

/**
 * Encode a theme as versioned base64url JSON for the ``?theme=`` param.
 * The input is normalized first so hostile/garbage fields can never be
 * smuggled through the Settings page into a URL.
 */
export function encodeOverlayTheme(theme: OverlayTheme): string {
  const clean = normalizeOverlayTheme(theme);
  const json = JSON.stringify({ v: OVERLAY_THEME_VERSION, ...clean });
  // Payload is ASCII by construction (validated hex + fixed enums), so
  // btoa is safe. Convert to the URL-safe alphabet, strip padding.
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decode an untrusted ``?theme=`` value. ANY failure — junk base64,
 * invalid JSON, wrong version, oversized payload, wrong charset —
 * silently returns the default theme ``{}``. The overlay must never
 * paint an error because a viewer tampered with a URL.
 */
export function decodeOverlayTheme(
  raw: string | null | undefined,
): OverlayTheme {
  if (!raw || typeof raw !== "string") return {};
  if (raw.length > MAX_ENCODED_LENGTH) return {};
  if (!BASE64URL_RE.test(raw)) return {};
  let json: string;
  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const padded =
      b64.length % 4 === 0 ? b64 : b64 + "=".repeat(4 - (b64.length % 4));
    json = atob(padded);
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {};
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || Array.isArray(parsed)
    || (parsed as { v?: unknown }).v !== OVERLAY_THEME_VERSION
  ) {
    return {};
  }
  return normalizeOverlayTheme(parsed);
}

/**
 * Append the ``?theme=`` param to an overlay URL. Default themes append
 * nothing so stock URLs stay byte-identical to what streamers already
 * have in OBS.
 */
export function appendOverlayThemeToUrl(
  url: string,
  theme: OverlayTheme,
): string {
  if (isDefaultOverlayTheme(theme)) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}${OVERLAY_THEME_PARAM}=${encodeOverlayTheme(theme)}`;
}

/** Expand #rgb to #rrggbb (native <input type=color> requires 6-digit). */
export function expandHex(hex: string): string {
  if (!HEX_COLOR_RE.test(hex)) return hex;
  if (hex.length === 7) return hex.toLowerCase();
  const [r, g, b] = hex.slice(1);
  return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
}

export function isValidThemeHex(value: string): boolean {
  return HEX_COLOR_RE.test(value);
}

function parseHex(hex: string): { r: number; g: number; b: number } | null {
  if (!HEX_COLOR_RE.test(hex)) return null;
  const full = expandHex(hex);
  return {
    r: parseInt(full.slice(1, 3), 16),
    g: parseInt(full.slice(3, 5), 16),
    b: parseInt(full.slice(5, 7), 16),
  };
}

function hexToRgba(hex: string, alpha: number): string {
  const rgb = parseHex(hex);
  // Callers only pass validated hex; belt-and-braces fall back to the
  // stock neutral halo rather than emitting a broken value.
  if (!rgb) return "rgba(124,140,255,0.18)";
  return `rgba(${rgb.r},${rgb.g},${rgb.b},${round2(clamp01(alpha))})`;
}

/** The stock WidgetShell panel gradient with a caller-chosen alpha. */
export function overlayPanelGradient(alpha: number): string {
  const a = round2(clamp01(alpha));
  return `linear-gradient(135deg, rgba(11,13,18,${a}) 0%, rgba(22,26,35,${a}) 100%)`;
}

type OverlayStyleVisual = {
  panel: (alpha: number) => string;
  vars: Readonly<Record<string, string>>;
};

function scaledAlpha(alpha: number, factor: number): number {
  return round2(clamp01(alpha) * factor);
}

/**
 * Structural style recipes. These are the only gradients, clip paths,
 * textures and shadows a theme URL can select; the URL carries just an
 * allowlisted enum, never attacker-controlled CSS.
 */
const OVERLAY_STYLE_VISUALS: Record<OverlayThemeStyle, OverlayStyleVisual> = {
  "command-grid": {
    panel: (a) =>
      `linear-gradient(145deg, rgba(3,15,24,${a}) 0%, rgba(8,29,42,${a}) 58%, rgba(3,12,20,${a}) 100%)`,
    vars: {
      "--ov-shell-border": "1px solid rgba(103,232,249,0.52)",
      "--ov-shell-shadow":
        "0 10px 28px rgba(0,0,0,0.62), inset 0 0 0 1px rgba(103,232,249,0.12)",
      "--ov-clip":
        "polygon(0 0, calc(100% - 20px) 0, 100% 20px, 100% 100%, 16px 100%, 0 calc(100% - 16px))",
      "--ov-panel-flow": "column",
      "--ov-accent-size": "4px",
      "--ov-accent-track":
        "linear-gradient(90deg, var(--ov-accent, #67e8f9) 0 58%, transparent 58% 64%, var(--ov-accent, #67e8f9) 64% 78%, transparent 78%)",
      "--ov-texture":
        "linear-gradient(rgba(103,232,249,0.09) 1px, transparent 1px), linear-gradient(90deg, rgba(103,232,249,0.09) 1px, transparent 1px), repeating-linear-gradient(0deg, transparent 0 4px, rgba(255,255,255,0.018) 4px 5px)",
      "--ov-texture-size": "18px 18px, 18px 18px, auto",
      "--ov-texture-opacity": "0.72",
      "--ov-ornament-bg":
        "linear-gradient(135deg, transparent 0 42%, var(--ov-accent, #67e8f9) 43% 56%, transparent 57%)",
      "--ov-ornament-width": "48px",
      "--ov-ornament-height": "48px",
      "--ov-ornament-opacity": "0.65",
      "--ov-header-tracking": "0.055em",
    },
  },
  "neon-arcade": {
    panel: (a) =>
      `linear-gradient(180deg, rgba(31,7,42,${a}) 0%, rgba(8,4,19,${a}) 100%)`,
    vars: {
      "--ov-shell-border": "3px solid var(--ov-accent, #ff72d2)",
      "--ov-shell-shadow":
        "6px 6px 0 #07030d, 10px 10px 0 var(--ov-accent, #ff72d2), inset 0 0 0 2px rgba(109,240,255,0.3)",
      "--ov-clip":
        "polygon(10px 0, calc(100% - 10px) 0, calc(100% - 10px) 5px, 100% 5px, 100% calc(100% - 10px), calc(100% - 5px) calc(100% - 10px), calc(100% - 5px) 100%, 10px 100%, 10px calc(100% - 5px), 0 calc(100% - 5px), 0 10px, 5px 10px, 5px 5px, 10px 5px)",
      "--ov-panel-flow": "column",
      "--ov-accent-size": "8px",
      "--ov-accent-track":
        "repeating-linear-gradient(90deg, var(--ov-accent, #ff72d2) 0 18px, #6df0ff 18px 27px, #ffe66d 27px 34px, transparent 34px 40px)",
      "--ov-texture":
        "repeating-linear-gradient(0deg, rgba(255,255,255,0.055) 0 1px, transparent 1px 4px), radial-gradient(circle at 92% 18%, rgba(109,240,255,0.22) 0 2px, transparent 3px), radial-gradient(circle at 87% 18%, rgba(255,230,109,0.24) 0 2px, transparent 3px)",
      "--ov-texture-opacity": "0.8",
      "--ov-ornament-bg":
        "repeating-linear-gradient(90deg, #6df0ff 0 6px, transparent 6px 10px)",
      "--ov-ornament-width": "42px",
      "--ov-ornament-height": "5px",
      "--ov-ornament-inset": "12px 14px auto auto",
      "--ov-ornament-opacity": "0.9",
      "--ov-header-tracking": "0.08em",
    },
  },
  "arena-broadcast": {
    panel: (a) =>
      `linear-gradient(105deg, rgba(16,19,26,${a}) 0%, rgba(22,25,34,${a}) 72%, rgba(62,14,21,${a}) 100%)`,
    vars: {
      "--ov-shell-border": "1px solid rgba(255,255,255,0.24)",
      "--ov-shell-shadow": "0 12px 24px rgba(0,0,0,0.58)",
      "--ov-clip":
        "polygon(0 0, 100% 0, 100% calc(100% - 13px), calc(100% - 13px) 100%, 0 100%)",
      "--ov-panel-flow": "column",
      "--ov-accent-size": "5px",
      "--ov-accent-track":
        "linear-gradient(90deg, var(--ov-accent, #ff7676) 0 34%, rgba(255,255,255,0.9) 34% 36%, transparent 36% 100%)",
      "--ov-texture":
        "linear-gradient(118deg, transparent 0 78%, rgba(255,255,255,0.055) 78% 82%, transparent 82%), linear-gradient(118deg, transparent 0 86%, rgba(255,118,118,0.16) 86% 92%, transparent 92%)",
      "--ov-texture-opacity": "1",
      "--ov-ornament-bg": "var(--ov-accent, #ff7676)",
      "--ov-ornament-width": "58px",
      "--ov-ornament-height": "9px",
      "--ov-ornament-inset": "auto 0 0 auto",
      "--ov-ornament-clip": "polygon(14% 0, 100% 0, 100% 100%, 0 100%)",
      "--ov-ornament-opacity": "0.95",
      "--ov-padding": "12px 18px 14px",
      "--ov-header-tracking": "0.035em",
    },
  },
  "void-nebula": {
    panel: (a) =>
      `radial-gradient(circle at 86% 12%, rgba(159,107,255,${scaledAlpha(a, 0.38)}) 0%, transparent 42%), radial-gradient(circle at 5% 88%, rgba(65,214,255,${scaledAlpha(a, 0.2)}) 0%, transparent 38%), linear-gradient(135deg, rgba(13,8,31,${a}) 0%, rgba(24,14,52,${a}) 55%, rgba(8,13,29,${a}) 100%)`,
    vars: {
      "--ov-shell-border": "1px solid rgba(196,167,255,0.48)",
      "--ov-shell-shadow":
        "0 10px 34px rgba(3,2,15,0.7), 0 0 26px rgba(159,107,255,0.24), inset 0 0 20px rgba(103,232,249,0.07)",
      "--ov-accent-size": "7px",
      "--ov-accent-track":
        "linear-gradient(180deg, #67e8f9 0%, var(--ov-accent, #c4a7ff) 46%, #ff78c9 100%)",
      "--ov-texture":
        "radial-gradient(circle at 13% 24%, rgba(255,255,255,0.8) 0 1px, transparent 1.5px), radial-gradient(circle at 76% 72%, rgba(255,255,255,0.65) 0 1px, transparent 1.5px), radial-gradient(circle at 42% 18%, rgba(103,232,249,0.75) 0 1px, transparent 1.5px), radial-gradient(circle at 90% 46%, rgba(196,167,255,0.8) 0 1px, transparent 1.5px)",
      "--ov-texture-size": "89px 71px, 113px 97px, 131px 83px, 149px 109px",
      "--ov-texture-opacity": "0.72",
      "--ov-ornament-bg":
        "radial-gradient(circle, rgba(196,167,255,0.82) 0 8%, rgba(196,167,255,0.2) 28%, transparent 66%)",
      "--ov-ornament-width": "92px",
      "--ov-ornament-height": "92px",
      "--ov-ornament-inset": "-30px -24px auto auto",
      "--ov-ornament-opacity": "0.72",
      "--ov-padding": "16px 20px",
    },
  },
  "terran-foundry": {
    panel: (a) =>
      `linear-gradient(145deg, rgba(27,24,19,${a}) 0%, rgba(48,39,26,${a}) 48%, rgba(20,19,18,${a}) 100%)`,
    vars: {
      "--ov-shell-border": "2px solid rgba(255,209,102,0.58)",
      "--ov-shell-shadow":
        "0 9px 0 rgba(5,5,5,0.76), 0 15px 30px rgba(0,0,0,0.55), inset 0 0 0 2px rgba(0,0,0,0.44)",
      "--ov-clip":
        "polygon(12px 0, 100% 0, 100% calc(100% - 12px), calc(100% - 12px) 100%, 0 100%, 0 12px)",
      "--ov-accent-size": "12px",
      "--ov-accent-track":
        "repeating-linear-gradient(135deg, var(--ov-accent, #ffd166) 0 8px, #17130d 8px 16px)",
      "--ov-texture":
        "radial-gradient(circle at 8px 8px, rgba(255,209,102,0.4) 0 1.5px, rgba(0,0,0,0.7) 2px 3px, transparent 3.5px), repeating-linear-gradient(135deg, transparent 0 24px, rgba(255,255,255,0.025) 24px 25px)",
      "--ov-texture-size": "56px 56px, auto",
      "--ov-texture-opacity": "0.85",
      "--ov-ornament-bg":
        "linear-gradient(90deg, var(--ov-accent, #ffd166), transparent)",
      "--ov-ornament-width": "76px",
      "--ov-ornament-height": "3px",
      "--ov-ornament-inset": "10px 12px auto auto",
      "--ov-ornament-opacity": "0.85",
      "--ov-header-tracking": "0.045em",
    },
  },
};

function structuralStyleVars(
  style: OverlayThemeStyle,
  opacity: number,
): Record<string, string> {
  const visual = OVERLAY_STYLE_VISUALS[style];
  return { ...visual.vars, "--ov-panel-bg": visual.panel(opacity) };
}

/**
 * Translate a theme into the CSS custom properties WidgetShell reads
 * (each with a stock-value fallback, so an empty object = stock look):
 *
 *   --ov-accent    accent bar colour (overrides per-widget accents)
 *   --ov-halo      glow colour derived from the accent
 *   --ov-rim       1px rim colour derived from the accent
 *   --ov-panel-bg  panel gradient with the themed opacity
 *   --ov-radius    corner radius
 *   --ov-scale     zoom factor
 *   --ov-font      font stack
 *   --ov-* shell geometry/texture vars from a fixed structural style
 *
 * Returns a plain record suitable for spreading into a React ``style``
 * object. Only tokens present in the (normalized) theme emit a var, so
 * the default theme costs nothing at runtime.
 */
export function themeToCssVars(theme: OverlayTheme): Record<string, string> {
  const t = normalizeOverlayTheme(theme);
  const vars: Record<string, string> = t.style
    ? structuralStyleVars(
        t.style,
        t.opacity ?? DEFAULT_OVERLAY_OPACITY,
      )
    : {};
  if (t.accent) {
    vars["--ov-accent"] = t.accent;
    vars["--ov-halo"] = hexToRgba(t.accent, 0.22);
    vars["--ov-rim"] = hexToRgba(t.accent, 0.12);
  }
  if (t.opacity !== undefined && !t.style) {
    vars["--ov-panel-bg"] = overlayPanelGradient(t.opacity);
  }
  if (t.radius) {
    vars["--ov-radius"] = RADIUS_PX[t.radius];
  }
  if (t.scale) {
    vars["--ov-scale"] = String(t.scale);
  }
  if (t.font) {
    vars["--ov-font"] = FONT_STACKS[t.font];
  }
  return vars;
}

/**
 * WCAG relative luminance of a hex colour (0 = black, 1 = white).
 * Returns null for anything that isn't strict #rgb/#rrggbb.
 */
export function relativeLuminance(hex: string): number | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const lin = (channel: number) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
}

/**
 * WCAG contrast ratio between two hex colours (1..21), or null when
 * either colour fails strict validation.
 */
export function contrastRatio(hexA: string, hexB: string): number | null {
  const la = relativeLuminance(hexA);
  const lb = relativeLuminance(hexB);
  if (la === null || lb === null) return null;
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Contrast of an accent against the widget panel background. The
 * Settings preview shows a warning chip when this drops below 3:1
 * (the WCAG bar for large text / graphical objects — right for the
 * accent bar + glow, which are chrome, not body text).
 */
export function accentContrastOnPanel(accent: string): number | null {
  return contrastRatio(accent, OVERLAY_PANEL_REFERENCE_HEX);
}
