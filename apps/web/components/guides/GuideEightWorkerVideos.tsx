import { GUIDE_LINK_CLASS } from "@/components/guides/guideUi";
import { safePlaylistUrl, safeVideoUrls } from "@/components/guides/youtubeUrls";
import { fmtGuideDate } from "@/lib/guides/format";
import type { GuideVideo } from "@/lib/guides/types";

/**
 * The channel's videos from the 8-worker patch 5.0.16, kept apart from
 * the 12-worker videos and deliberately low-key: a collapsed list of
 * plain links (no thumbnails, no player) at the foot of the hub, matchup,
 * build and counter pages. New videos are recorded with 12 starting
 * workers, so those stay the prominent section. Renders nothing without
 * videos.
 */
const SUMMARY_CLASS =
  "min-h-11 cursor-pointer rounded py-3 text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

interface VideoLink {
  video: GuideVideo;
  href: string;
}

function toLinks(videos: ReadonlyArray<GuideVideo>): VideoLink[] {
  const links: VideoLink[] = [];
  for (const video of videos) {
    const href = safeVideoUrls(video).watch;
    if (href) links.push({ video, href });
  }
  return links;
}

export function GuideEightWorkerVideos({
  videos,
  title = "8-worker patch videos",
  playlistUrl,
  id = "eight-worker-videos",
}: {
  videos: ReadonlyArray<GuideVideo> | null | undefined;
  title?: string;
  /** The channel's 8-worker playlist, when one is configured. */
  playlistUrl?: string | null;
  id?: string;
}) {
  const links = toLinks(videos ?? []);
  if (links.length === 0) return null;
  const playlist = safePlaylistUrl(playlistUrl);
  return (
    <section id={id} className="border-t border-border pt-4">
      <details>
        <summary className={SUMMARY_CLASS}>
          <h2 className="inline text-caption font-semibold">{title}</h2>{" "}
          <span className="text-caption text-text-dim">({links.length})</span>
        </summary>
        <div className="space-y-3 pb-2">
          <p className="text-caption text-text-dim">
            Recorded on patch 5.0.16, when games started with 8 workers. Their build orders and
            timings differ from the 12-worker game.
          </p>
          <ul className="space-y-1 text-caption">
            {links.map(({ video, href }) => (
              <li key={video.youtubeId}>
                <a href={href} target="_blank" rel="noopener noreferrer" className={GUIDE_LINK_CLASS}>
                  {video.title}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>{" "}
                {video.publishedAt ? (
                  <span className="text-text-dim">· {fmtGuideDate(video.publishedAt)}</span>
                ) : null}
              </li>
            ))}
          </ul>
          {playlist ? (
            <p className="text-caption">
              <a href={playlist} target="_blank" rel="noopener noreferrer" className={GUIDE_LINK_CLASS}>
                8-worker build order playlist on YouTube
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </p>
          ) : null}
        </div>
      </details>
    </section>
  );
}
