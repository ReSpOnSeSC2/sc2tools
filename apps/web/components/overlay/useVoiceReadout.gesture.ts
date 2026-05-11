/**
 * Browser-autoplay-gesture persistence for the voice readout.
 *
 * Web Speech requires a user gesture (click / keydown / touch) before
 * it'll play. Without persistence the streamer would have to right-
 * click → Interact → click the overlay every time OBS reloads the
 * Browser Source — exactly the paper cut the legacy SPA dodged with
 * a one-time ``attachGestureListeners``. We persist the unlock to
 * localStorage (primary) and sessionStorage (fallback, for private-
 * mode browsers that block localStorage).
 *
 * Functions are pure and side-effect-isolated to ``window.*Storage``
 * so the hook stays state-free at this boundary.
 */

const UNLOCK_STORAGE_KEY = "sc2tools.voiceUnlocked";

/**
 * Read the persisted unlock flag, preferring localStorage so the
 * unlock survives OBS Browser Source refreshes / restarts. Falls back
 * to sessionStorage when localStorage is blocked.
 */
export function readPersistedUnlock(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.localStorage?.getItem(UNLOCK_STORAGE_KEY) === "1") return true;
  } catch {
    // localStorage blocked — try sessionStorage next.
  }
  try {
    return window.sessionStorage?.getItem(UNLOCK_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Stamp the unlock flag. Best-effort across both storage tiers — if
 * both are blocked (private mode + storage denied), in-memory React
 * state still works for the current tab's lifetime.
 */
export function persistUnlock(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage?.setItem(UNLOCK_STORAGE_KEY, "1");
    return;
  } catch {
    // localStorage blocked — fall back to sessionStorage.
  }
  try {
    window.sessionStorage?.setItem(UNLOCK_STORAGE_KEY, "1");
  } catch {
    // Both blocked. Tab-lifetime React state will still hold the unlock.
  }
}

/**
 * Drop the persisted unlock — called when the browser revokes speech
 * with ``not-allowed``, so the gesture-request flow restarts on the
 * next payload instead of silently failing forever.
 */
export function clearPersistedUnlock(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage?.removeItem(UNLOCK_STORAGE_KEY);
  } catch {
    /* best-effort */
  }
  try {
    window.sessionStorage?.removeItem(UNLOCK_STORAGE_KEY);
  } catch {
    /* best-effort */
  }
}
