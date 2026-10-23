/**
 * Settings deep links to a section (`/settings?tab=overlay#platform-connections`):
 * once the tab is on screen, scroll the section the `#anchor` names into
 * view and highlight it briefly so the eye lands on it.
 *
 * Tab panels render on demand and most sections wait for their data, so
 * the element may not exist yet: watch the page until it appears, for a
 * few seconds at most. If the player starts scrolling, clicking or
 * typing first, leave the page where they put it.
 */

/** How long to wait for a section that is still loading. */
export const SECTION_WAIT_MS = 8000;
/** How long the highlight stays on (the fade-out is in globals.css). */
export const SECTION_FLASH_MS = 1800;
/** The attribute globals.css styles: "on", then "fading" for the fade-out. */
export const SECTION_FLASH_ATTR = "data-section-flash";

const FADE_MS = 400;
const INTERRUPT_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/**
 * The element id an anchor names, or null for an empty one.
 *
 * Example:
 *   sectionIdFromHash("#platform-connections"); // -> "platform-connections"
 */
export function sectionIdFromHash(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function flash(el: HTMLElement): () => void {
  el.setAttribute(SECTION_FLASH_ATTR, "on");
  const fade = window.setTimeout(() => el.setAttribute(SECTION_FLASH_ATTR, "fading"), SECTION_FLASH_MS);
  const clear = window.setTimeout(() => el.removeAttribute(SECTION_FLASH_ATTR), SECTION_FLASH_MS + FADE_MS);
  return () => {
    window.clearTimeout(fade);
    window.clearTimeout(clear);
    el.removeAttribute(SECTION_FLASH_ATTR);
  };
}

/**
 * Scroll to and highlight the section `hash` names. Returns a cleanup
 * that stops waiting and removes the highlight (call it when the tab
 * changes or the component unmounts).
 *
 * Example:
 *   useEffect(() => revealSectionAnchor(window.location.hash), [tab]);
 */
export function revealSectionAnchor(hash: string): () => void {
  const id = sectionIdFromHash(hash);
  if (!id || typeof document === "undefined") return () => {};

  let observer: MutationObserver | null = null;
  let timeout: number | undefined;
  let stopFlash: (() => void) | null = null;

  const stopWaiting = () => {
    observer?.disconnect();
    observer = null;
    window.clearTimeout(timeout);
    for (const type of INTERRUPT_EVENTS) window.removeEventListener(type, stopWaiting, true);
  };

  const reveal = (el: HTMLElement) => {
    stopWaiting();
    stopFlash = flash(el);
    el.scrollIntoView?.({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  };

  const found = document.getElementById(id);
  if (found) {
    reveal(found);
  } else {
    observer = new MutationObserver(() => {
      const el = document.getElementById(id);
      if (el) reveal(el);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    timeout = window.setTimeout(stopWaiting, SECTION_WAIT_MS);
    for (const type of INTERRUPT_EVENTS) {
      window.addEventListener(type, stopWaiting, { capture: true, passive: true });
    }
  }

  return () => {
    stopWaiting();
    stopFlash?.();
  };
}
