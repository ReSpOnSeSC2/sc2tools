import Link from "next/link";
import { Compass } from "lucide-react";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { GlowHalo } from "@/components/ui/GlowHalo";

/**
 * Branded 404. Without this file a bogus URL rendered Next.js's
 * unstyled default — a jarring break from the app's look for anyone
 * following a stale link or mistyping a build slug.
 */
export default function NotFound() {
  return (
    <section className="relative overflow-hidden rounded-2xl border-2 border-line bg-bg-surface px-4 py-12 shadow-hard sm:px-6 sm:py-20">
      <GlowHalo color="cyan" position="top" opacity={0.85} size={70} />
      <div className="relative z-10">
        <EmptyStatePanel
          size="lg"
          icon={<Compass className="h-6 w-6" aria-hidden />}
          title="Page not found"
          description="That route doesn't exist — the link may be stale, or the build/replay it pointed at was removed."
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Link
                href="/app"
                className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-accent px-4 text-body font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              >
                Open dashboard
              </Link>
              <Link
                href="/"
                className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-border bg-bg-elevated px-4 text-body font-semibold text-text transition-colors hover:border-border-strong hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              >
                Home
              </Link>
            </div>
          }
        />
      </div>
    </section>
  );
}
