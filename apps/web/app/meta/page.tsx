import type { Metadata } from "next";
import { BarChart3 } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { getJson } from "@/lib/serverApi";
import { MetaControls } from "@/components/meta/MetaControls";
import { LadderMetaReport } from "@/components/meta/LadderMetaReport";
import {
  leagueLabel,
  parseLeagueId,
  parseMatchup,
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
 * Each (league, matchup) is its own indexable URL via ?league=&matchup=.
 */

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://sc2tools.com";

export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<Metadata> {
  const sp = await searchParams;
  const leagueId = parseLeagueId(sp.league);
  const matchup = parseMatchup(sp.matchup);
  const league = leagueLabel(leagueId);
  const title = `${league} ${matchup} opener meta — Ladder Meta Radar · SC2 Tools`;
  const description =
    `Which ${matchup} openers actually win in ${league} on the StarCraft II ` +
    "ladder — win rates, prevalence, and week-over-week movement from real games.";
  return {
    title,
    description,
    alternates: { canonical: `/meta?league=${leagueId}&matchup=${matchup}` },
    openGraph: {
      title,
      description,
      url: `${SITE_URL}/meta?league=${leagueId}&matchup=${matchup}`,
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
  const leagueId = parseLeagueId(sp.league);
  const matchup = parseMatchup(sp.matchup);
  const league = leagueLabel(leagueId);

  // Public endpoint — fetched server-side (no auth) so the report ships as
  // crawlable HTML. Cached briefly; the underlying table only moves once a
  // day when the recompute job runs.
  const data = await getJson<{ row: MetaRow }>(
    `/v1/meta/ladder?leagueId=${leagueId}&matchup=${encodeURIComponent(matchup)}`,
    { revalidateSec: 3600 },
  );
  const row = data?.row ?? null;

  return (
    <article className="space-y-6">
      <PageHeader
        eyebrow="Ladder Meta Radar"
        title="Which openers actually win"
        description="Pro tier lists show what's popular. This shows what wins — the effectiveness-weighted opener meta by league band and matchup, straight from real SC2 Tools ladder games, with week-over-week movement."
      />

      <MetaControls leagueId={leagueId} matchup={matchup} />

      {row ? (
        <LadderMetaReport row={row} />
      ) : (
        <div className="rounded-xl border-2 border-line bg-bg-surface shadow-hard">
          <EmptyStatePanel
            size="lg"
            icon={<BarChart3 className="h-5 w-5" aria-hidden />}
            title={`Not enough ${league} ${matchup} games yet`}
            description="We only publish a band once it clears a k-anonymity floor of real ladder games. Try another league or matchup — or check back as more games come in."
          />
        </div>
      )}

      <p className="max-w-2xl text-caption text-text-muted">
        Aggregated across every SC2 Tools user, names withheld. Openers are the
        classified opening for each game; matchups band by opponent league.
        Nothing here is tied to any individual player.
      </p>
    </article>
  );
}
