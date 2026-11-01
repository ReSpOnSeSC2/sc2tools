import type { CommandNavigation } from "./CommandSearchContext";
import { admittedNavEntries } from "./appNav";

/**
 * The signed-in header's quick-search destinations: the app's own
 * NAV_ENTRIES with the app chrome's gates and keys, plus Help. Coaching
 * stays out, because the header makes no role probe. (AppShell already
 * loads the app chrome and appNav on every route.)
 *
 * Example: `signedInCommandNavigation({ isAdmin: false, reviews: true, guides: true })`
 * starts with Today and the analyzer sections and ends with Help.
 */
export function signedInCommandNavigation(gates: { isAdmin: boolean; reviews: boolean; guides: boolean }): CommandNavigation[] {
  return [
    ...admittedNavEntries({ ...gates, coaching: false }).map(({ key, href, label, description }) => ({ key, href, label, description })),
    { key: "help", href: "/help", label: "Help", description: "Articles for every feature" },
  ];
}
