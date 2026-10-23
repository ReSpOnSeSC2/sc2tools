import { GuideSection as Section } from "@/components/guides/GuideSection";
import { GuideCopyText } from "@/components/guides/GuideCopyText";
import { GuidePersonalComparison } from "@/components/guides/GuidePersonalComparison";
import { TimingsTable } from "./TimingsTable";
import type { GuideCopyLine } from "@/lib/guides/guideCopy";
import type { GuideBuildPublished } from "@/lib/guides/types";

export { milestoneText, splitDelta } from "./buildTimingFormat";

export function BuildTimingsSection({ payload, blurb }: { payload: GuideBuildPublished; blurb: ReadonlyArray<GuideCopyLine> }) {
  const { timings } = payload;
  const community = (timings?.milestones ?? []).map(({ key, label, event, median, p25, p75 }) => ({ key, label, event, median, p25, p75 }));
  const hasTable = Boolean(timings && community.length);
  const comparison = <GuidePersonalComparison matchupSlug={payload.matchupSlug} buildSlug={payload.buildSlug} buildName={payload.name} community={community} communityWinRate={payload.overall.winRate} showTimings={!hasTable} showSignInPrompt={!hasTable} />;
  if (!hasTable || !timings) return <Section id="your-record" title="Your record with this build">{comparison}</Section>;
  return <Section id="key-timings" title="Key timings"><div className="space-y-4"><GuideCopyText lines={blurb} /><TimingsTable timings={timings} matchupSlug={payload.matchupSlug} buildSlug={payload.buildSlug} />{comparison}</div></Section>;
}
