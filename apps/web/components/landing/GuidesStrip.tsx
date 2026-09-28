import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { guidesEnabled } from "@/lib/guides/flags";
import { GUIDE_MATCHUPS, GUIDES_BASE_PATH, guideMatchupPath } from "@/lib/guides/slugs";

/**
 * "Browse build guides" strip in the landing page's Practice chapter
 * (same editorial strip style as the Arcade strip above it). Links the
 * guide hub and every matchup page, so the public guides are one click
 * from the home page. Carries no numbers: the guides themselves hold the
 * real win rates. Renders nothing while the guides flag is off.
 */
export function GuidesStrip() {
  if (!guidesEnabled()) return null;
  return (
    <div
      data-testid="landing-guides-strip"
      className="mt-8 grid gap-6 border-y border-border py-6 lg:grid-cols-[1fr_auto] lg:items-center"
    >
      <div>
        <p className="kicker">Build guides</p>
        <h3 className="mt-2 font-serif text-h3 font-semibold text-text">What wins on ladder, build by build.</h3>
        <p className="mt-2 max-w-2xl text-caption text-text-muted">
          Every opener ranked by its real ladder win rate, with key timings, army snapshots and build-order videos.
        </p>
        <Link
          href={GUIDES_BASE_PATH}
          className="mt-4 inline-flex min-h-[44px] items-center gap-2 rounded-md border-2 border-line bg-bg-elevated px-4 text-body font-semibold text-text transition-colors duration-100 hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          Browse build guides
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>
      <ul className="grid grid-cols-3 gap-2" aria-label="Build guides by matchup">
        {GUIDE_MATCHUPS.map((matchup) => (
          <li key={matchup}>
            <Link
              href={guideMatchupPath(matchup)}
              className="flex h-11 min-w-[64px] items-center justify-center rounded-md border border-border bg-bg-elevated px-3 font-mono text-caption font-bold text-text-muted hover:border-border-strong hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span className="sr-only">{`${matchup} build guides`}</span>
              <span aria-hidden>{matchup}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
