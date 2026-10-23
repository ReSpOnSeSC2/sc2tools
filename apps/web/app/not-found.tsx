import { Compass } from "lucide-react";
import { NotFoundActions } from "@/components/errors/NotFoundActions";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { GlowHalo } from "@/components/ui/GlowHalo";

/**
 * Branded 404. Without this file a bogus URL rendered Next.js's
 * unstyled default — a jarring break from the app's look for anyone
 * following a stale link or mistyping a build slug.
 *
 * The copy is static; the client island picks the way out for the
 * viewer (signed in or not) and for the path they were looking for.
 * Next marks every 404 response noindex.
 */
export default function NotFound() {
  return (
    <section className="relative overflow-hidden rounded-2xl border-2 border-line bg-bg-surface px-4 py-12 shadow-hard sm:px-6 sm:py-20">
      <GlowHalo color="cyan" position="top" opacity={0.85} size={70} />
      <div className="relative z-10">
        <EmptyStatePanel
          size="lg"
          icon={<Compass className="h-6 w-6" aria-hidden />}
          title={<h1 className="text-h3 font-bold text-text">We couldn&apos;t find that page</h1>}
          description="The link may be old, or the build or replay it pointed to was removed."
          action={<NotFoundActions />}
        />
      </div>
    </section>
  );
}
