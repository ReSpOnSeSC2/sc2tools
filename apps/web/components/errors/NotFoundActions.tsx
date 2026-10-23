"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, LayoutDashboard } from "lucide-react";
import { buttonClassName } from "@/components/ui/buttonStyles";
import { guidesEnabled } from "@/lib/guides/flags";
import { getInstantImportMode } from "@/lib/instant/flag";
import { dashboardLabel, notFoundLinks } from "./recoveryLinks";
import { ViewerAuth } from "./ViewerAuth";

/**
 * The 404 page's way out, picked for the viewer: Go home always; the
 * dashboard only for a signed-in player; then the nearest section to
 * the missing page and the public pages anyone can use. A visitor is
 * never sent to a page that would ask them to sign in.
 */
export function NotFoundActions() {
  const pathname = usePathname() ?? "/";
  const links = notFoundLinks(pathname, {
    tryPage: getInstantImportMode() === "all",
    guides: guidesEnabled(),
  });

  return (
    <ViewerAuth>
      {(signedIn) => (
        <div className="flex flex-col items-center gap-5">
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Link href="/" className={buttonClassName({ variant: "primary" })}>
              <Home className="h-4 w-4" aria-hidden />
              Go home
            </Link>
            {signedIn ? (
              <Link href="/app" className={buttonClassName({ variant: "secondary" })}>
                <LayoutDashboard className="h-4 w-4" aria-hidden />
                {dashboardLabel(pathname)}
              </Link>
            ) : null}
          </div>
          <nav aria-label="Other pages" className="space-y-2">
            <p className="text-caption text-text-muted">Or try one of these:</p>
            <ul className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1">
              {links
                .filter((link) => !link.signedInOnly || signedIn)
                .map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="inline-flex min-h-[44px] items-center rounded-sm text-body font-semibold text-accent-cyan underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
            </ul>
          </nav>
        </div>
      )}
    </ViewerAuth>
  );
}
