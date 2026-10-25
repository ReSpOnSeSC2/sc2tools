import type { Metadata } from "next";
import { Suspense } from "react";
import { BuildOrderSteps } from "@/components/builds/BuildOrderSteps";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Calendar } from "lucide-react";
import { getJsonWithStatus } from "@/lib/serverApi";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { fmtAgo } from "@/lib/format";
import { coerceRace, raceIconName, raceTint } from "@/lib/race";
import { AuthorChip } from "@/components/community/AuthorChip";
import { CommunityUnavailable } from "@/components/community/CommunityUnavailable";
import { CommunityBuildSignatureTimeline } from "@/components/community/CommunityBuildSignatureTimeline";
import { CommunityGamePlan } from "@/components/community/CommunityGamePlan";
import { CommunityVotePanel } from "@/components/community/CommunityVotePanel";
import { CommunityBuildActionsBar } from "@/components/community/CommunityBuildActionsBar";
import { CommunityBuildReport } from "@/components/community/CommunityBuildReport";
import { CommunityBuildMeta } from "@/components/community/CommunityBuildMeta";
import { ExpandableText } from "@/components/community/ExpandableText";
import { CommunityBuildOwnerControls } from "@/components/community/CommunityBuildOwnerControls";
import { RelatedBuilds } from "@/components/community/RelatedBuilds";
import { CommunityGuideLink } from "@/components/guides/CommunityGuideLink";
import { SaveToLibraryButton } from "@/components/community/SaveToLibraryButton";
import { ShareLinkButton } from "@/components/community/ShareLinkButton";
import type { CommunityBuildDetail } from "@/components/community/types";
import { RulesSummary } from "@/components/builds/RulesSummary";
import { SKILL_LEVELS, coerceSavedRules } from "@/lib/build-rules";
import { SavedBuildExportMenu } from "@/components/builds/SavedBuildExportMenu";
import { PracticeButton } from "@/components/practice/PracticeButton";
import { serializeJsonLd } from "@/lib/reviewJsonLd";
import { communityDescription } from "@/lib/communityDescription";
import { pageMetadata } from "@/lib/seo/pageMetadata";
import { trimDescription } from "@/lib/seo/trimDescription";
import { absoluteUrl } from "@/lib/seo/absoluteUrl";

/**
 * The published build. A 404 from the API is the only "doesn't exist";
 * an unreachable API or a 5xx leaves `data` null with any other status,
 * and the page then says it is temporarily unavailable instead of
 * 404ing a build that exists. generateMetadata and the page make the
 * same request, which Next dedupes within one render.
 */
function loadBuild(slug: string) {
  return getJsonWithStatus<CommunityBuildDetail>(
    `/v1/community/builds/${encodeURIComponent(slug)}`,
  );
}

const UNAVAILABLE_TITLE = "This build is temporarily unavailable";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const { data, status } = await loadBuild(slug);
  if (status === 404) notFound();
  if (!data) {
    return {
      title: UNAVAILABLE_TITLE,
      robots: { index: false, follow: false },
    };
  }
  const description =
    trimDescription(data.description || "", 200) ||
    `Player-published StarCraft II build for ${data.matchup || "any matchup"}.`;
  return pageMetadata({
    title: `${data.title} · Community build`,
    description,
    canonical: `/community/builds/${encodeURIComponent(data.slug)}`,
    shareTitle: `${data.title} — SC2 Tools community build`, routeOgImage: true,
  });
}

/**
 * Legacy step shape — older published builds before Phase 7 stored a
 * `steps` array of { supply, time, action }. We continue to render
 * those rows untouched as a fallback when no `signature` is present.
 */
type LegacyStep = { supply?: number; time?: string; action?: string };

/** The snapshot's skill level as its display label ("Diamond"), or null. */
function skillLevelLabel(value: unknown): string | null {
  return SKILL_LEVELS.find((level) => level.id === value)?.label ?? null;
}

