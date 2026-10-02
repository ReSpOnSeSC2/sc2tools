/* eslint-disable @next/next/no-img-element */

import type { ReactNode } from "react";
import { Section } from "@/components/ui/Section";
import { GUIDE_PANEL_CLASS } from "@/components/guides/guideUi";
import { safeVideoUrls } from "@/components/guides/youtubeUrls";
import { fmtGuideDate } from "@/lib/guides/format";
import type { GuideVideo } from "@/lib/guides/types";

/**
 * A row of channel videos (hub "12-worker build order videos", matchup
 * "Latest … videos"): lazy thumbnails linking out to YouTube. Links only,
 * no player, so nothing loads from YouTube except the thumbnails. Without
 * videos it renders nothing, or just the header and `emptyText` when the
 * caller passes one (the hub keeps its Subscribe and playlist links).
 */
const THUMB_WIDTH = 480;
const THUMB_HEIGHT = 360;

interface VideoLink {
  video: GuideVideo;
  href: string;
  thumb: string | null;
}

function toLinks(videos: ReadonlyArray<GuideVideo>): VideoLink[] {
  const links: VideoLink[] = [];
  for (const video of videos) {
    const urls = safeVideoUrls(video);
    if (urls.watch) links.push({ video, href: urls.watch, thumb: urls.thumb });
  }
  return links;
}

export function GuideVideoRow({
  title,
  videos,
  actions,
  id,
  emptyText,
}: {
  title: string;
  videos: ReadonlyArray<GuideVideo>;
  actions?: ReactNode;
  id?: string;
  /** Shown instead of the row when there are no videos. */
  emptyText?: string;
}) {
  const links = toLinks(videos);
  if (links.length === 0) {
    if (!emptyText) return null;
    return (
      <Section title={title} actions={actions} id={id}>
        <p className="text-body text-text-muted">{emptyText}</p>
      </Section>
    );
  }
  return (
    <Section title={title} actions={actions} id={id}>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {links.map(({ video, href, thumb }) => (
          <li key={video.youtubeId} className="min-w-0">
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className={`${GUIDE_PANEL_CLASS} group block overflow-hidden hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg`}
            >
              <span className="relative block aspect-video bg-bg-elevated">
                {thumb ? (
                  <img
                    src={thumb}
                    alt=""
                    width={THUMB_WIDTH}
                    height={THUMB_HEIGHT}
                    loading="lazy"
                    decoding="async"
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                ) : null}
              </span>
              <span className="block space-y-1 p-3">
                <span className="line-clamp-2 block text-caption font-semibold text-text group-hover:underline">
                  {video.title}
                </span>
                <span className="block text-micro text-text-dim">
                  {video.publishedAt ? `${fmtGuideDate(video.publishedAt)} · YouTube` : "YouTube"}
                  <span className="sr-only"> (opens in a new tab)</span>
                </span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </Section>
  );
}
