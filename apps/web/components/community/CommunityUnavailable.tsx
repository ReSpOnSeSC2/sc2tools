import Link from "next/link";
import { ArrowLeft, CloudOff, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { buttonClassName } from "@/components/ui/buttonStyles";

/**
 * The honest "we couldn't load it" state for public community pages.
 * Shown when the API is unreachable or answers 5xx, so an outage never
 * reads as "no builds yet" or "this doesn't exist". Pages that render
 * it also return robots noindex.
 *
 * "Try again" is a plain link to the same URL (a full reload), which
 * works without client JavaScript and re-runs the server fetch.
 *
 * Example:
 *   <CommunityUnavailable title="This build is temporarily unavailable" retryHref="/community/builds/x" />
 */

/** One line for every outage panel: plain, from the visitor's side. */
export const COMMUNITY_UNAVAILABLE_BODY = "The server may be waking up (about 30 s). Nothing is lost.";

export interface CommunityUnavailableProps {
  title: string;
  /** The page's own URL (path and query): "Try again" reloads it. */
  retryHref: string;
  /**
   * Detail pages: the panel replaces the whole page, so its title is the
   * page's h1 and a "Back to community" link sits above it. List pages
   * keep their own header and use an h2.
   */
  standalone?: boolean;
}

export function CommunityUnavailable({ title, retryHref, standalone = false }: CommunityUnavailableProps) {
  const Heading = standalone ? "h1" : "h2";
  return (
    <div className="space-y-6">
      {standalone ? (
        <Link
          href="/community"
          className="inline-flex min-h-[44px] items-center gap-1.5 text-caption font-medium text-text-muted hover:text-text"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to community
        </Link>
      ) : null}
      <Card>
        <EmptyStatePanel
          size="lg"
          icon={<CloudOff className="h-6 w-6" aria-hidden />}
          title={<Heading className="text-h4 font-bold text-text">{title}</Heading>}
          description={COMMUNITY_UNAVAILABLE_BODY}
          action={
            <a href={retryHref} className={buttonClassName({ variant: "secondary" })}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              Try again
            </a>
          }
        />
      </Card>
    </div>
  );
}
