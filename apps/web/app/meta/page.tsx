import type { Metadata } from "next";
import { BarChart3 } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { getJson } from "@/lib/serverApi";
import { MetaControls } from "@/components/meta/MetaControls";
import { LadderMetaReport } from "@/components/meta/LadderMetaReport";
import {
  bandLabel,
  metaHref,
  parseAxis,
  parseBand,
  parseMatchup,
  type BandAxis,
  type MetaRow,
} from "@/lib/meta";

/**
 * Public Ladder Meta Radar — the effectiveness-weighted opener meta.
 *
 * Where the Spawning Tool shows pro PREVALENCE and SC2Pulse shows race
 * winrates, this shows which OPENERS actually WIN, by league band +
 * matchup, with week-over-week movement — computed nightly from the whole
 * SC2 Tools ladder corpus (apps/api/src/services/ladderMeta.js).
 *
 * Rendered server-side so crawlers get real HTML: the API (GET
 * /v1/meta/ladder) is PUBLIC and fetched here via getJson with no token.
 * Each (axis, opponent band, matchup) is its own indexable URL. Legacy
 * ?league=&matchup= links still resolve and canonicalize to the league axis.
 */

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://sc2tools.com";

function selectionFrom(sp: Record<string, string | string[] | undefined>): {
  axis: BandAxis;
  band: number;
  matchup: string;
} {
  const axis = parseAxis(sp.axis);
  const legacyLeague = axis === "league" ? sp.league : undefined;
  return {
    axis,
    band: parseBand(axis, sp.band ?? legacyLeague),
    matchup: parseMatchup(sp.matchup),
  };
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<Metadata> {
  const sp = await searchParams;
  const { axis, band, matchup } = selectionFrom(sp);
  const label = bandLabel(axis, band);
  const title = `${matchup} openers vs ${label} opponents — Ladder Meta Radar · SC2 Tools`;
  const description =
    `Which ${matchup} openers actually win against ${label} opponents on the StarCraft II ` +
    "ladder — win rates, prevalence, and week-over-week movement from real games.";
  const canonical = metaHref(axis, band, matchup);
  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      title,
      description,
      url: `${SITE_URL}${canonical}`,
    },
    robots: { index: true, follow: true },
  };
}

export default async function MetaPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const { axis, band, matchup } = selectionFrom(sp);
  const label = bandLabel(axis, band);

  // Public endpoint — fetched server-side (no auth) so the report ships as
  // crawlable HTML. Cached briefly; the underlying table only moves once a
  // day when the recompute job runs.
  const data = await getJson<{ row: MetaRow }>(
    `/v1/meta/ladder?axis=${axis}&band=${band}&matchup=${encodeURIComponent(matchup)}`,
    { revalidateSec: 3600 },
  );
  const row = data?.row ?? null;

  return (
    <article className="space-y-6">
      <PageHeader
        eyebrow="Ladder Meta Radar"
        title="Which openers actually win"
        description="Pro tier lists show what's popular. This shows what wins — the effectiveness-weighted opener meta by opponent league or 500-point MMR band and matchup, straight from real SC2 Tools ladder games, with week-over-week movement."
      />

      <MetaControls axis={axis} band={band} matchup={matchup} />

      {row ? (
        <LadderMetaReport row={row} axis={axis} band={band} />
      ) : (
        <div className="rounded-xl border-2 border-line bg-bg-surface shadow-hard">
          <EmptyStatePanel
            size="lg"
            icon={<BarChart3 className="h-5 w-5" aria-hidden />}
            title={`Not enough ${matchup} games vs ${label} opponents yet`}
            description={
              axis === "mmr"
                ? "We only publish a band once it clears a k-anonymity floor of real ladder games. Try League, another MMR band, or another matchup — or check back as the recent-game sample grows."
                : "We only publish a band once it clears a k-anonymity floor of real ladder games. Try another league, switch to MMR, or choose another matchup."
            }
          />
        </div>
      )}

      <p className="max-w-2xl text-caption text-text-muted">
        Aggregated across every SC2 Tools user, names withheld. Openers are the
        classified opening for each game; matchups band by opponent league or
        opponent MMR. MMR bands use recently enriched ratings and may be sparse
        while that forward-only sample grows. Nothing here is tied to any
        individual player.
      </p>
    </article>
  );
}
