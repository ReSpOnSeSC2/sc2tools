import { Suspense } from "react";
import Link from "next/link";
import { CommunityBuildCard } from "@/components/community/CommunityBuildCard";
import type { CommunityBuildListItem } from "@/components/community/types";
import { guidePaths } from "@/components/guides/guideMetadata";
import { TrendBadge } from "@/components/guides/TrendBadge";
import { ReviewCard } from "@/components/reviews/ReviewCard";
import { COMMUNITY_CACHE_TAG } from "@/lib/communityCache";
import { GUIDE_CACHE_TAG } from "@/lib/guides/api";
import { guidesEnabled } from "@/lib/guides/flags";
import type { GuideTrendValue } from "@/lib/guides/types";
import { reviewsRollout, type ReviewCard as ReviewData } from "@/lib/reviews";
import { getJsonWithStatus } from "@/lib/serverApi";

const HOUR = 3600;
const FETCH_TIMEOUT_MS = 3000;
const COUNTS = [
  { key: "games", label: "games analyzed" },
  { key: "communityBuilds", label: "published Community builds" },
  { key: "answeredReviews", label: "answered replay reviews" },
  { key: "guideGames", label: "games in the guide corpus" },
] as const;
type CountKey = (typeof COUNTS)[number]["key"];
type Totals = Partial<Record<CountKey, number | null>> & { thresholds: Partial<Record<CountKey, { min: number; step: number }>> };
type Trend = { name: string; matchup: string; matchupSlug: string; buildSlug: string; trend: GuideTrendValue };
const COUNT_FORMAT = new Intl.NumberFormat("en-US");

async function read<T>(path: string, tags: string[] = [], revalidateSec = HOUR): Promise<T | null> {
  const response = await getJsonWithStatus<T>("/v1/site/" + path, { revalidateSec, tags, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  return response.data;
}

export function visibleLandingCounts(totals: Totals | null) {
  return COUNTS.flatMap(({ key, label }) => {
    const count = totals?.[key];
    const threshold = totals?.thresholds?.[key];
    if (!threshold || !(threshold.step > 0) || typeof count !== "number" || !Number.isSafeInteger(count) || count < threshold.min) return [];
    return [{ key, label, formatted: COUNT_FORMAT.format(Math.floor(count / threshold.step) * threshold.step) + "+" }];
  });
}

async function LiveTotals() {
  const totals = await read<Totals>("totals", [GUIDE_CACHE_TAG, COMMUNITY_CACHE_TAG]);
  const counts = visibleLandingCounts(totals);
  if (!counts.length) return null;
  return <section className="space-y-3">
    <h2 className="font-display text-h2 text-text">Live from the ladder</h2>
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {counts.map(({ key, label, formatted }) => <li key={key} className="rounded-xl border border-line bg-bg-surface p-4 text-text-muted">
        <span className="block font-display text-h3 tabular-nums text-text">{formatted}</span> {label}
      </li>)}
    </ul>
    <Link className="inline-flex min-h-11 items-center text-caption text-link hover:underline" href="/help/how-we-count">How we count these</Link>
  </section>;
}

async function ClimbingGuides() {
  if (!guidesEnabled()) return null;
  const data = await read<{ items: Trend[] }>("guide-trends", [GUIDE_CACHE_TAG]);
  const items = data?.items ?? [];
  if (!items.length) return null;
  return <section className="space-y-3">
    <h2 className="font-display text-h3 text-text">Climbing this week</h2>
    <ul className="grid gap-3 md:grid-cols-3">{items.map((item) => {
      const href = guidePaths.build(item.matchupSlug, item.buildSlug);
      return <li key={href}><Link href={href} className="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-bg-surface p-3 text-link hover:underline">
        <span>{item.name} <span className="text-caption text-text-muted">{item.matchup}</span></span>
        <TrendBadge trend={item.trend} showDelta />
      </Link></li>;
    })}</ul>
  </section>;
}

async function FreshCommunityBuilds() {
  const data = await read<{ items: CommunityBuildListItem[] }>("community-builds", [COMMUNITY_CACHE_TAG]);
  if (!data?.items?.length) return null;
  return <section className="space-y-3">
    <h2 className="font-display text-h3 text-text">Fresh from the community</h2>
    <ul className="grid gap-3 md:grid-cols-3">
      {data.items.map((build) => <li className="min-w-0" key={build.slug}><CommunityBuildCard build={build} hideAuthor showOwnerActions={false} /></li>)}
    </ul>
  </section>;
}

async function LatestAnsweredReview() {
  if (reviewsRollout() !== "on") return null;
  // Keep the Review Board's shorter moderation window for public questions.
  const data = await read<{ item: ReviewData | null }>("latest-answered", [], 60);
  if (!data?.item) return null;
  return <section className="space-y-3">
    <h2 className="font-display text-h3 text-text">Latest answered review</h2>
    <ul><ReviewCard card={data.item} now={Date.now()} /></ul>
  </section>;
}

export function LiveFromTheLadder() {
  return <div className="space-y-5 empty:hidden">
    <Suspense fallback={null}><LiveTotals /></Suspense>
    <Suspense fallback={null}><ClimbingGuides /></Suspense>
    <Suspense fallback={null}><FreshCommunityBuilds /></Suspense>
    <Suspense fallback={null}><LatestAnsweredReview /></Suspense>
  </div>;
}
