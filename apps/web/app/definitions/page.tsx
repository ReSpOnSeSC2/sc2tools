import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import {
  DefinitionsCatalog,
  DefinitionsHeaderHint,
} from "@/components/definitions/DefinitionsCatalog";
import { BUILD_DEFINITIONS, DEFINITIONS_TOTAL } from "@/lib/build-definitions";
import { fetchPublishedGuidePaths } from "@/lib/guides/api";
import { definitionGuideLinks } from "@/lib/guides/definitionLinks";
import { guidesEnabled } from "@/lib/guides/flags";

export const metadata = {
  alternates: { canonical: "/definitions" },
  title: "Build & Strategy Definitions",
  description:
    "The detection rules used by the SC2 Tools analyzer to label opponent strategies and your own builds.",
};

export default async function DefinitionsPage() {
  // The guide sitemap is a cached read (6 h, purged when guides publish);
  // with guides off or the API down, cards simply show no Guide link.
  const published = guidesEnabled() ? await fetchPublishedGuidePaths() : null;
  const guideLinks = definitionGuideLinks(BUILD_DEFINITIONS, published);
  return (
    <div className="space-y-6">
      <Link
        href="/builds"
        className="inline-flex min-h-[44px] items-center gap-1.5 text-caption font-medium text-text-muted hover:text-text"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Back to library
      </Link>
      <PageHeader
        eyebrow="Reference"
        title="Build & Strategy Definitions"
        description={
          <>
            <span className="block">
              {DEFINITIONS_TOTAL} of {DEFINITIONS_TOTAL} entries · Search,
              filter by race, drill into per-matchup detection rules.
            </span>
          </>
        }
      />
      <DefinitionsHeaderHint />
      <DefinitionsCatalog guideLinks={guideLinks} />
    </div>
  );
}
