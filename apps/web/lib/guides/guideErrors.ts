/**
 * Errors the guide pages throw on purpose.
 */

/**
 * Thrown by an incrementally static (ISR) guide page while the guide API
 * is unavailable, instead of rendering a "temporarily unavailable" page.
 * A thrown render is never cached: Next keeps serving the page's last good
 * render (a failed background revalidation leaves it in place) and, when
 * there is none (never rendered, or just purged on demand), answers an
 * uncached 500 — Next 15 serves its plain 500 page for a failed ISR render,
 * not the segment's error.tsx — so an outage can never be frozen into the
 * 6 h ISR window, and crawlers see a temporary 5xx rather than a noindex 200.
 *
 * Example: `if (result.kind === "unavailable") throw new GuideUnavailableError("/guides/pvz/x");`
 */
export class GuideUnavailableError extends Error {
  constructor(path: string) {
    super(`guide API unavailable while rendering ${path}`);
    this.name = "GuideUnavailableError";
  }
}
