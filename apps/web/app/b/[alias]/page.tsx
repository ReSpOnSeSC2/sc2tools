import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PracticeLinkTabs } from "@/components/practice/PracticeLinkTabs";
import { PageHeader } from "@/components/ui/PageHeader";
import { getInstantImportMode } from "@/lib/instant/flag";
import { practiceGradeTarget } from "@/lib/practice/practiceGrade";
import { practiceLinkByAlias, practiceLinkPath } from "@/lib/practice/practiceLinks";
import { loadPracticeLink } from "@/lib/practice/serverPracticeLink";
import { referenceOrderPracticeTarget } from "@/lib/practiceTarget";
import { pageMetadata } from "@/lib/seo/pageMetadata";
import { PracticeLinkLoading } from "./PracticeLinkLoading";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ alias: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const result = await loadPracticeLink((await params).alias);
  if (result.kind === "missing") notFound();
  if (result.kind === "unavailable") return { title: "Practice Link unavailable", robots: { index: false } };
  return pageMetadata({
    title: `${result.build.title} · Practice Link`,
    description: "Follow the creator’s StarCraft II build order.",
    canonical: practiceLinkPath(result.link),
  });
}

export default async function PracticeLinkPage({ params }: Props) {
  const { alias } = await params;
  // Reject unlisted aliases before a loading boundary can flush a 200 response.
  if (!practiceLinkByAlias(alias)) notFound();
  return <Suspense fallback={<PracticeLinkLoading />}><PublishedPracticeLink alias={alias} /></Suspense>;
}

async function PublishedPracticeLink({ alias }: { alias: string }) {
  const result = await loadPracticeLink(alias);
  if (result.kind === "missing") notFound();
  if (result.kind === "unavailable") return <section className="space-y-3">
    <PageHeader title="Practice Link unavailable" description="The published build could not be loaded." />
    <a className="inline-flex min-h-11 items-center text-accent underline" href={practiceLinkPath(result.link)}>Try again</a>
  </section>;
  const { build, link } = result;
  return <article className="mx-auto max-w-5xl space-y-5">
    <PageHeader eyebrow="Practice Link" title={build.title} className="[overflow-wrap:anywhere]" description={`Build by ${build.creator}`} />
    <PracticeLinkTabs title={build.title} videoId={link.youtubeId} offset={link.offsetSec} steps={build.order?.steps ?? []}
      drill={referenceOrderPracticeTarget(build.title, build.order, build.race === "Random" ? undefined : build.race)}
      grade={practiceGradeTarget(build.title, build.order, build.race, link.gradeEndSec)}
      race={build.race} era={link.patchEra} gradeEnabled={getInstantImportMode() === "all"} />
  </article>;
}
