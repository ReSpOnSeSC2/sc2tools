/**
 * "Overlay by sc2tools.com" credit — shown on streams by default, hidden
 * with a URL flag.
 *
 * Like the ``?theme=`` styling param, the choice travels in the Browser
 * Source URL itself: existing OBS sources need no re-auth and no server
 * change, and the overlay pages stay fully usable without a Clerk
 * session. A missing flag means "show" (the default); ``?credit=0``
 * hides it. Settings → Overlay remembers the streamer's choice on this
 * browser and bakes the flag into every URL it hands out.
 *
 * Example:
 *   appendOverlayCreditToUrl("/overlay/tok?theme=abc", false) // -> "/overlay/tok?theme=abc&credit=0"
 *   isOverlayCreditHidden("0")                                // -> true
 */

export const OVERLAY_CREDIT_PARAM = "credit";

/** The public text of the credit. */
export const OVERLAY_CREDIT_TEXT = "Overlay by sc2tools.com";

const HIDDEN_VALUES: ReadonlySet<string> = new Set(["0", "off", "false", "no", "hide", "hidden"]);

const STORAGE_KEY = "sc2tools.overlayCredit.v1";
const EVENT_NAME = "sc2tools:overlay-credit";

/** This page view's choice when localStorage refused to store it (private mode). */
let memoryPreference: boolean | null = null;

/**
 * Whether a raw ``?credit=`` value hides the credit. Anything unrecognised
 * (including a missing param) keeps it visible.
 */
export function isOverlayCreditHidden(value: string | ReadonlyArray<string> | null | undefined): boolean {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" && HIDDEN_VALUES.has(raw.trim().toLowerCase());
}

/**
 * Add ``credit=0`` to an overlay URL when the credit is switched off; a
 * visible credit leaves the URL untouched. Keeps any ``#fragment`` last.
 */
export function appendOverlayCreditToUrl(url: string, show: boolean): string {
  if (show) return url;
  const hashAt = url.indexOf("#");
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : url.slice(hashAt);
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}${OVERLAY_CREDIT_PARAM}=0${hash}`;
}

/** The streamer's saved choice on this browser (default: show). SSR-safe. */
export function readOverlayCreditPreference(): boolean {
  if (typeof window === "undefined") return true;
  if (memoryPreference !== null) return memoryPreference;
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

/** Save the choice and notify every Settings section showing overlay URLs. */
export function setOverlayCreditPreference(show: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, show ? "1" : "0");
    memoryPreference = null;
  } catch {
    // Storage blocked: keep the choice for this page view instead.
    memoryPreference = show;
  }
  window.dispatchEvent(new CustomEvent<boolean>(EVENT_NAME, { detail: show }));
}

/** Subscribe to preference changes (this tab and other tabs). */
export function subscribeOverlayCreditPreference(callback: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) callback();
  };
  window.addEventListener(EVENT_NAME, callback);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT_NAME, callback);
    window.removeEventListener("storage", onStorage);
  };
}
