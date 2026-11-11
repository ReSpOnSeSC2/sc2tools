import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ReportCardViewer } from "@/components/instant/ReportCardViewer";
import { LinkButton } from "@/components/ui/Button";
import { getInstantImportMode } from "@/lib/instant/flag";
import { REPORT_CARD_DISCLOSURE, REPORT_CARD_METADATA } from "@/lib/instant/reportCardMetadata";
import { reportCardClass, reportCardParams, reportCardPath, reportCardPreviewPath } from "@/lib/instant/reportCardRoute";
import { pageMetadata } from "@/lib/seo/pageMetadata";

type PageProps = { params: Promise<{ type: string; class: string }> };

export const dynamicParams = false;

export function generateStaticParams() {
  return reportCardParams();
}

async function resolveCardClass(params: PageProps["params"]) {
  const segments = await params;
  return reportCardClass(segments.type, segments.class) ?? notFound();
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const cardClass = await resolveCardClass(params);
  const { title, subtitle } = REPORT_CARD_METADATA[cardClass];
  const preview = reportCardPreviewPath(cardClass);
  const metadata = pageMetadata({
    title, description: `${subtitle} ${REPORT_CARD_DISCLOSURE}`, canonical: reportCardPath(cardClass), routeOgImage: true,
  });
  return {
    ...metadata,
    openGraph: { ...metadata.openGraph, images: [{ url: preview, width: 1200, height: 630, alt: title }] },
    twitter: { ...metadata.twitter, images: [{ url: preview, alt: title }] },
    robots: { index: false, follow: true },
  };
}

export default async function ReportCardPage({ params }: PageProps) {
  const cardClass = await resolveCardClass(params);
  const tryIsPublic = getInstantImportMode() === "all";

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-2">
        <h1 className="font-display text-display-lg font-bold leading-tight text-text">{REPORT_CARD_METADATA[cardClass].title}</h1>
        <p className="max-w-prose text-body text-text-muted">{REPORT_CARD_DISCLOSURE}</p>
        <LinkButton href={tryIsPublic ? "/try" : "/"} prefetch={false}>
          {tryIsPublic ? "Make yours" : "Explore SC2 Tools"}
        </LinkButton>
      </header>
      <ReportCardViewer key={cardClass} cardClass={cardClass} />
    </div>
  );
}
