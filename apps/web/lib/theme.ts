/**
 * Theme resolver — light/dark with localStorage persistence and
 * cross-tab sync. The synchronous bootstrap script lives in
 * app/layout.tsx and must stay in sync with this module's storage
 * key + value space.
 */

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "sc2tools.theme";
export const THEME_ATTRIBUTE = "data-theme";

const isBrowser = (): boolean => typeof window !== "undefined";

/** Resolve the active theme from <html data-theme>, falling back to system pref. */
export function getTheme(): Theme {
  if (!isBrowser()) return "dark";
  const attr = document.documentElement.getAttribute(THEME_ATTRIBUTE);
  if (attr === "light" || attr === "dark") return attr;
  const stored = readStoredTheme();
  if (stored) return stored;
  return systemPreference();
}

/** Read the persisted theme choice, returning null if none/invalid. */
export function readStoredTheme(): Theme | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return raw === "light" || raw === "dark" ? raw : null;
  } catch {
    return null;
  }
}

/** OS-level prefers-color-scheme: returns "light" if set, otherwise "dark". */
export function systemPreference(): Theme {
  if (!isBrowser()) return "dark";
  try {
    return window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  } catch {
    return "dark";
  }
}

/**
 * Apply a theme: set the html attribute, persist to storage, and
 * notify other tabs via the storage event (browsers don't fire
 * 'storage' for the same tab that wrote, so we also dispatch a
 * synthetic event to keep listeners in sync).
 */
export function setTheme(next: Theme): void {
  if (!isBrowser()) return;
  document.documentElement.setAttribute(THEME_ATTRIBUTE, next);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    /* storage unavailable (private mode, quota) — attribute is enough */
  }
  try {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: THEME_STORAGE_KEY,
        newValue: next,
      }),
    );
  } catch {
    /* StorageEvent constructor not supported — listeners poll on focus */
  }
}

/** Flip light↔dark and persist. Returns the new theme. */
export function toggleTheme(): Theme {
  const next: Theme = getTheme() === "light" ? "dark" : "light";
  setTheme(next);
  return next;
}
