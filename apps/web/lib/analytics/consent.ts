"use client";

/**
 * Analytics consent — the single source of truth for whether Google
 * Analytics is allowed to run.
 *
 * Google Analytics never loads until the visitor explicitly accepts.
 * The choice is persisted
 * in ``localStorage`` (not a cookie — a cookie would itself be a
 * non-essential tracker before consent) and broadcast on a window
 * event so the ``<GoogleAnalytics>`` component can react the instant
 * the visitor clicks Accept, without a page reload.
 *
 * Three states:
 *   - ``"unset"``   — visitor hasn't chosen yet → show the banner, no GA.
 *   - ``"granted"`` — opted in → load GA.
 *   - ``"denied"``  — opted out → never load GA.
 */

export type ConsentState = "unset" | "granted" | "denied";

const STORAGE_KEY = "sc2tools.analyticsConsent.v1";
const EVENT_NAME = "sc2tools:analytics-consent";
export const COOKIE_SETTINGS_EVENT = "sc2tools:open-cookie-settings";
let memoryConsent: ConsentState = "unset";
let memoryOnly = false;

/**
 * The GA4 Measurement ID (``G-XXXXXXXXXX``). Defaults to the production
 * property so analytics work out of the box on deploy; override per
 * environment via ``NEXT_PUBLIC_GA_MEASUREMENT_ID`` (e.g. set it to a
 * staging property, or blank to disable analytics entirely). Mirrors
 * how ``NEXT_PUBLIC_SITE_URL`` is defaulted in the root layout.
 */
export const GA_MEASUREMENT_ID =
  process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID ?? "G-Y90FRFK3D7";

/** Whether a measurement id is configured at all. */
export function isAnalyticsConfigured(): boolean {
  return GA_MEASUREMENT_ID.length > 0;
}

/** Read the persisted consent state. SSR-safe (returns "unset"). */
export function readConsent(): ConsentState {
  if (typeof window === "undefined") return "unset";
  if (memoryOnly) return memoryConsent;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === "granted" || v === "denied" ? v : "unset";
  } catch {
    // Private mode / disabled storage — treat as undecided so we never
    // silently track someone we couldn't record a choice for.
    return memoryConsent;
  }
}

/**
 * Persist a decision and notify subscribers. Passing ``"granted"`` or
 * ``"denied"`` records the choice; the banner and Settings → Misc call
 * this on click.
 *
 * gtag.js may already be running this visit (consent was granted, then
 * changed in Settings → Misc), so it gets the new choice too. Turning
 * analytics off also deletes the Google Analytics cookies, so it takes
 * effect without a reload.
 */
export function setConsent(state: Exclude<ConsentState, "unset">): void {
  memoryConsent = state;
  if (typeof window === "undefined") return;
  // gtag.js stays loaded after its Script component unmounts. Google's
  // opt-out flag blocks automatic hits as well as our own events.
  window[`ga-disable-${GA_MEASUREMENT_ID}`] = state !== "granted";
  try {
    window.localStorage.setItem(STORAGE_KEY, state);
    memoryOnly = false;
  } catch {
    memoryOnly = true;
    // Storage unavailable — still fire the event so GA reacts for this
    // session; it just won't be remembered on the next visit.
  }
  try {
    window.dispatchEvent(new CustomEvent<ConsentState>(EVENT_NAME, { detail: state }));
  } catch {
    // Older browsers without CustomEvent constructor — ignore; the
    // value is persisted and will be read on the next navigation.
  }
  try {
    window.gtag?.("consent", "update", { analytics_storage: state });
  } catch {
    // gtag threw: the stored choice still decides the next page load.
  }
  if (state === "denied") clearAnalyticsCookies();
}

/** Reopen the choice from the footer, policy or Settings. */
export function openCookieSettings(): void {
  window.dispatchEvent(new Event(COOKIE_SETTINGS_EVENT));
}

/** Stop an already loaded tracker and remove its cookies immediately. */
export function withdrawConsent(): void { setConsent("denied"); }

/** Google Analytics' own cookies: ``_ga``, ``_ga_<stream>``, ``_gid``, ``_gat*``. */
const GA_COOKIE_RE = /^_(?:ga(?:_.+)?|gid|gat.*)$/;

/**
 * Delete the Google Analytics cookies in this browser. GA writes them
 * on the widest domain it can (``.sc2tools.com``), so each is expired on
 * the host and every parent domain.
 */
export function clearAnalyticsCookies(): void {
  if (typeof document === "undefined") return;
  const names = document.cookie
    .split(";")
    .map((pair) => pair.split("=")[0].trim())
    .filter((name) => GA_COOKIE_RE.test(name));
  if (names.length === 0) return;
  const labels = window.location.hostname.split(".");
  const domains = [""];
  for (let i = 0; i < labels.length - 1; i += 1) {
    domains.push(`; domain=.${labels.slice(i).join(".")}`);
  }
  for (const name of names) {
    for (const domain of domains) {
      document.cookie = `${name}=; Max-Age=0; path=/${domain}`;
    }
  }
}

/**
 * Subscribe to consent changes. Returns an unsubscribe fn. Wired into
 * ``useSyncExternalStore`` so React components stay in lockstep with
 * the stored value, including cross-tab updates via the ``storage``
 * event.
 */
export function subscribeConsent(callback: () => void): () => void {
  const onCustom = () => callback();
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY || e.key === null) {
      window[`ga-disable-${GA_MEASUREMENT_ID}`] = readConsent() !== "granted";
      callback();
    }
  };
  window.addEventListener(EVENT_NAME, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT_NAME, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}
