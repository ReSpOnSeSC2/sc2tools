import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ReportCardViewer } from "@/components/instant/ReportCardViewer";
import { LinkButton } from "@/components/ui/Button";
import { getInstantImportMode } from "@/lib/instant/flag";
import { REPORT_CARD_PATH, REPORT_CARD_SEGMENTS } from "@/lib/instant/reportCardRoute";
import { pageMetadata } from "@/lib/seo/pageMetadata";

const TITLE = "StarCraft II replay report";
const DESCRIPTION = "View a replay report card. The numbers are self-reported by the person who shared the link.";

export const dynamicParams = false;

export function generateStaticParams() {
  return [REPORT_CARD_SEGMENTS];
}

export const metadata: Metadata = {
  ...pageMetadata({ title: TITLE, description: DESCRIPTION, canonical: REPORT_CARD_PATH }),
  title: TITLE,
  robots: { index: false, follow: true },
};

export default async function ReportCardPage({ params }: { params: Promise<{ type: string; class: string }> }) {
  const segments = await params;
  if (segments.type !== REPORT_CARD_SEGMENTS.type || segments.class !== REPORT_CARD_SEGMENTS.class) notFound();
  const tryIsPublic = getInstantImportMode() === "all";

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-2">
        <h1 className="font-display text-display-lg font-bold leading-tight text-text">{TITLE}</h1>
        <p className="max-w-prose text-body text-text-muted">The numbers are self-reported by the person who shared this card.</p>
        <LinkButton href={tryIsPublic ? "/try" : "/"} prefetch={false}>
          {tryIsPublic ? "Make yours" : "Explore SC2 Tools"}
        </LinkButton>
      </header>
      <ReportCardViewer />
    </div>
  );
}
