import rules from "./overlayProfileRules.json";
import { normalizeOverlayLayout, type OverlayLayout } from "./overlayLayout";
import { normalizeOverlayTheme, type OverlayTheme } from "./overlayTheme";
/**
 * Account-wide overlay choices Settings bakes into the URLs it hands out
 * (`credit=0`, `voice=1`). Missing means not chosen yet: the credit shows
 * and Ghost voice is off.
 */
export type OverlayProfileFlags = { credit?: boolean; ghostVoice?: boolean };
export type OverlayProfile = { v: 1; theme: OverlayTheme; widgetOptions: Record<string, { durationSec: number | null }>; layout?: OverlayLayout; layoutVertical?: OverlayLayout } & OverlayProfileFlags;
export const defaultOverlayProfile = (): OverlayProfile => ({ v: 1, theme: {}, widgetOptions: {} });

/** Socket and storage inputs remain bounded even when a token row is old. */
export function normalizeOverlayProfile(raw: unknown): OverlayProfile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaultOverlayProfile();
  const value = raw as Record<string, unknown>;
  if (value.v !== 1 || !value.widgetOptions || typeof value.widgetOptions !== "object" || Array.isArray(value.widgetOptions)) return defaultOverlayProfile();
  const options = Object.entries(value.widgetOptions).slice(0, 31), widgetOptions: OverlayProfile["widgetOptions"] = {};
  for (const [id, option] of options) {
    if (!Object.hasOwn(rules.widgetDurationMs, id) || rules.widgetDurationMs[id as keyof typeof rules.widgetDurationMs] === null || !option || typeof option !== "object") continue;
    const seconds = (option as { durationSec?: unknown }).durationSec;
    if (typeof seconds === "number" && rules.durationSeconds.includes(seconds)) widgetOptions[id] = { durationSec: seconds };
  }
  const layout = normalizeOverlayLayout(value.layout);
  const layoutVertical = normalizeOverlayLayout(value.layoutVertical);
  return { v: 1, theme: normalizeOverlayTheme(value.theme), widgetOptions,
    ...(layout ? { layout } : {}), ...(layoutVertical ? { layoutVertical } : {}), ...overlayProfileFlags(value) };
}

/** The chosen flags only; non-booleans are treated as not chosen. */
export function overlayProfileFlags(raw: Readonly<Record<string, unknown>> | OverlayProfile): OverlayProfileFlags {
  const value = raw as Record<string, unknown>;
  const flags: OverlayProfileFlags = {};
  if (typeof value.credit === "boolean") flags.credit = value.credit;
  if (typeof value.ghostVoice === "boolean") flags.ghostVoice = value.ghostVoice;
  return flags;
}

/** The saved appearance, display times and canvas layouts edited in one draft. */
export function withoutOverlayFlags(profile: OverlayProfile): OverlayProfile {
  const { v, theme, widgetOptions, layout, layoutVertical } = profile;
  return { v, theme, widgetOptions, ...(layout ? { layout } : {}), ...(layoutVertical ? { layoutVertical } : {}) };
}
