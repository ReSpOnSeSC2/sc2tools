import Link from "next/link";
import { guidePaths } from "@/components/guides/guideMetadata";
import { GUIDE_LINK_CLASS, GUIDE_PANEL_CLASS } from "@/components/guides/guideUi";
import { fmtCount } from "@/lib/guides/format";
import type { GuideCounterLink } from "@/lib/guides/types";

/**
 * "How to beat …" links for a matchup's opponent openers. Published
 * counters first (the API already orders them); an unpublished one is
 * listed (it still has the catalog description and any videos) but says
 * so instead of showing a number.
 */
export function CounterLinks({
  counters,
  matchupSlug,
  includeUnpublished = false,
}: {
  counters: ReadonlyArray<GuideCounterLink>;
  matchupSlug: string;
  includeUnpublished?: boolean;
}) {
  const rows = includeUnpublished ? counters : counters.filter((counter) => counter.published);
  if (rows.length === 0) return null;
  return (
    <ul className={`${GUIDE_PANEL_CLASS} divide-y divide-border`}>
      {rows.map((counter) => (
        <li key={counter.strategyKey} className="flex items-center justify-between gap-3 px-4 py-2.5">
          <Link
            href={guidePaths.counter(matchupSlug, counter.strategySlug)}
            className={`${GUIDE_LINK_CLASS} min-w-0 break-words text-caption`}
          >
            How to beat {counter.name}
          </Link>
          <span className="shrink-0 text-right text-micro tabular-nums text-text-dim">
            {counter.published && counter.games !== null
              ? `${fmtCount(counter.games)} games`
              : "Not enough games yet"}
          </span>
        </li>
      ))}
    </ul>
  );
}
