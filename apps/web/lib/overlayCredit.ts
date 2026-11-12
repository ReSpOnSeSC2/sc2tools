export const OVERLAY_CREDIT_PARAM = "credit";
export const OVERLAY_CREDIT_QR_PARAM = "creditQr";

/** The public text of the credit. */
export const OVERLAY_CREDIT_TEXT = "Overlay by sc2tools.com";
export const OVERLAY_CREDIT_URL = "https://sc2tools.com";

export function isOverlayCreditQrScene(scene: string): boolean {
  return scene === "starting-soon" || scene === "brb";
}

const HIDDEN_VALUES: ReadonlySet<string> = new Set(["0", "off", "false", "no", "hide", "hidden"]);

/** The older per-browser choice, read once to move it into the overlay profile. */
export const OVERLAY_CREDIT_STORAGE_KEY = "sc2tools.overlayCredit.v1";

/**
 * Whether an old Browser Source URL overrides the saved choice to hide credit.
 */
export function isOverlayCreditHidden(value: string | ReadonlyArray<string> | null | undefined): boolean {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" && HIDDEN_VALUES.has(raw.trim().toLowerCase());
}

/**
 * Carry the saved choice into a demo preview that has no live profile.
 */
export function appendOverlayCreditToUrl(url: string, show: boolean): string {
  if (show) return url;
  const hashAt = url.indexOf("#");
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : url.slice(hashAt);
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}${OVERLAY_CREDIT_PARAM}=0${hash}`;
}
