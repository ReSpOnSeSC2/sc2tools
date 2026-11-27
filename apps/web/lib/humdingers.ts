/**
 * Humdingers, the site owner's browser RPG, ships as one prebuilt page in
 * public/play/ (docs/adr/0101-humdingers-static-game-page.md).
 */

/** The prebuilt file. Clerk's matcher skips dotted paths, so it is always public. */
export const HUMDINGERS_FILE = "/play/humdingers.html";

/** The public link. Middleware rewrites it to HUMDINGERS_FILE before Clerk runs. */
export const HUMDINGERS_PATH = "/play/humdingers";

/** Rounded size of HUMDINGERS_FILE for link copy. The What's New entry repeats it. */
export const HUMDINGERS_SIZE = "about 10 MB";

/**
 * Pages under /play/ are static documents outside the Next app. Link them with
 * a plain <a>: Next's Link prefetches the whole file, and a click first fetches
 * it as an RSC payload before falling back to a full page load.
 */
export function isStaticPlayPath(href: string): boolean {
  return href.startsWith("/play/");
}
