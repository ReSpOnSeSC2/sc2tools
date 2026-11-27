/**
 * Humdingers, the site owner's browser RPG, ships as one prebuilt page in
 * public/play/ (docs/adr/0101-humdingers-static-game-page.md). Signed-in
 * players open it through a host page that keeps their saves in their
 * account (docs/adr/0102-humdingers-account-saves-and-play-stats.md).
 */

/** The prebuilt file. Middleware keeps it behind sign-in and inside its host page. */
export const HUMDINGERS_FILE = "/play/humdingers.html";

/** The host page that runs the game full screen, signed in only. */
export const HUMDINGERS_PATH = "/play/humdingers";

/** Rounded size of HUMDINGERS_FILE for link copy. The What's New entry repeats it. */
export const HUMDINGERS_SIZE = "about 10 MB";

/**
 * Two moments from the game's own seeded demo (?watch&seed=11&speed=8),
 * captured at its exact 2x size (768x432) so pixelated scaling stays crisp.
 */
export const HUMDINGERS_GAMEPLAY_SHOTS = [
  { src: "/landing/humdingers-gameplay-1.png", alt: "A Humdingers battle: three hydra heads on a swirling green field, with Jay's HP and PP below" },
  { src: "/landing/humdingers-gameplay-2.png", alt: "Humdrum's main street in Humdingers, with shops, a hotel and passing cars" },
] as const;

/**
 * Pages under /play/ open with a full page load: the host page switches the
 * whole site shell off, and the game file must never be prefetched or
 * fetched as an RSC payload by Next's Link.
 */
export function isStaticPlayPath(href: string): boolean {
  return href.startsWith("/play/");
}
