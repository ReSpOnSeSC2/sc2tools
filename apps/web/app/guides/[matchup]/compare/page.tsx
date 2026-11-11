import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { compareMetadata, guidePaths } from "@/components/guides/guideMetadata";
import { GuideUnavailable } from "@/components/guides/GuideStates";
import { CompareOpeners, type ComparedOpener } from "@/components/guides/compare/CompareOpeners";
import { GUIDE_SECONDARY_ACTION_CLASS } from "@/components/guides/guideUi";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { fetchGuideBuild, fetchPublishedGuidePaths } from "@/lib/guides/api";
import { compareSelection } from "@/lib/guides/compareSelection";
import { guidesEnabled } from "@/lib/guides/flags";
import { matchupFromGuideSlug } from "@/lib/guides/slugs";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ matchup: string }>;
  searchParams: Promise<{ builds?: string | string[]; era?: string | string[] }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { matchup } = await params;
  return compareMetadata(matchupFromGuideSlug(matchup.toLowerCase()) ? matchup.toLowerCase() : "");
}

function PickOpeners({ matchup }: { matchup?: string }) {
  return <EmptyStatePanel title="Pick 2–3 openers to compare"
    description="Choose published openers from the same 12-worker matchup."
    action={<Link className={GUIDE_SECONDARY_ACTION_CLASS} href={matchup ? guidePaths.matchup(matchup) : guidePaths.hub()}>Back to build guides</Link>} />;
}

export default async function CompareGuidePage({ params, searchParams }: Props) {
  if (!guidesEnabled()) notFound();
  const [{ matchup }, query] = await Promise.all([params, searchParams]);
  const slug = matchup.toLowerCase();
  const matchupName = matchupFromGuideSlug(slug);
  if (!matchupName) return <PickOpeners />;
  if (query.era === "before") redirect(guidePaths.matchup(slug));
  const { slugs, truncated } = compareSelection(typeof query.builds === "string" ? query.builds : undefined);
  if (slugs.length < 2) return <PickOpeners matchup={slug} />;
  const published = await fetchPublishedGuidePaths();
  if (!published) return <GuideUnavailable title="The published opener list is temporarily unavailable" />;
  if (slugs.some((build) => !published.has(guidePaths.build(slug, build)))) return <PickOpeners matchup={slug} />;
  const results = await Promise.allSettled(slugs.map((build) => fetchGuideBuild(slug, build)));
  const columns: ComparedOpener[] = results.map((result, index) => ({
    slug: slugs[index],
    build: result.status === "fulfilled" && result.value.kind === "ok" && result.value.data.published
      ? result.value.data : null,
  }));
  return <CompareOpeners matchup={matchupName} matchupSlug={slug} columns={columns} truncated={truncated} />;
}
