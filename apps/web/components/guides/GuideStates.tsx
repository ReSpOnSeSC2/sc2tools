import Link from "next/link";
import type { ReactNode } from "react";
import { CloudOff, Hourglass } from "lucide-react";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import {
  GUIDE_PANEL_CLASS,
  GUIDE_PRIMARY_ACTION_CLASS,
  GUIDE_SECONDARY_ACTION_CLASS,
} from "@/components/guides/guideUi";

/**
 * Non-data states shared by the guide pages.
 *
 * - GuideUnavailable: the API did not answer (outage, timeout, 5xx).
 *   Rendered with a 200 and noindex metadata so real guides never turn
 *   into 404s during a blip.
 * - GuideNotEnoughGames: the page exists but is below the publishing
 *   floor. It shows only real content (the catalog name/description and
 *   any channel videos passed as children) and never a number.
 */

export function GuideUnavailable({ title = "This guide is temporarily unavailable" }: { title?: string }) {
  return (
    <div className={GUIDE_PANEL_CLASS}>
      <EmptyStatePanel
        size="lg"
        icon={<CloudOff className="h-6 w-6" aria-hidden />}
        title={title}
        description="The stats service didn't respond. Try again in a moment."
        action={
          <Link href="/guides" className={GUIDE_SECONDARY_ACTION_CLASS}>
            All build guides
          </Link>
        }
      />
    </div>
  );
}

export interface GuideNotEnoughGamesProps {
  eyebrow?: ReactNode;
  title: string;
  description?: string | null;
  /** Where "back" goes (the matchup page or the hub). */
  backHref: string;
  backLabel: string;
  /** Real extra content, e.g. the owner's video block. */
  children?: ReactNode;
}

export function GuideNotEnoughGames({
  eyebrow,
  title,
  description,
  backHref,
  backLabel,
  children,
}: GuideNotEnoughGamesProps) {
  return (
    <div className="space-y-8">
      <PageHeader eyebrow={eyebrow} title={title} description={description ?? undefined} />
      <div className={GUIDE_PANEL_CLASS}>
        <EmptyStatePanel
          size="md"
          icon={<Hourglass className="h-6 w-6" aria-hidden />}
          title="Not enough games yet"
          description="We publish numbers only once enough players have logged enough ladder games with it since 12 starting workers returned. Every game you upload counts toward it."
          action={
            <div className="flex flex-col items-center gap-2 sm:flex-row">
              <Link href="/sign-up" className={GUIDE_PRIMARY_ACTION_CLASS}>
                Sign up free and track your games
              </Link>
              <Link href={backHref} className={GUIDE_SECONDARY_ACTION_CLASS}>
                {backLabel}
              </Link>
            </div>
          }
        />
      </div>
      {children}
    </div>
  );
}
