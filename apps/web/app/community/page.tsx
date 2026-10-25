import type { Metadata } from "next";
import { Users } from "lucide-react";
import { getJsonWithStatus } from "@/lib/serverApi";
import { communityCacheOptions } from "@/lib/communityCache";
import { Banner } from "@/components/Banner";
import { Card } from "@/components/ui/Card";
import { LinkButton } from "@/components/ui/Button";
import { buttonClassName } from "@/components/ui/buttonStyles";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { CommunityBuildCard } from "@/components/community/CommunityBuildCard";
import { CommunityFilterBar } from "@/components/community/CommunityFilterBar";
import { CommunityFilterProvider, CommunityResults } from "@/components/community/CommunityFilterContext";
import { CommunityActiveFilters } from "@/components/community/CommunityActiveFilters";
import { CommunityShell } from "@/components/community/CommunityShell";
import { CommunityUnavailable } from "@/components/community/CommunityUnavailable";
import { PublishCta } from "@/components/community/PublishCta";
import { LazyMyPublishedBuilds } from "@/components/community/LazyMyPublishedBuilds";
import type { CommunityBuildListResponse } from "@/components/community/types";
import { clearCommunityFilters, communityEmptyTitle, communityHref, COMMUNITY_PAGE_SIZE, parseCommunityQuery, type CommunityQuery } from "@/lib/communityQuery";
import { pageMetadata } from "@/lib/seo/pageMetadata";

const METADATA: Metadata = pageMetadata({
  canonical: "/community", title: "Community builds",
  description: "Player-published StarCraft II builds and the Stock Market weekly leaderboard. Filter by race, opponent and skill level, search or sort by votes, publication or updates, and save builds to your private library.",
  shareTitle: "Community builds — SC2 Tools",
});
type CommunitySearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Every filter is part of the request URL; outages remain distinct from empty results. */
function loadBuilds(query: CommunityQuery) {
  const params = new URLSearchParams();
  if (query.race) params.set("race", query.race);
  if (query.vs) params.set("vsRace", query.vs);
  if (query.skill) params.set("skill", query.skill);
  params.set("sort", query.sort);
  if (query.search) params.set("q", query.search);
  params.set("limit", String(COMMUNITY_PAGE_SIZE)); params.set("offset", String(query.offset));
  return getJsonWithStatus<CommunityBuildListResponse>("/v1/community/builds?" + params.toString(), communityCacheOptions());
}

export async function generateMetadata({ searchParams }: { searchParams: CommunitySearchParams }): Promise<Metadata> {
  const query = parseCommunityQuery(await searchParams);
  if (query.mine) return { ...METADATA, robots: { index: false, follow: false } };
  const { data } = await loadBuilds(query);
  return data ? METADATA : { ...METADATA, robots: { index: false, follow: true } };
}

export default async function CommunityPage({ searchParams }: { searchParams: CommunitySearchParams }) {
  const query = parseCommunityQuery(await searchParams);
  const { data } = query.mine ? { data: null } : await loadBuilds(query);
  const items = data?.items ?? []; const total = data?.total ?? 0;
  const filtered = !!(query.race || query.vs || query.skill || query.search);
  const pastEnd = total > 0 && query.offset >= total;
  return <div className="space-y-6">
    <PageHeader eyebrow={<span className="inline-flex items-center gap-1.5"><Users className="h-3 w-3" aria-hidden />Community</span>} title="Community builds"
      description="Player-published builds and the weekly Stock Market leaderboard. Vote, save to your private library, or publish your own."
      actions={<PublishCta />} />
    <Banner variant="divider" />
    <CommunityShell active="builds"><CommunityFilterProvider>
      <CommunityFilterBar initialRace={query.race} initialVs={query.vs} initialSkill={query.skill} initialSort={query.sort} initialSearch={query.search} initialMine={query.mine} />
      <CommunityResults>
        {query.mine ? <LazyMyPublishedBuilds /> : <>
        <div className="space-y-2">
          {data && !pastEnd ? <p className="text-caption text-text-muted">Showing <span className="font-mono tabular-nums text-text">{items.length ? (query.offset + 1) + "–" + (query.offset + items.length) : "0"}</span> of <span className="font-mono tabular-nums text-text">{total}</span></p> : null}
          <CommunityActiveFilters query={query} />
        </div>
        {!data ? <CommunityUnavailable title="Community builds are temporarily unavailable" retryHref={communityHref(query)} /> : pastEnd ? <Card><EmptyStatePanel size="lg" title="No more results" description="This page is past the end of the list." action={<LinkButton href={communityHref({ ...query, offset: 0 })} variant="secondary">Back to page 1</LinkButton>} /></Card> : !items.length ? <Card><EmptyStatePanel size="lg" title={communityEmptyTitle(query)} description={filtered ? "Try a different keyword or clear a filter to see more published builds." : "Be the first to publish a build to the community."} action={<LinkButton href={filtered ? communityHref(clearCommunityFilters(query)) : "/builds"} variant="secondary">{filtered ? "Reset filters" : "Open my library"}</LinkButton>} /></Card> : <>
          <ul role="list" aria-label="Community builds" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">{items.map((build) => <li key={build.slug} role="listitem" className="h-full"><CommunityBuildCard build={build} /></li>)}</ul>
          <Pagination query={query} limit={COMMUNITY_PAGE_SIZE} total={total} hasMore={data.hasMore} />
        </>}
        </>}
      </CommunityResults>
    </CommunityFilterProvider></CommunityShell>
  </div>;
}

function Pagination({ query, limit, total, hasMore }: { query: CommunityQuery; limit: number; total: number; hasMore: boolean }) {
  if (total <= limit) return null;
  const className = "min-h-11 px-3";
  const disabledClass = buttonClassName({ variant: "secondary", size: "sm", className: className + " opacity-40" });
  return <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-2 pt-2">
    {query.offset === 0 ? <span aria-disabled="true" className={disabledClass}>← Previous</span> : <LinkButton href={communityHref({ ...query, offset: Math.max(0, query.offset - limit) })} variant="secondary" size="sm" className={className}>← Previous</LinkButton>}
    <span className="text-caption tabular-nums text-text-muted">Page {Math.floor(query.offset / limit) + 1} of {Math.ceil(total / limit)}</span>
    {!hasMore ? <span aria-disabled="true" className={disabledClass}>Next →</span> : <LinkButton href={communityHref({ ...query, offset: query.offset + limit })} variant="secondary" size="sm" className={className}>Next →</LinkButton>}
  </nav>;
}

