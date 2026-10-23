import type { MobileNavLink } from "./MobileNav";

/**
 * The marketing header's link list (desktop nav + MobileNav drawer),
 * kept pure so the order and the flag gating are unit-testable without
 * rendering Clerk.
 *
 * Signed out, the list leads with what a visitor can use without an
 * account: Analyze replays (/try, only while Instant Analysis is open to
 * everyone), Stream Studio, Guides, Community, Reviews, Help and
 * Download. Signed in, it is Build library, Guides, Community, Reviews,
 * Help, Settings, then Admin for admins. The app itself is reached from
 * the header's "Open app" pill, so "Today" stays the only in-app name
 * for /app. Guides took the slot of the retired Meta radar.
 */

export const TRY_NAV_LINK: MobileNavLink = { href: "/try", label: "Analyze replays", auth: "out" };
const STREAM_STUDIO_NAV_LINK: MobileNavLink = { href: "/stream-studio", label: "Stream Studio", auth: "out" };
const BUILDS_NAV_LINK: MobileNavLink = { href: "/builds", label: "Build library", auth: "in" };
export const GUIDES_NAV_LINK: MobileNavLink = { href: "/guides", label: "Guides", auth: "any" };
const COMMUNITY_LINK: MobileNavLink = { href: "/community", label: "Community", auth: "any" };
const REVIEWS_NAV_LINK: MobileNavLink = { href: "/reviews", label: "Reviews", auth: "any" };
// Help and Download wait for the xl header: at lg the signed-out row
// (four flagged links plus Sign in and Get started) would not fit.
export const HELP_NAV_LINK: MobileNavLink = { href: "/help", label: "Help", auth: "any", wideOnly: true };
const DOWNLOAD_NAV_LINK: MobileNavLink = { href: "/download", label: "Download", auth: "out", wideOnly: true };
const SETTINGS_LINK: MobileNavLink = { href: "/settings", label: "Settings", auth: "in" };
const ADMIN_NAV_LINK: MobileNavLink = { href: "/admin", label: "Admin", auth: "admin" };

export interface HeaderNavOptions {
  /** guidesEnabled() — the build guides flag. */
  guides: boolean;
  /** reviewsVisible(isAdmin) — the Replay Review Exchange rollout. */
  reviews: boolean;
  /** /v1/me reports an admin. */
  isAdmin: boolean;
  /** getInstantImportMode() === "all" — /try is open to everyone. */
  tryPage?: boolean;
}

/**
 * Header links for one viewer. Signed-in-only and signed-out-only links
 * are both in the list; the header and drawer render each one inside
 * the matching Clerk gate.
 *
 * Example: `headerNavLinks({ guides: true, reviews: false, isAdmin: false })`
 * → Stream Studio, Build library, Guides, Community, Help, Download, Settings.
 */
export function headerNavLinks(options: HeaderNavOptions): readonly MobileNavLink[] {
  return [
    ...(options.tryPage ? [TRY_NAV_LINK] : []),
    STREAM_STUDIO_NAV_LINK,
    BUILDS_NAV_LINK,
    ...(options.guides ? [GUIDES_NAV_LINK] : []),
    COMMUNITY_LINK,
    ...(options.reviews ? [REVIEWS_NAV_LINK] : []),
    HELP_NAV_LINK,
    DOWNLOAD_NAV_LINK,
    SETTINGS_LINK,
    ...(options.isAdmin ? [ADMIN_NAV_LINK] : []),
  ];
}
