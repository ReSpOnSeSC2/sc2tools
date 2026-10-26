/** Saved appearance and its resolved light/dark palette. */
export type Theme = "light" | "dark";
export type ThemeMode = Theme | "system";
export const THEME_STORAGE_KEY = "sc2tools.theme";
export const THEME_ATTRIBUTE = "data-theme";
export const THEME_MODE_ATTRIBUTE = "data-theme-mode";
export const THEME_COLORS = { light: "#f4f6fa", dark: "#06090e" } as const;
const MEDIA = "(prefers-color-scheme: light)";
const isBrowser = () => typeof window !== "undefined";
const valid = (value: unknown): value is ThemeMode => value === "light" || value === "dark" || value === "system";
const listeners = new Set<() => void>();
let media: MediaQueryList | null = null;

export function readStoredTheme(): ThemeMode | null {
  if (!isBrowser()) return null;
  try { const value = localStorage.getItem(THEME_STORAGE_KEY); return valid(value) ? value : null; } catch { return null; }
}
export function getThemeMode(): ThemeMode {
  if (!isBrowser()) return "system";
  const attr = document.documentElement.getAttribute(THEME_MODE_ATTRIBUTE);
  return valid(attr) ? attr : readStoredTheme() ?? "system";
}
export function systemPreference(): Theme {
  try { return isBrowser() && window.matchMedia(MEDIA).matches ? "light" : "dark"; } catch { return "dark"; }
}
export function getTheme(): Theme {
  if (!isBrowser()) return "dark";
  const attr = document.documentElement.getAttribute(THEME_ATTRIBUTE);
  if (attr === "light" || attr === "dark") return attr;
  const mode = getThemeMode();
  return mode === "system" ? systemPreference() : mode;
}
function osChanged() {
  if (getThemeMode() !== "system") return;
  apply("system"); notifyLegacy("system");
}
function watchOS(mode: ThemeMode) {
  if (media && (mode !== "system" || !listeners.size)) {
    if (media.removeEventListener) media.removeEventListener("change", osChanged); else media.removeListener(osChanged);
    media = null;
  }
  if (!media && mode === "system" && listeners.size) {
    try {
      media = window.matchMedia(MEDIA);
      if (media.addEventListener) media.addEventListener("change", osChanged); else media.addListener(osChanged);
    } catch { media = null; }
  }
}
function apply(mode: ThemeMode) {
  watchOS(mode);
  const theme = mode === "system" ? (media ? media.matches ? "light" : "dark" : systemPreference()) : mode;
  const root = document.documentElement;
  root.setAttribute(THEME_MODE_ATTRIBUTE, mode); root.setAttribute(THEME_ATTRIBUTE, theme);
  root.style.colorScheme = theme;
  if (!document.querySelector('meta[name="theme-color"]')) {
    const meta = document.createElement("meta"); meta.name = "theme-color"; document.head.append(meta);
  }
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach(meta => {
    meta.content = THEME_COLORS[theme]; meta.removeAttribute("media");
  });
  listeners.forEach(listener => listener());
}
function onStorage(event: StorageEvent) {
  if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
  apply(valid(event.newValue) ? event.newValue : "system");
}
/** Existing resolved-theme consumers such as AuthShell also observe this. */
function notifyLegacy(mode: ThemeMode) {
  try { window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY, newValue: mode })); }
  catch { window.dispatchEvent(Object.assign(new Event("storage"), { key: THEME_STORAGE_KEY, newValue: mode })); }
}
/** One storage listener and, only in System, one OS listener for all controls. */
export function subscribeTheme(listener: () => void): () => void {
  const first = !listeners.size; listeners.add(listener);
  if (first) { window.addEventListener("storage", onStorage); apply(getThemeMode()); }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { window.removeEventListener("storage", onStorage); watchOS("dark"); }
  };
}
export function setTheme(mode: ThemeMode): void {
  if (!isBrowser() || !valid(mode)) return;
  apply(mode);
  try { localStorage.setItem(THEME_STORAGE_KEY, mode); } catch { /* Keep this tab's choice when storage is blocked. */ }
  notifyLegacy(mode);
}
/** One click chooses the opposite resolved palette and leaves System mode. */
export function toggleTheme(): Theme {
  const next = getTheme() === "light" ? "dark" : "light";
  setTheme(next); return next;
}

/** Storage may fail independently of matchMedia; still follow the OS then. */
export const NO_FLASH_THEME_SCRIPT = `(function(){var mode='system';try{var saved=localStorage.getItem('${THEME_STORAGE_KEY}');if(saved==='light'||saved==='dark'||saved==='system')mode=saved;}catch(e){}var theme=mode;if(mode==='system'){try{theme=matchMedia('${MEDIA}').matches?'light':'dark';}catch(e){theme='dark';}}var root=document.documentElement;root.setAttribute('${THEME_MODE_ATTRIBUTE}',mode);root.setAttribute('${THEME_ATTRIBUTE}',theme);root.style.colorScheme=theme;document.querySelectorAll('meta[name="theme-color"]').forEach(function(meta){meta.content=theme==='light'?'${THEME_COLORS.light}':'${THEME_COLORS.dark}';meta.removeAttribute('media');});})();`;
