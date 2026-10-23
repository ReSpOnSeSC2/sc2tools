import type { Metadata } from "next";
import Link from "next/link";
import { Sparkles, Users } from "lucide-react";
import { getJsonWithStatus } from "@/lib/serverApi";
import { Banner } from "@/components/Banner";
import { Card } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { CommunityBuildCard } from "@/components/community/CommunityBuildCard";
import { CommunityFilterBar } from "@/components/community/CommunityFilterBar";
import { CommunityShell } from "@/components/community/CommunityShell";
import { CommunityUnavailable } from "@/components/community/CommunityUnavailable";
import {
  COMMUNITY_SORTS,
  type CommunityBuildListResponse,
  type CommunitySort,
} from "@/components/community/types";

const METADATA: Metadata = {
  alternates: { canonical: "/community" },
  title: "Community builds",
  description:
    "Player-published StarCraft II build orders + the Stock Market weekly P&L leaderboard. Filter by matchup, sort by top, new, or controversial, and save any build to your private library.",
  openGraph: {
    title: "Community builds — SC2 Tools",
    description:
      "Player-published StarCraft II build orders + the Stock Market weekly P&L leaderboard.",
    images: [{ url: "/og.jpg", width: 1200, height: 630 }],
  },
};

const PAGE_SIZE = 24;

function isSort(value: string | undefined): value is CommunitySort {
  return COMMUNITY_SORTS.some((s) => s.value === value);
}

type CommunitySearchParams = Promise<{
  matchup?: string;
  sort?: string;
  q?: string;
  offset?: string;
}>;

interface CommunityQuery {
  matchup: string;
  sort: CommunitySort;
  search: string;
  offset: number;
}

function parseQuery(sp: Awaited<CommunitySearchParams>): CommunityQuery {
  return {
    matchup: (sp.matchup || "").trim(),
    sort: isSort(sp.sort) ? sp.sort : "top",
    search: (sp.q || "").trim(),
    offset: Math.max(0, Number.parseInt(sp.offset || "0", 10) || 0),
  };
}

/**
 * One page of published builds. `data` is null when the API was
 * unreachable or failed: that is an outage, never an empty list.
 * generateMetadata and the page make the same request, which Next
 * dedupes within one render.
 */
function loadBuilds(query: CommunityQuery) {
  const params = new URLSearchParams();
  if (query.matchup) params.set("matchup", query.matchup);
  params.set("sort", query.sort);
  if (query.search) params.set("q", query.search);
  params.set("limit", String(PAGE_SIZE));
  params.set("offset", String(query.offset));
  return getJsonWithStatus<CommunityBuildListResponse>(
    `/v1/community/builds?${params.toString()}`,
  );
}

/** The /community URL for a query (pagination, "Try again"). */
function communityHref(query: CommunityQuery): string {
  const sp = new URLSearchParams();
  if (query.matchup) sp.set("matchup", query.matchup);
  if (query.sort && query.sort !== "top") sp.set("sort", query.sort);
  if (query.search) sp.set("q", query.search);
  if (query.offset > 0) sp.set("offset", String(query.offset));
  const qs = sp.toString();
  return qs ? `/community?${qs}` : "/community";
}

export async function generateMetadata({ searchParams }: { searchParams: CommunitySearchParams }): Promise<Metadata> {
  const { data } = await loadBuilds(parseQuery(await searchParams));
  // An outage page is not the community page: keep it out of the index.
  return data ? METADATA : { ...METADATA, robots: { index: false, follow: true } };
}

export default async function CommunityPage({
  searchParams,
}: {
  searchParams: CommunitySearchParams;
}) {
  const query = parseQuery(await searchParams);
  const { matchup, sort, search, offset } = query;
  const { data } = await loadBuilds(query);
  const items = data?.items || [];
  const total = data?.total ?? 0;
  const hasMore = data?.hasMore ?? false;

  const showingTo = offset + items.length;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <span className="inline-flex items-center gap-1.5">
            <Users className="h-3 w-3" aria-hidden />
            Community
          </span>
        }
        title="Community builds"
        description="Player-published builds and the weekly Stock Market leaderboard. Vote, save to your private library, or publish your own."
        actions={
          <Link
            href="/builds"
            className="inline-flex min-h-[44px] items-center gap-2 hard-press rounded-full border-2 border-line bg-bg-surface px-5 font-display text-body font-bold text-text hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            <Sparkles className="h-4 w-4 text-accent-cyan" aria-hidden />
            Publish a build
          </Link>
        }
      />

      <Banner variant="divider" />

      <CommunityShell active="builds">
      <CommunityFilterBar
        initialMatchup={matchup}
        initialSort={sort}
        initialSearch={search}
      />

      {!data ? (
        <CommunityUnavailable
          title="Community builds are temporarily unavailable"
          retryHref={communityHref(query)}
        />
      ) : items.length === 0 ? (
        <Card>
          <EmptyStatePanel
            size="lg"
            title={search ? "No builds match your search" : "No builds yet"}
            description={
              search
                ? `Nothing matched "${search}". Try a different keyword or remove the matchup filter.`
                : matchup
                  ? `No published ${matchup} builds yet. Be the first — publish from your library.`
                  : "Be the first to publish a build to the community."
            }
            action={
              <Link
                href={search || matchup ? "/community" : "/builds"}
                className="inline-flex min-h-[44px] items-center gap-2 hard-press rounded-full border-2 border-line bg-bg-surface px-5 font-display text-body font-bold text-text hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              >
                {search || matchup ? "Reset filters" : "Open my library"}
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          <div className="flex items-baseline justify-between text-caption text-text-muted">
            <span>
              Showing{" "}
              <span className="font-mono tabular-nums text-text">
                {offset + 1}–{showingTo}
              </span>{" "}
              of <span className="font-mono tabular-nums text-text">{total}</span>
              {matchup ? ` · ${matchup}` : ""}
            </span>
          </div>
          <ul
            role="list"
            className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
          >
            {items.map((b) => (
              <li key={b.slug} role="listitem" className="h-full">
                <CommunityBuildCard build={b} />
              </li>
            ))}
          </ul>
          <Pagination
            query={query}
            limit={PAGE_SIZE}
            total={total}
            hasMore={hasMore}
          />
        </>
      )}
      </CommunityShell>
    </div>
  );
}

function Pagination({
  query,
  limit,
  total,
  hasMore,
}: {
  query: CommunityQuery;
  limit: number;
  total: number;
  hasMore: boolean;
}) {
  const { offset } = query;
  const prev = Math.max(0, offset - limit);
  const next = offset + limit;
  const urlFor = (o: number) => communityHref({ ...query, offset: o });
  if (total <= limit) return null;
  return (
    <nav
      aria-label="Pagination"
      className="flex items-center justify-between gap-2 pt-2"
    >
      <Link
        href={urlFor(prev)}
        aria-disabled={offset === 0}
        className={[
          "inline-flex min-h-[44px] items-center gap-2 rounded-full border-2 border-line px-5 font-display text-body font-bold transition-colors",
          offset === 0
            ? "pointer-events-none opacity-40"
            : "bg-bg-elevated text-text hover:border-border-strong hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        ].join(" ")}
      >
        ← Previous
      </Link>
      <Link
        href={urlFor(next)}
        aria-disabled={!hasMore}
        className={[
          "inline-flex min-h-[44px] items-center gap-2 rounded-full border-2 border-line px-5 font-display text-body font-bold transition-colors",
          !hasMore
            ? "pointer-events-none opacity-40"
            : "bg-bg-elevated text-text hover:border-border-strong hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        ].join(" ")}
      >
        Next →
      </Link>
    </nav>
  );
}

