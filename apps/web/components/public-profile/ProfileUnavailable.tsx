import { CloudOff } from "lucide-react";
import { EmptyStatePanel } from "@/components/ui/EmptyState";

/**
 * Transient state for /p/[handle] when the API is unreachable (deploy
 * blip, cold start). Deliberately NOT a 404: a real profile must not
 * read as "gone" to crawlers or visitors during an outage. Rendered
 * with noindex metadata (see the page's generateMetadata).
 */
export function ProfileUnavailable() {
  return (
    <section className="mx-auto max-w-2xl py-16">
      <EmptyStatePanel
        size="lg"
        icon={<CloudOff className="h-6 w-6 text-text-muted" aria-hidden />}
        title="Profile temporarily unavailable"
        description="We couldn't reach the stats service just now. This is usually a brief blip — try refreshing in a minute."
      />
    </section>
  );
}
