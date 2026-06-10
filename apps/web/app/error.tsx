"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { EmptyStatePanel } from "@/components/ui/EmptyState";

/**
 * Route-segment error boundary. Before this existed, a render-time
 * crash anywhere under the root layout blanked the page with no way
 * back — the single worst "is this app broken?" signal we could send.
 * Header/Footer chrome stays mounted (this boundary sits under the
 * root layout), the user keeps their bearings, and `reset()` re-renders
 * the segment without a full reload.
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
    // eslint-disable-next-line no-console
    console.error("route_error", error);
  }, [error]);

  return (
    <section className="relative overflow-hidden rounded-2xl border-2 border-line bg-bg-surface px-4 py-12 shadow-hard sm:px-6 sm:py-16">
      <EmptyStatePanel
        size="lg"
        icon={<AlertTriangle className="h-6 w-6 text-danger" aria-hidden />}
        title="Something broke on this page"
        description={
          <>
            The rest of the app is fine — this view hit an error it
            couldn&apos;t recover from.
            {error.digest ? (
              <>
                {" "}
                Error reference:{" "}
                <code className="font-mono text-micro text-text-dim">
                  {error.digest}
                </code>
              </>
            ) : null}
          </>
        }
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button
              variant="primary"
              onClick={() => reset()}
              iconLeft={<RefreshCcw className="h-4 w-4" aria-hidden />}
            >
              Try again
            </Button>
            <Link
              href="/app"
              className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-border bg-bg-elevated px-4 text-body font-semibold text-text transition-colors hover:border-border-strong hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            >
              Back to dashboard
            </Link>
          </div>
        }
      />
    </section>
  );
}
