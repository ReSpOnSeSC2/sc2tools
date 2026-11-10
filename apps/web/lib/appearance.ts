/**
 * Account appearance and region preferences: text size, density, language
 * and region for dates and numbers, the 12/24-hour clock and the first day
 * of the week.
 *
 * The account (`/v1/me/preferences/appearance`) is the source of truth.
 * This browser keeps a copy in localStorage so the no-flash script in the
 * root layout can set text size and density before the first paint, and so
 * formats stay right offline or signed out. OBS sources (`/overlay`,
 * `/dock`) never take these attributes: a streamer's text size must not
 * resize a broadcast.
 *
 * Example:
 *   sanitizeAppearance({ textSize: "125", hourCycle: "h23" })
 *   // -> { textSize: "125", density: "comfortable", locale: "auto", hourCycle: "h23", weekStart: "auto" }
 */

export type TextSize = "100" | "112.5" | "125";
export type Density = "comfortable" | "compact";
export type HourCycle = "auto" | "h12" | "h23";
export type WeekStart = "auto" | "monday" | "sunday" | "saturday";

export interface AppearancePrefs {
  textSize: TextSize;
  density: Density;
  /** "auto" (this browser's language) or a BCP 47 tag such as "de-DE". */
  locale: string;
  hourCycle: HourCycle;
  weekStart: WeekStart;
}

export const DEFAULT_APPEARANCE: Readonly<AppearancePrefs> = Object.freeze({
  textSize: "100",
  density: "comfortable",
  locale: "auto",
  hourCycle: "auto",
  weekStart: "auto",
});

export const APPEARANCE_STORAGE_KEY = "sc2tools.appearance.v1";
export const TEXT_SIZE_ATTRIBUTE = "data-text-size";
export const DENSITY_ATTRIBUTE = "data-density";

export const TEXT_SIZES: ReadonlyArray<{ value: TextSize; label: string }> = [
  { value: "100", label: "Default" },
  { value: "112.5", label: "Large (112.5%)" },
  { value: "125", label: "Larger (125%)" },
];
export const DENSITIES: ReadonlyArray<{ value: Density; label: string }> = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
];
export const HOUR_CYCLES: ReadonlyArray<{ value: HourCycle; label: string }> = [
  { value: "auto", label: "Automatic (from language and region)" },
  { value: "h12", label: "12-hour (2:30 PM)" },
  { value: "h23", label: "24-hour (14:30)" },
];
export const WEEK_STARTS: ReadonlyArray<{ value: WeekStart; label: string }> = [
  { value: "auto", label: "Automatic (from language and region)" },
  { value: "monday", label: "Monday" },
  { value: "sunday", label: "Sunday" },
  { value: "saturday", label: "Saturday" },
];
/** Offered in Settings; the API accepts any valid language tag. */
export const LOCALE_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "en-US", label: "English (United States)" },
  { value: "en-GB", label: "English (United Kingdom)" },
  { value: "en-CA", label: "English (Canada)" },
  { value: "en-AU", label: "English (Australia)" },
  { value: "de-DE", label: "Deutsch (Deutschland)" },
  { value: "fr-FR", label: "Français (France)" },
  { value: "es-ES", label: "Español (España)" },
  { value: "es-MX", label: "Español (México)" },
  { value: "pt-BR", label: "Português (Brasil)" },
  { value: "it-IT", label: "Italiano (Italia)" },
  { value: "nl-NL", label: "Nederlands (Nederland)" },
  { value: "pl-PL", label: "Polski (Polska)" },
  { value: "sv-SE", label: "Svenska (Sverige)" },
  { value: "fi-FI", label: "Suomi (Suomi)" },
  { value: "nb-NO", label: "Norsk bokmål (Norge)" },
  { value: "da-DK", label: "Dansk (Danmark)" },
  { value: "cs-CZ", label: "Čeština (Česko)" },
  { value: "uk-UA", label: "Українська (Україна)" },
  { value: "ru-RU", label: "Русский (Россия)" },
  { value: "ko-KR", label: "한국어 (대한민국)" },
  { value: "zh-CN", label: "中文 (中国)" },
  { value: "zh-TW", label: "中文 (台灣)" },
  { value: "ja-JP", label: "日本語 (日本)" },
];

const TEXT_SIZE_SET: ReadonlySet<string> = new Set(TEXT_SIZES.map((item) => item.value));
const DENSITY_SET: ReadonlySet<string> = new Set(DENSITIES.map((item) => item.value));
const HOUR_CYCLE_SET: ReadonlySet<string> = new Set(HOUR_CYCLES.map((item) => item.value));
const WEEK_START_SET: ReadonlySet<string> = new Set(WEEK_STARTS.map((item) => item.value));
const MAX_LOCALE_LENGTH = 35;

/** A canonical BCP 47 tag, or null when the runtime rejects it. */
export function canonicalLocale(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw || raw.length > MAX_LOCALE_LENGTH) return null;
  try {
    const [tag] = Intl.getCanonicalLocales(raw);
    return tag && tag.length <= MAX_LOCALE_LENGTH ? tag : null;
  } catch {
    return null;
  }
}

