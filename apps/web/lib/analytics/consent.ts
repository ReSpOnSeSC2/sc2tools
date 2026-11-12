"use client";

/**
 * Analytics consent — the single source of truth for whether Google
 * Analytics is allowed to run.
 *
 * Google Analytics never loads until the visitor explicitly accepts.
 * The choice is persisted
 * in ``localStorage`` (not a cookie — a cookie would itself be a
 * non-essential tracker before consent). Subscribers update as soon as the
 * choice changes, including when it was made in another tab.
 *
 * Three states:
 *   - ``"unset"``   — visitor hasn't chosen yet → show the banner, no GA.
 *   - ``"granted"`` — opted in → load GA.
 *   - ``"denied"``  — opted out → never load GA.
 */

import { analyticsPageState, isUntrackedPath } from "./pageLocation";

export type ConsentState = "unset" | "granted" | "denied";

const STORAGE_KEY = "sc2tools.analyticsConsent.v1";
export const COOKIE_SETTINGS_EVENT = "sc2tools:open-cookie-settings";
let memoryConsent: ConsentState = "unset";
let memoryOnly = false;
const consentSubscriptions = new Set<() => void>();

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

function storedConsent(storage: Storage): ConsentState {
  const value = storage.getItem(STORAGE_KEY);
  return value === "granted" || value === "denied" ? value : "unset";
}

/** Read the persisted consent state. SSR-safe (returns "unset"). */
export function readConsent(): ConsentState {
  if (typeof window === "undefined") return "unset";
  if (memoryOnly) return memoryConsent;
  try {
    return storedConsent(window.localStorage);
  } catch {
    // Keep only a choice this tab already observed or recorded.
    return memoryConsent;
  }
}

/**
 * Set Google's opt-out flag for this visitor on this page, and return
 * it (true = nothing may be sent).
 *
 * The flag blocks gtag.js's automatic hits as well as our own events, so
 * it is the one switch that silences an already loaded tracker. It is on
 * unless the visitor opted in AND the page may be measured: gtag.js
 * stays loaded after a client-side move onto an untracked surface (an
 * admin screen, someone's shared replays; see ``./pageLocation``), where
 * it would otherwise keep reporting clicks, form use and time spent.
 *
 * ``state`` defaults to the stored choice. Consent changes pass the
 * resolved choice so the tracker and the store stay in sync.
 */
export function syncAnalyticsOptOut(state: ConsentState = readConsent()): boolean {
  if (typeof window === "undefined") return true;
  const off = state !== "granted" || isUntrackedPath(window.location.pathname);
  window[`ga-disable-${GA_MEASUREMENT_ID}`] = off;
  return off;
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
  try {
    window.localStorage.setItem(STORAGE_KEY, state);
    memoryOnly = false;
  } catch {
    memoryOnly = true;
    // Apply the choice for this session even when storage is unavailable.
  }
  applyConsent(state);
}

function applyConsent(state: ConsentState): void {
  const off = syncAnalyticsOptOut(state);
  const granted = state === "granted";
  try {
    const gtag = window.gtag;
    // Navigation while opted out may have left the loaded tag on an old page.
    if (gtag && !off) gtag("set", analyticsPageState());
    gtag?.("consent", "update", { analytics_storage: granted ? "granted" : "denied" });
  } catch {
    // gtag threw: the stored choice still decides the next page load.
  }
  if (!granted) clearAnalyticsCookies();
  for (const listener of [...consentSubscriptions]) listener();
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

function onStorage(event: StorageEvent): void {
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  let state: ConsentState = "unset";
  try {
    if (event.storageArea !== window.localStorage) return;
    // Read the current value. A queued storage event can carry an older choice.
    state = storedConsent(event.storageArea);
  } catch {
    // Keep the tracker off when the stored choice cannot be read.
  }
  memoryConsent = state;
  memoryOnly = false;
  applyConsent(state);
}

/** Keep one storage listener for the shell and every consent subscriber. */
export function subscribeConsent(callback?: () => void): () => void {
  const listener = () => callback?.();
  consentSubscriptions.add(listener);
  if (consentSubscriptions.size === 1) window.addEventListener("storage", onStorage);
  return () => {
    if (consentSubscriptions.delete(listener) && consentSubscriptions.size === 0) {
      window.removeEventListener("storage", onStorage);
    }
  };
}
