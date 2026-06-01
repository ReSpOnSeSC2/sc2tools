"use client";

/**
 * Analytics consent — the single source of truth for whether Google
 * Analytics is allowed to run.
 *
 * We take the GDPR-correct opt-in posture: nothing analytics-related
 * loads until the visitor explicitly accepts. The choice is persisted
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
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === "granted" || v === "denied" ? v : "unset";
  } catch {
    // Private mode / disabled storage — treat as undecided so we never
    // silently track someone we couldn't record a choice for.
    return "unset";
  }
}

/**
 * Persist a decision and notify subscribers. Passing ``"granted"`` or
 * ``"denied"`` records the choice; the banner calls this on click.
 */
export function setConsent(state: Exclude<ConsentState, "unset">): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, state);
  } catch {
    // Storage unavailable — still fire the event so GA reacts for this
    // session; it just won't be remembered on the next visit.
  }
  try {
    window.dispatchEvent(new CustomEvent<ConsentState>(EVENT_NAME, { detail: state }));
  } catch {
    // Older browsers without CustomEvent constructor — ignore; the
    // value is persisted and will be read on the next navigation.
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
    if (e.key === STORAGE_KEY) callback();
  };
  window.addEventListener(EVENT_NAME, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT_NAME, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}
