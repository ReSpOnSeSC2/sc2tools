import Link from "next/link";
import { guidePaths } from "@/components/guides/guideMetadata";
import { guideBandQueryString, type GuideBandQuery } from "@/lib/guides/format";
import { eraShortLabel } from "@/lib/guides/guideCopy";
import type { GuideBand, GuideBandOption, GuideBandOptions, GuideEra } from "@/lib/guides/types";

/**
 * Matchup-page filters as plain links (crawlable, no JS): opponent band
 * ("All" = the canonical URL when on the current 12-worker era) and the
 * era toggle (12 workers / the 8-worker patch 5.0.16). Only bands the API
 * lists (≥ 1 published cell) appear.
 */

const PILL_CLASS =
  "inline-flex min-h-[36px] items-center rounded-full border-2 px-3 py-1 text-caption font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg";
const PILL_ACTIVE_CLASS = "border-line bg-accent text-white";
const PILL_IDLE_CLASS = "border-border bg-bg-surface text-text hover:bg-bg-elevated";

interface Pill {
  key: string;
  label: string;
  href: string;
  isActive: boolean;
}

function PillGroup({ label, pills }: { label: string; pills: ReadonlyArray<Pill> }) {
  if (pills.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
      <span className="text-micro font-semibold uppercase tracking-wider text-text-dim">{label}</span>
      <ul className="flex flex-wrap gap-1.5">
        {pills.map((pill) => (
          <li key={pill.key}>
            <Link
              href={pill.href}
              aria-current={pill.isActive ? "page" : undefined}
              className={`${PILL_CLASS} ${pill.isActive ? PILL_ACTIVE_CLASS : PILL_IDLE_CLASS}`}
              prefetch={false}
            >
              {pill.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function bandPills(
  path: string,
  axis: "league" | "mmr",
  options: ReadonlyArray<GuideBandOption>,
  current: GuideBand | null,
  era: GuideEra,
): Pill[] {
  return options.map((option) => {
    const query: GuideBandQuery = { type: axis, value: option.value };
    return {
      key: `${axis}-${option.value}`,
      label: axis === "mmr" ? `${option.label} MMR` : option.label,
      href: `${path}${guideBandQueryString(query, era)}`,
      isActive: current?.type === axis && current.value === option.value,
    };
  });
}

export function BandSwitcher({
  matchupSlug,
  band,
  era,
  options,
}: {
  matchupSlug: string;
  band: GuideBand | null;
  era: GuideEra;
  /**
   * Ignored: the payload's live patch, which names neither era's games
   * (the pills are worker-based, `eraShortLabel`). Optional so callers
   * that still pass it compile.
   */
  patch?: string;
  options: GuideBandOptions;
}) {
  const path = guidePaths.matchup(matchupSlug);
  const current: GuideBandQuery | null = band ? { type: band.type, value: band.value } : null;
  const eraPills: Pill[] = [
    { key: "after", label: eraShortLabel("after"), href: `${path}${guideBandQueryString(current, "after")}`, isActive: era === "after" },
    { key: "before", label: eraShortLabel("before"), href: `${path}${guideBandQueryString(current, "before")}`, isActive: era === "before" },
  ];
  const allPill: Pill = { key: "all", label: "All", href: `${path}${guideBandQueryString(null, era)}`, isActive: !band };
  return (
    <nav aria-label="Filter openers" className="space-y-2">
      <PillGroup label="Game" pills={eraPills} />
      <PillGroup label="Opponent league" pills={[allPill, ...bandPills(path, "league", options.league, band, era)]} />
      <PillGroup label="Opponent MMR" pills={bandPills(path, "mmr", options.mmr, band, era)} />
    </nav>
  );
}