/** Tolerant read: every unknown or malformed field falls back to its default. */
export function sanitizeAppearance(raw: unknown): AppearancePrefs {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const pick = <T extends string>(field: unknown, allowed: ReadonlySet<string>, fallback: T): T =>
    typeof field === "string" && allowed.has(field) ? (field as T) : fallback;
  const locale = value.locale === "auto" ? "auto" : canonicalLocale(value.locale) ?? "auto";
  return {
    textSize: pick(value.textSize, TEXT_SIZE_SET, DEFAULT_APPEARANCE.textSize),
    density: pick(value.density, DENSITY_SET, DEFAULT_APPEARANCE.density),
    locale,
    hourCycle: pick(value.hourCycle, HOUR_CYCLE_SET, DEFAULT_APPEARANCE.hourCycle),
    weekStart: pick(value.weekStart, WEEK_START_SET, DEFAULT_APPEARANCE.weekStart),
  };
}

export function sameAppearance(a: AppearancePrefs, b: AppearancePrefs): boolean {
  return a.textSize === b.textSize && a.density === b.density && a.locale === b.locale
    && a.hourCycle === b.hourCycle && a.weekStart === b.weekStart;
}

/** True for an account doc that has never been saved (`{}`). */
export function hasSavedAppearance(raw: unknown): boolean {
  return !!raw && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length > 0;
}

/** OBS browser sources keep the broadcast layout regardless of preferences. */
export function isAppearanceExemptPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return ["/overlay", "/dock"].some((root) => pathname === root || pathname.startsWith(`${root}/`));
}

const isBrowser = () => typeof window !== "undefined";
const listeners = new Set<() => void>();
/** This page's copy: read from storage once, then kept current. */
let current: AppearancePrefs | null = null;
let watching = false;

function readStorage(): AppearancePrefs {
  try {
    const raw = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
    return sanitizeAppearance(raw ? JSON.parse(raw) : null);
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

/** Another tab saved new preferences: follow them here too. */
function onStorage(event: StorageEvent) {
  if (event.key !== APPEARANCE_STORAGE_KEY && event.key !== null) return;
  current = readStorage();
  applyAppearanceAttributes(current);
  listeners.forEach((listener) => listener());
}

/**
 * This browser's copy (defaults on the server or when storage is
 * blocked). One stable object per change, for useSyncExternalStore.
 */
export function readStoredAppearance(): AppearancePrefs {
  if (!isBrowser()) return DEFAULT_APPEARANCE;
  if (!current) current = readStorage();
  if (!watching) { watching = true; window.addEventListener("storage", onStorage); }
  return current;
}

/** Put text size and density on <html> (removed on OBS surfaces). */
export function applyAppearanceAttributes(prefs: AppearancePrefs, pathname?: string | null, root?: HTMLElement): void {
  if (!isBrowser()) return;
  const element = root ?? document.documentElement;
  const exempt = isAppearanceExemptPath(pathname === undefined ? window.location.pathname : pathname);
  if (!exempt && prefs.textSize !== "100") element.setAttribute(TEXT_SIZE_ATTRIBUTE, prefs.textSize);
  else element.removeAttribute(TEXT_SIZE_ATTRIBUTE);
  if (!exempt && prefs.density === "compact") element.setAttribute(DENSITY_ATTRIBUTE, "compact");
  else element.removeAttribute(DENSITY_ATTRIBUTE);
}

/**
 * Keep this browser's copy, apply it and tell every subscriber (formats,
 * Settings). Called after a confirmed account save or account read.
 */
export function setStoredAppearance(next: AppearancePrefs): void {
  if (!isBrowser()) return;
  const prefs = sanitizeAppearance(next);
  // Storage may be blocked; the page keeps the choice either way.
  try { window.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(prefs)); } catch { /* This page view only. */ }
  if (current && sameAppearance(current, prefs)) { applyAppearanceAttributes(current); return; }
  current = prefs;
  applyAppearanceAttributes(prefs);
  listeners.forEach((listener) => listener());
}

/** Changes from this tab and other tabs. */
export function subscribeAppearance(listener: () => void): () => void {
  readStoredAppearance();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Tests only: forget the cached copy. */
export function resetAppearanceForTests(): void {
  current = null;
  listeners.clear();
  if (watching && isBrowser()) window.removeEventListener("storage", onStorage);
  watching = false;
}

/**
 * Before-paint bootstrap (root layout <head>): sets text size and density
 * from this browser's copy so a page never re-flows after load. Storage
 * failures leave the defaults. Skips OBS sources.
 */
export const NO_FLASH_APPEARANCE_SCRIPT = `(function(){try{var p=location.pathname;if(/^\\/(overlay|dock)(\\/|$)/.test(p))return;var v=JSON.parse(localStorage.getItem('${APPEARANCE_STORAGE_KEY}')||'null');if(!v||typeof v!=='object')return;var r=document.documentElement;if(v.textSize==='112.5'||v.textSize==='125')r.setAttribute('${TEXT_SIZE_ATTRIBUTE}',v.textSize);if(v.density==='compact')r.setAttribute('${DENSITY_ATTRIBUTE}','compact');}catch(e){}})();`;
