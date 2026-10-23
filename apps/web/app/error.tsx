"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, Home, LayoutDashboard, RefreshCcw } from "lucide-react";
import { ErrorReference } from "@/components/errors/ErrorReference";
import { ViewerAuth } from "@/components/errors/ViewerAuth";
import { ReportErrorAction } from "@/components/feedback/ReportErrorAction";
import { Button } from "@/components/ui/Button";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { buttonClassName } from "@/components/ui/buttonStyles";
import { captureException } from "@/lib/sentry";

/**
 * Route-segment error boundary. Before this existed, a render-time
 * crash anywhere under the root layout blanked the page with no way
 * back — the single worst "is this app broken?" signal we could send.
 * Header/Footer chrome stays mounted (this boundary sits under the
 * root layout), the user keeps their bearings, and `reset()` re-renders
 * the segment without a full reload.
 *
 * The way out depends on the viewer: Dashboard for a signed-in player,
 * Home for everyone else (never a link that asks a visitor to sign in).
 * "Report this problem" opens the report form for a signed-in player,
 * with the page and the error reference as its subject; visitors (and
 * the OBS overlay and dock pages, which have no Clerk) get an email link
 * that carries the same reference. The page path never carries its query
 * string. The page is noindex: an error is never a search result.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Server components log server-side; this covers client crashes.
    console.error("route_error", error);
    void captureException(error);
  }, [error]);

  return (
    <section className="relative overflow-hidden rounded-2xl border-2 border-line bg-bg-surface px-4 py-12 shadow-hard sm:px-6 sm:py-16">
      <meta name="robots" content="noindex, nofollow" />
      <EmptyStatePanel
        size="lg"
        icon={<AlertTriangle className="h-6 w-6 text-danger" aria-hidden />}
        title={<h1 className="text-h3 font-bold text-text">Something broke on this page</h1>}
        description="The rest of the app is fine. This page hit an error it couldn't recover from."
        action={
          <div className="flex flex-col items-center gap-5">
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button
                variant="primary"
                onClick={() => reset()}
                iconLeft={<RefreshCcw className="h-4 w-4" aria-hidden />}
              >
                Try again
              </Button>
              <ViewerAuth>
                {(signedIn) =>
                  signedIn ? (
                    <Link href="/app" className={buttonClassName({ variant: "secondary" })}>
                      <LayoutDashboard className="h-4 w-4" aria-hidden />
                      Dashboard
                    </Link>
                  ) : (
                    <Link href="/" className={buttonClassName({ variant: "secondary" })}>
                      <Home className="h-4 w-4" aria-hidden />
                      Home
                    </Link>
                  )
                }
              </ViewerAuth>
            </div>
            {error.digest ? <ErrorReference digest={error.digest} /> : null}
            <ReportErrorAction digest={error.digest} />
          </div>
        }
      />
    </section>
  );
}
