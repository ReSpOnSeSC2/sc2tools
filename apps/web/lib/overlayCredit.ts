/**
 * "Overlay by sc2tools.com" credit — shown on streams by default, hidden
 * with a URL flag.
 *
 * Like the ``?theme=`` styling param, the choice travels in the Browser
 * Source URL itself: existing OBS sources need no re-auth and no server
 * change, and the overlay pages stay fully usable without a Clerk
 * session. A missing flag means "show" (the default); ``?credit=0``
 * hides it. Settings → Overlay keeps the streamer's choice in the overlay
 * profile (it follows the account) and bakes the flag into every URL it
 * hands out.
 *
 * Example:
 *   appendOverlayCreditToUrl("/overlay/tok?theme=abc", false) // -> "/overlay/tok?theme=abc&credit=0"
 *   isOverlayCreditHidden("0")                                // -> true
 */

export const OVERLAY_CREDIT_PARAM = "credit";

/** The public text of the credit. */
export const OVERLAY_CREDIT_TEXT = "Overlay by sc2tools.com";

const HIDDEN_VALUES: ReadonlySet<string> = new Set(["0", "off", "false", "no", "hide", "hidden"]);

/** The older per-browser choice, read once to move it into the overlay profile. */
export const OVERLAY_CREDIT_STORAGE_KEY = "sc2tools.overlayCredit.v1";

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
