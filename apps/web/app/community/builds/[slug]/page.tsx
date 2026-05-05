import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Calendar, Users } from "lucide-react";
import { getJson } from "@/lib/serverApi";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { fmtAgo, fmtDate } from "@/lib/format";
import { coerceRace, raceIconName, raceTint } from "@/lib/race";
import { AuthorChip } from "@/components/community/AuthorChip";
import { CommunityBuildSignatureTimeline } from "@/components/community/CommunityBuildSignatureTimeline";
import { CommunityVotePanel } from "@/components/community/CommunityVotePanel";
import { RelatedBuilds } from "@/components/community/RelatedBuilds";
import { SaveToLibraryButton } from "@/components/community/SaveToLibraryButton";
import { ShareLinkButton } from "@/components/community/ShareLinkButton";
import type { CommunityBuildDetail } from "@/components/community/types";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const data = await getJson<CommunityBuildDetail>(
    `/v1/community/builds/${encodeURIComponent(slug)}`,
  );
  if (!data) return { title: "Build not found — SC2 Tools" };
  const description =
    data.description?.slice(0, 200) ||
    `Player-published StarCraft II build for ${data.matchup || "any matchup"}.`;
  return {
    title: `${data.title} — community build — SC2 Tools`,
    description,
    openGraph: {
      title: `${data.title} — SC2 Tools community build`,
      description,
      images: [{ url: "/banner.png", width: 2000, height: 800 }],
    },
  };
}

/**
 * Legacy step shape — older published builds before Phase 7 stored a
 * `steps` array of { supply, time, action }. We continue to render
 * those rows untouched as a fallback when no `signature` is present.
 */
type LegacyStep = { supply?: number; time?: string; action?: string };

export default async function CommunityBuildPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const data = await getJson<CommunityBuildDetail>(
    `/v1/community/builds/${encodeURIComponent(slug)}`,
  );
  if (!data) notFound();

  const build = data.build || {};
  const race = coerceRace(build.race);
  const tint = raceTint(race);
  const signature = Array.isArray(build.signature) ? build.signature : [];
  const legacySteps: LegacyStep[] = Array.isArray(
    (build as Record<string, unknown>).steps,
  )
    ? ((build as Record<string, unknown>).steps as LegacyStep[])
    : [];

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Community",
        item: "/community",
      },
      {
        "@type": "ListItem",
        position: 2,
        name: data.title,
        item: `/community/builds/${data.slug}`,
      },
    ],
  };

  return (
    <article className="space-y-6">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(breadcrumbJsonLd),
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
            <AuthorChip build={data} size="sm" />
            <span className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wider text-text-dim">
              <Calendar className="h-3 w-3" aria-hidden />
              {fmtAgo(data.publishedAt)}
            </span>
          </span>
        }
        title={data.title}
        description={data.description}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          {signature.length > 0 ? (
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

          {build.notes ? (
            <Card title="Author notes">
              <pre className="whitespace-pre-wrap break-words font-sans text-body text-text">
                {build.notes}
              </pre>
            </Card>
          ) : null}
        </div>

        <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <Card>
            <CommunityVotePanel
              slug={data.slug}
              initialVotes={data.votes ?? 0}
            />
          </Card>
          <Card>
            <div className="space-y-3">
              <SaveToLibraryButton build={data.build} title={data.title} />
              <ShareLinkButton path={`/community/builds/${data.slug}`} />
            </div>
          </Card>
          <Card>
            <dl className="space-y-3 text-caption">
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-text-muted">Race</dt>
                <dd className="inline-flex items-center gap-1.5 font-medium text-text">
                  <Icon
                    name={raceIconName(race)}
                    kind="race"
                    size={14}
                    decorative
                  />
                  {race}
                </dd>
              </div>
              {data.matchup ? (
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-text-muted">Matchup</dt>
                  <dd className={["font-medium", tint.text].join(" ")}>
                    {data.matchup}
                  </dd>
                </div>
              ) : null}
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-text-muted">Published</dt>
                <dd className="font-medium text-text">
                  {fmtDate(data.publishedAt)}
                </dd>
              </div>
              {data.updatedAt && data.updatedAt !== data.publishedAt ? (
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-text-muted">Updated</dt>
                  <dd className="font-medium text-text">
                    {fmtAgo(data.updatedAt)}
                  </dd>
                </div>
              ) : null}
              <div className="flex items-baseline justify-between gap-2">
                <dt className="inline-flex items-center gap-1 text-text-muted">
                  <Users className="h-3 w-3" aria-hidden />
                  Author
                </dt>
                <dd>
                  <AuthorChip build={data} size="sm" />
                </dd>
              </div>
            </dl>
          </Card>
          <RelatedBuilds matchup={data.matchup} currentSlug={data.slug} />
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
