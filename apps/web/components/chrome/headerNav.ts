import type { MobileNavLink } from "./MobileNav";

/**
 * The marketing header's link list (desktop nav + MobileNav drawer),
 * kept pure so the order and the flag gating are unit-testable without
 * rendering Clerk.
 *
 * Order: Dashboard, Custom builds, Guides (when the build guides are
 * on), Community, Reviews (when the review rollout shows it to this
 * viewer), Settings, then Admin for admins. Guides took the slot of the
 * retired Meta radar.
 */

export const GUIDES_NAV_LINK: MobileNavLink = { href: "/guides", label: "Guides", auth: "any" };
const REVIEWS_NAV_LINK: MobileNavLink = { href: "/reviews", label: "Reviews", auth: "any" };
const ADMIN_NAV_LINK: MobileNavLink = { href: "/admin", label: "Admin", auth: "admin" };

const LEADING_LINKS: readonly MobileNavLink[] = [
  { href: "/app", label: "Dashboard", auth: "in" },
  { href: "/builds", label: "Custom builds", auth: "in" },
];
const COMMUNITY_LINK: MobileNavLink = { href: "/community", label: "Community", auth: "any" };
const SETTINGS_LINK: MobileNavLink = { href: "/settings", label: "Settings", auth: "in" };

export interface HeaderNavOptions {
  /** guidesEnabled() — the build guides flag. */
  guides: boolean;
  /** reviewsVisible(isAdmin) — the Replay Review Exchange rollout. */
  reviews: boolean;
  /** /v1/me reports an admin. */
  isAdmin: boolean;
}

/**
 * Header links for one viewer.
 *
 * Example: `headerNavLinks({ guides: true, reviews: false, isAdmin: false })`
 * → Dashboard, Custom builds, Guides, Community, Settings.
 */
export function headerNavLinks(options: HeaderNavOptions): readonly MobileNavLink[] {
  return [
    ...LEADING_LINKS,
    ...(options.guides ? [GUIDES_NAV_LINK] : []),
    COMMUNITY_LINK,
    ...(options.reviews ? [REVIEWS_NAV_LINK] : []),
    SETTINGS_LINK,
    ...(options.isAdmin ? [ADMIN_NAV_LINK] : []),
  ];
}
