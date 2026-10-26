/** Server-only catalog shaping keeps the guide catalog out of /try's JS. */
import { canLinkGuidePath } from "@/components/guides/guideMetadata";
import { GUIDE_MATCHUPS, guideBuildOptions, guideBuildPath, guideCounterPath, guideStrategyOptions } from "@/lib/guides/slugs";
import type { ReportGuideLink } from "./reportGuideTypes";

export function buildReportGuideLinks(published: ReadonlySet<string> | null): ReportGuideLink[] {
  if (!published) return [];
  return GUIDE_MATCHUPS.flatMap((matchup) => (["build", "counter"] as const).flatMap((kind) => {
    const options = kind === "build" ? guideBuildOptions(matchup) : guideStrategyOptions(matchup);
    return options.flatMap(({ name, slug }) => {
      const path = kind === "build" ? guideBuildPath(matchup, name) : guideCounterPath(matchup, name);
      return path && canLinkGuidePath(published, path) ? [{ name, matchup, kind, key: `${matchup.toLowerCase()}/${slug}`,
        href: `${path}?utm_source=instant&utm_medium=report&utm_campaign=guides` }] : [];
    });
  }));
}