export default async function CommunityBuildPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { data, status } = await loadBuild(slug);
  if (status === 404) notFound();
  if (!data) {
    return (
      <CommunityUnavailable
        title={UNAVAILABLE_TITLE}
        retryHref={`/community/builds/${encodeURIComponent(slug)}`}
        standalone
      />
    );
  }

  const build = data.build || {};
  // The snapshot's v3 fields aren't on the legacy CustomBuild type.
  const snapshot = build as Record<string, unknown>;
  const race = coerceRace(build.race);
  const tint = raceTint(race);
  // v3 builds persist `rules`, read back as Must have / Must not have
  // (RulesSummary) so None and At most 0 rules are never shown as
  // something to build. Rules are what games are matched on, so they win
  // over a v2 `signature` (a step timeline) when a build has both.
  const signature = Array.isArray(build.signature) ? build.signature : [];
  const rules = coerceSavedRules(snapshot.rules);
  const legacySteps: LegacyStep[] = Array.isArray(snapshot.steps)
    ? (snapshot.steps as LegacyStep[])
    : [];
  const skillLevel = skillLevelLabel(snapshot.skillLevel);
  const description = communityDescription(data.description);

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Community",
        item: absoluteUrl("/community"),
      },
      {
        "@type": "ListItem",
        position: 2,
        name: data.title,
        item: absoluteUrl(`/community/builds/${encodeURIComponent(data.slug)}`),
      },
    ],
  };

  return (
    <article className="space-y-6">
      {/* The title is author text: serializeJsonLd escapes "<", so a
          title containing "</script>" can never close the tag. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: serializeJsonLd(breadcrumbJsonLd),
        }}
      />

      <Link
        href="/community"
        className="inline-flex min-h-[44px] items-center gap-1.5 text-caption font-medium text-text-muted hover:text-text"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Back to community
      </Link>

      <PageHeader
        eyebrow={
          <span className="inline-flex flex-wrap items-center gap-2">
            {data.matchup ? (
              <Badge
                variant="neutral"
                size="sm"
                className={[tint.bg, tint.border, tint.text].join(" ")}
                iconLeft={
                  <Icon
                    name={raceIconName(race)}
                    kind="race"
                    size={14}
                    decorative
                  />
                }
              >
                {data.matchup}
              </Badge>
            ) : null}
            {skillLevel ? (
              <Badge
                variant="neutral"
                size="sm"
                title="The level the author wrote this build for"
                iconLeft={
                  <Icon
                    name={String(snapshot.skillLevel)}
                    kind="league"
                    size={14}
                    decorative
                  />
                }
              >
                {skillLevel}
              </Badge>
            ) : null}
            <AuthorChip build={data} size="sm" />
            <span className="inline-flex items-center gap-1 text-micro uppercase tracking-wider text-text-dim">
              <Calendar className="h-3 w-3" aria-hidden />
              {fmtAgo(data.publishedAt)}
            </span>
          </span>
        }
        title={data.title}
        description={description.summary}
      />

      <CommunityBuildActionsBar build={data} />

      {/* Streams in: a slow guide API never holds up the build page. */}
      <Suspense fallback={null}>
        <CommunityGuideLink matchup={data.matchup} names={[build.name, data.title]} />
      </Suspense>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          <BuildOrderSteps value={snapshot.buildOrder} />
          {description.showAbout ? <Card><h2 className="mb-3 text-h4 font-semibold text-text">About this build</h2><ExpandableText text={data.description.trim()} /></Card> : null}
          {rules.length > 0 ? (
            <RulesSummary rules={rules} />
          ) : signature.length > 0 ? (
            <CommunityBuildSignatureTimeline signature={signature} />
          ) : legacySteps.length > 0 ? (
            <LegacyStepsTable steps={legacySteps} />
          ) : (
            <Card>
              <p className="text-caption text-text-muted">
                This build doesn&apos;t include structured steps. Check the
                description above for the author&apos;s notes.
              </p>
            </Card>
          )}

          <CommunityGamePlan
            winConditions={snapshot.winConditions}
            losesTo={snapshot.losesTo}
            transitionsInto={snapshot.transitionsInto}
          />
        </div>

        <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <div className="hidden lg:block"><PracticeButton build={{ ...data.build, name: data.title }} /></div>
          <Card className="hidden lg:block">
            <CommunityVotePanel
              slug={data.slug}
              initialVotes={data.votes ?? 0}
            />
          </Card>
          <Card className="hidden lg:block">
            <div className="space-y-3">
              <SaveToLibraryButton
                build={data.build}
                title={data.title}
                communitySlug={data.slug}
                version={data.updatedAt || data.publishedAt}
              />
              <ShareLinkButton path={`/community/builds/${data.slug}`} />
              <SavedBuildExportMenu build={build} meta={{ title: data.title, matchup: data.matchup, author: data.authorName, sourceUrl: `/community/builds/${encodeURIComponent(data.slug)}` }} />
              <CommunityBuildOwnerControls
                slug={data.slug}
                title={data.title}
                redirectAfterRemove
              />
            </div>
          </Card>
          <CommunityBuildMeta data={data} ruleCount={Array.isArray(snapshot.rules) ? rules.length : null} stepCount={signature.length || legacySteps.length} />
          <RelatedBuilds matchup={data.matchup} currentSlug={data.slug} />
          <Card><CommunityBuildReport slug={data.slug} /></Card>
        </aside>
      </div>
    </article>
  );
}

function LegacyStepsTable({ steps }: { steps: LegacyStep[] }) {
  return (
    <Card padded={false} className="overflow-hidden">
      <header className="flex flex-wrap items-center gap-2 border-b border-border bg-bg-surface/95 px-4 py-3">
        <h2 className="text-caption font-semibold uppercase tracking-wider text-text">
          Build order
        </h2>
        <span className="text-caption text-text-dim">
          {steps.length} step{steps.length === 1 ? "" : "s"}
        </span>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-caption">
          <thead className="bg-bg-elevated text-left text-text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Supply</th>
              <th className="px-3 py-2 font-medium">Time</th>
              <th className="px-3 py-2 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((s, i) => (
              <tr key={i} className="border-t border-border">
                <td className="px-3 py-2 font-mono tabular-nums text-text">
                  {s.supply ?? ""}
                </td>
                <td className="px-3 py-2 font-mono tabular-nums text-text">
                  {s.time ?? ""}
                </td>
                <td className="px-3 py-2 text-text">{s.action ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
