import { PageHeader } from "@/components/ui/PageHeader";
import { GuideBreadcrumbs } from "@/components/guides/GuideBreadcrumbs";
import { GuideEightWorkerVideos } from "@/components/guides/GuideEightWorkerVideos";
import { GuideJsonLd } from "@/components/guides/GuideJsonLd";
import { GuideVideoActions } from "@/components/guides/GuideVideoActions";
import { GuideVideoRow } from "@/components/guides/GuideVideoRow";
import { guidePaths } from "@/components/guides/guideMetadata";
import { breadcrumbJsonLd, type GuideCrumb } from "@/components/guides/guideSeo";
import { fmtCountNoun } from "@/lib/guides/format";
import type { GuideVideosPayload } from "@/lib/guides/types";

const VIDEO_CRUMBS: GuideCrumb[] = [
  { name: "Guides", path: guidePaths.hub() },
  { name: "Videos", path: guidePaths.videos() },
];

export function GuideVideosList({ payload }: { payload: GuideVideosPayload }) {
  return (
    <div className="space-y-8">
      <GuideJsonLd items={[breadcrumbJsonLd(VIDEO_CRUMBS)]} />
      <GuideBreadcrumbs crumbs={VIDEO_CRUMBS} />
      <PageHeader
        eyebrow="Build order guides"
        title="All build order videos"
        description={`${fmtCountNoun(payload.videos.length, "video")} for the 12-worker game, newest first.`}
      />
      <GuideVideoRow
        id="channel"
        title="12-worker build order videos"
        videos={payload.videos}
        emptyText="No 12-worker build order videos yet. Check back for new videos."
        actions={<GuideVideoActions channel={payload.channel} playlists={payload.playlists} />}
      />
      <GuideEightWorkerVideos
        videos={payload.eightWorkerVideos}
        playlistUrl={payload.playlists?.eightWorker}
      />
    </div>
  );
}
