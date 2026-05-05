import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import {
  DefinitionsCatalog,
  DefinitionsHeaderHint,
} from "@/components/definitions/DefinitionsCatalog";
import { DEFINITIONS_TOTAL } from "@/lib/build-definitions";

export const metadata = {
  title: "Build & Strategy Definitions · SC2 Tools",
  description:
    "The detection rules used by the SC2 Tools analyzer to label opponent strategies and your own builds.",
};

export default function DefinitionsPage() {
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
      <DefinitionsCatalog />
    </div>
  );
}
