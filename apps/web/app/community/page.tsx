import Link from "next/link";
import { Sparkles, Users } from "lucide-react";
import { getJson } from "@/lib/serverApi";
import { Banner } from "@/components/Banner";
import { Card } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { CommunityBuildCard } from "@/components/community/CommunityBuildCard";
import { CommunityFilterBar } from "@/components/community/CommunityFilterBar";
import { CommunityShell } from "@/components/community/CommunityShell";
import {
  COMMUNITY_SORTS,
  type CommunityBuildListResponse,
  type CommunitySort,
} from "@/components/community/types";

export const metadata = {
  title: "Community — SC2 Tools",
  description:
    "Player-published StarCraft II build orders + the Stock Market weekly P&L leaderboard. Filter by matchup, sort by top, new, or controversial, and save any build to your private library.",
  openGraph: {
    title: "Community — SC2 Tools",
    description:
      "Player-published StarCraft II build orders + the Stock Market weekly P&L leaderboard.",
    images: [{ url: "/banner.png", width: 2000, height: 800 }],
  },
};

const PAGE_SIZE = 24;

function isSort(value: string | undefined): value is CommunitySort {
  return COMMUNITY_SORTS.some((s) => s.value === value);
}

export default async function CommunityPage({
  searchParams,
}: {
  searchParams: Promise<{
    matchup?: string;
    sort?: string;
    q?: string;
    offset?: string;
  }>;
}) {
  const sp = await searchParams;
  const matchup = (sp.matchup || "").trim();
  const sort: CommunitySort = isSort(sp.sort) ? sp.sort : "top";
  const search = (sp.q || "").trim();
  const offset = Math.max(0, Number.parseInt(sp.offset || "0", 10) || 0);

  const params = new URLSearchParams();
  if (matchup) params.set("matchup", matchup);
  if (sort) params.set("sort", sort);
  if (search) params.set("q", search);
  params.set("limit", String(PAGE_SIZE));
  params.set("offset", String(offset));

  const data = await getJson<CommunityBuildListResponse>(
    `/v1/community/builds?${params.toString()}`,
  );
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
        title="Community"
        description="Player-published builds and the weekly Stock Market leaderboard. Vote, save to your private library, or publish your own."
        actions={
          <Link
            href="/builds"
            className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-border bg-bg-elevated px-4 text-body font-semibold text-text transition-colors hover:border-border-strong hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
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

      {items.length === 0 ? (
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
                className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-border bg-bg-elevated px-4 text-body font-semibold text-text transition-colors hover:border-border-strong hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
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
            offset={offset}
            limit={PAGE_SIZE}
            total={total}
            hasMore={hasMore}
            search={search}
            sort={sort}
            matchup={matchup}
          />
        </>
      )}
      </CommunityShell>
    </div>
  );
}

function Pagination({
  offset,
  limit,
  total,
  hasMore,
  search,
  sort,
  matchup,
}: {
  offset: number;
  limit: number;
  total: number;
  hasMore: boolean;
  search: string;
  sort: CommunitySort;
  matchup: string;
}) {
  const prev = Math.max(0, offset - limit);
  const next = offset + limit;
  function urlFor(o: number): string {
    const sp = new URLSearchParams();
    if (matchup) sp.set("matchup", matchup);
    if (sort && sort !== "top") sp.set("sort", sort);
    if (search) sp.set("q", search);
    if (o > 0) sp.set("offset", String(o));
    const qs = sp.toString();
    return qs ? `/community?${qs}` : "/community";
  }
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
          "inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-border px-4 text-body font-semibold transition-colors",
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
          "inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-border px-4 text-body font-semibold transition-colors",
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

