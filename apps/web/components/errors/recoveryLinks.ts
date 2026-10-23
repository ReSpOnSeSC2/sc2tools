import { ISSUES_URL } from "@/lib/siteLinks";

/**
 * Where to send someone who hit a missing page or a crashed one. Pure,
 * so the choices are unit-tested without rendering Clerk.
 */

export interface RecoveryLink {
  href: string;
  label: string;
  /** Only for signed-in players (the target needs an account). */
  signedInOnly?: boolean;
}

export interface RecoveryFlags {
  /** getInstantImportMode() === "all": /try is open to everyone. */
  tryPage: boolean;
  /** guidesEnabled(): the build guides exist. */
  guides: boolean;
}

/** True for `root` itself or any path below it. */
function under(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(`${root}/`);
}

/**
 * The section a missing path most likely belonged to, as the first
 * thing to offer.
 *
 * Example: `nearestHubLinks("/guides/pvz/old-build", flags)`
 * → [{ href: "/guides", label: "Back to the guides" }].
 */
export function nearestHubLinks(pathname: string, flags: RecoveryFlags): RecoveryLink[] {
  if (under(pathname, "/community/opponents")) {
    return [
      { href: "/community", label: "Browse community builds" },
      { href: "/app/opponents", label: "Your opponents", signedInOnly: true },
    ];
  }
  if (under(pathname, "/builds") || under(pathname, "/community")) {
    return [{ href: "/community", label: "Browse community builds" }];
  }
  if (under(pathname, "/guides") && flags.guides) {
    return [{ href: "/guides", label: "Back to the guides" }];
  }
  if (under(pathname, "/p") || under(pathname, "/players")) {
    return [{ href: "/community", label: "Community" }];
  }
  return [];
}

/** Public pages worth a look from any dead end. */
export function helpfulLinks(flags: RecoveryFlags): RecoveryLink[] {
  return [
    ...(flags.tryPage ? [{ href: "/try", label: "Analyze replays in your browser" }] : []),
    ...(flags.guides ? [{ href: "/guides", label: "Build guides" }] : []),
    { href: "/community", label: "Community builds" },
    { href: "/download", label: "Download" },
  ];
}

/**
 * The 404 page's link row: the nearest hub first, then the helpful
 * public pages, one link per destination.
 */
export function notFoundLinks(pathname: string, flags: RecoveryFlags): RecoveryLink[] {
  const seen = new Set<string>(["/", "/app"]);
  return [...nearestHubLinks(pathname, flags), ...helpfulLinks(flags)].filter((link) => {
    if (seen.has(link.href)) return false;
    seen.add(link.href);
    return true;
  });
}

/** The dashboard button's label: "back" when the lost page was in the app. */
export function dashboardLabel(pathname: string): string {
  return under(pathname, "/app") ? "Back to your dashboard" : "Open dashboard";
}

/**
 * A prefilled GitHub issue for a crashed page. The path never carries
 * its query string (it can hold tokens or personal filters).
 *
 * Example: `issueReportHref({ digest: "123", path: "/builds" })`
 * → ".../issues/new?title=Error%20123&body=Error%20reference%3A%20123%0APage%3A%20%2Fbuilds".
 */
export function issueReportHref({ digest, path }: { digest?: string | null; path: string }): string {
  const page = path.split(/[?#]/)[0] || "/";
  const title = digest ? `Error ${digest}` : `Error on ${page}`;
  const body = digest ? `Error reference: ${digest}\nPage: ${page}` : `Page: ${page}`;
  return `${ISSUES_URL}/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}
