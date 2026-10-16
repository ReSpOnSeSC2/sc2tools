import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { GuideEightWorkerVideos } from "@/components/guides/GuideEightWorkerVideos";
import { GuideJsonLd } from "@/components/guides/GuideJsonLd";
import { GuideVideoRow } from "@/components/guides/GuideVideoRow";
import { GuideVideoActions } from "@/components/guides/GuideVideoActions";
import { MatchupGrid } from "@/components/guides/hub/MatchupGrid";
import { guidePaths } from "@/components/guides/guideMetadata";
import { breadcrumbJsonLd } from "@/components/guides/guideSeo";
import { GUIDE_SECONDARY_ACTION_CLASS, eraLabel } from "@/components/guides/guideUi";
import { fmtCount, fmtGuideDate } from "@/lib/guides/format";
import type { GuideIndexPayload } from "@/lib/guides/types";

/**
 * Body of /guides: the 3×3 matchup grid with each matchup's top openers
 * with 12 starting workers,
 * the latest 12-worker build-order videos from the channel (+ playlist
 * and subscribe links), the way into the map guides and, last and
 * collapsed, the channel's videos from the 8-worker patch.
 */

/** Shown while the channel has no 12-worker build-order video yet. */
const NO_TWELVE_WORKER_VIDEOS =
  "Build order videos for the 12-worker game are on the way. Subscribe to catch the first ones.";
const VIDEO_PREVIEW_LIMIT = 8;

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
          description={`Every opener ranked by its real ladder win rate from SC2 Tools players, ${eraLabel(payload.era)}. Pick a matchup to see timings, army and how to beat each opponent opener.`}
        />
        {payload.computedAt ? (
          <p className="text-caption text-text-dim">Stats updated {fmtGuideDate(payload.computedAt)}</p>
        ) : null}
      </div>
      <Section id="matchups" title="Matchups">
        <MatchupGrid matchups={payload.matchups} period={eraLabel(payload.era)} />
      </Section>
      <GuideVideoRow
        id="channel"
        title="12-worker build order videos"
        videos={payload.videos.slice(0, VIDEO_PREVIEW_LIMIT)}
        emptyText={payload.channel ? NO_TWELVE_WORKER_VIDEOS : undefined}
        actions={
          <GuideVideoActions channel={payload.channel} playlists={payload.playlists} showAll />
        }
      />
      <MapsTeaser count={payload.maps.length} />
      <GuideEightWorkerVideos
        videos={payload.eightWorkerVideos}
        playlistUrl={payload.playlists?.eightWorker}
      />
    </div>
  );
}
