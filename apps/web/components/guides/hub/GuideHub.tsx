import Link from "next/link";
import { ArrowRight, Youtube } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { GuideJsonLd } from "@/components/guides/GuideJsonLd";
import { GuideVideoRow } from "@/components/guides/GuideVideoRow";
import { MatchupGrid } from "@/components/guides/hub/MatchupGrid";
import { guidePaths } from "@/components/guides/guideMetadata";
import { breadcrumbJsonLd } from "@/components/guides/guideSeo";
import { GUIDE_SECONDARY_ACTION_CLASS, eraLabel } from "@/components/guides/guideUi";
import { safeChannelUrl } from "@/components/guides/youtubeUrls";
import { fmtCount, fmtGuideDate } from "@/lib/guides/format";
import type { GuideChannel, GuideIndexPayload } from "@/lib/guides/types";

/**
 * Body of /guides: the 3×3 matchup grid with this week's top openers,
 * the latest build-order videos from the channel (+ subscribe link) and
 * the way into the map guides.
 */

function SubscribeLink({ channel }: { channel: GuideChannel | null }) {
  const href = safeChannelUrl(channel?.url);
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={GUIDE_SECONDARY_ACTION_CLASS}>
      <Youtube className="h-4 w-4" aria-hidden />
      Subscribe on YouTube
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function MapsTeaser({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <Section
      id="maps"
      title="Map guides"
      description={`Matchup win rates and the best openers on ${fmtCount(count)} ladder maps.`}
    >
      <Link href={guidePaths.maps()} className={GUIDE_SECONDARY_ACTION_CLASS}>
        Browse map guides
        <ArrowRight className="h-4 w-4" aria-hidden />
      </Link>
    </Section>
  );
}

export function GuideHub({ payload }: { payload: GuideIndexPayload }) {
  return (
    <div className="space-y-10">
      <GuideJsonLd items={[breadcrumbJsonLd([{ name: "Guides", path: guidePaths.hub() }])]} />
      <div className="space-y-2">
        <PageHeader
          eyebrow="Build order guides"
          title="What's winning on the SC2 ladder"
          description={`Every opener ranked by its real ladder win rate from SC2 Tools players, ${eraLabel(payload.era, payload.patch)}. Pick a matchup to see timings, army and how to beat each opponent opener.`}
        />
        {payload.computedAt ? (
          <p className="text-caption text-text-dim">Stats updated {fmtGuideDate(payload.computedAt)}</p>
        ) : null}
      </div>
      <Section id="matchups" title="Matchups">
        <MatchupGrid matchups={payload.matchups} />
      </Section>
      <GuideVideoRow
        id="channel"
        title="From the channel"
        videos={payload.videos}
        actions={<SubscribeLink channel={payload.channel} />}
      />
      <MapsTeaser count={payload.maps.length} />
    </div>
  );
}
