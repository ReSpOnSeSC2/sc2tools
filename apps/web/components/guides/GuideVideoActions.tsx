import Link from "next/link";
import { Youtube } from "lucide-react";
import { guidePaths } from "@/components/guides/guideMetadata";
import { GUIDE_SECONDARY_ACTION_CLASS } from "@/components/guides/guideUi";
import { safeChannelUrl, safePlaylistUrl } from "@/components/guides/youtubeUrls";
import type { GuideChannel, GuidePlaylists } from "@/lib/guides/types";

export function GuideVideoActions({
  channel,
  playlists,
  showAll = false,
}: {
  channel: GuideChannel | null;
  playlists?: GuidePlaylists | null;
  showAll?: boolean;
}) {
  const playlist = safePlaylistUrl(playlists?.twelveWorker);
  const subscribe = safeChannelUrl(channel?.url);
  return (
    <>
      {showAll ? (
        <Link
          href={guidePaths.videos()}
          className={GUIDE_SECONDARY_ACTION_CLASS}
        >
          View all videos
        </Link>
      ) : null}
      {playlist ? (
        <a href={playlist} target="_blank" rel="noopener noreferrer" className={GUIDE_SECONDARY_ACTION_CLASS}>
          Watch the playlist
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : null}
      {subscribe ? (
        <a href={subscribe} target="_blank" rel="noopener noreferrer" className={GUIDE_SECONDARY_ACTION_CLASS}>
          <Youtube className="h-4 w-4" aria-hidden />
          Subscribe on YouTube
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : null}
    </>
  );
}
