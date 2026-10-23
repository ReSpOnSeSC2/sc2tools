import { PageHeader } from "@/components/ui/PageHeader";
import {
  DefinitionsCatalog,
} from "@/components/definitions/DefinitionsCatalog";
import { BUILD_DEFINITIONS } from "@/lib/build-definitions";
import { DefinitionsBackLink } from "@/components/definitions/DefinitionsBackLink";
import { fetchPublishedGuidePaths } from "@/lib/guides/api";
import { definitionGuideLinks } from "@/lib/guides/definitionLinks";
import { guidesEnabled } from "@/lib/guides/flags";

// Keep the successful sitemap in the data cache, but never cache a whole
// page with missing links after one failed API request.
export const dynamic = "force-dynamic";

export const metadata = {
  alternates: { canonical: "/definitions" },
  title: "Build & Strategy Definitions",
  description:
    "The detection rules used by the SC2 Tools analyzer to label opponent strategies and your own builds.",
};

export default async function DefinitionsPage() {
  // The guide sitemap is a cached read (6 h, purged when guides publish);
  // with guides off or the API down, this request shows no Guide link.
  const published = guidesEnabled() ? await fetchPublishedGuidePaths() : null;
  const guideLinks = definitionGuideLinks(BUILD_DEFINITIONS, published);
  return (
    <div className="space-y-6">
      <DefinitionsBackLink />
      <PageHeader
        eyebrow="Reference"
        title="Build & Strategy Definitions"
        description="How SC2 Tools labels builds and strategies. Every label comes from fixed replay rules, never AI."
      />
      <DefinitionsCatalog guideLinks={guideLinks} />
    </div>
  );
}
