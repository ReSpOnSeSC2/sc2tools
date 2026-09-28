"use client";

/* eslint-disable @next/next/no-img-element */

import { useState } from "react";
import { Play } from "lucide-react";
import { safeVideoUrls } from "@/components/guides/youtubeUrls";
import type { GuideVideo } from "@/lib/guides/types";

/**
 * YouTubeFacade — a click-to-load YouTube player. Until the viewer
 * clicks, the page shows only the video thumbnail (lazy <img>) and a
 * play button: no player script, no iframe and no YouTube cookies. The
 * click swaps in a privacy-enhanced (youtube-nocookie) iframe that
 * autoplays. A plain "Watch on YouTube" link is always present, so the
 * video is reachable without JS.
 *
 * The 16:9 box reserves its height up front (no layout shift).
 */

const EMBED_PARAMS = "autoplay=1&rel=0";
const THUMB_WIDTH = 480;
const THUMB_HEIGHT = 360;

export type YouTubeFacadeVideo = Pick<
  GuideVideo,
  "youtubeId" | "title" | "url" | "thumbnailUrl" | "embedUrl"
>;

export function YouTubeFacade({ video }: { video: YouTubeFacadeVideo }) {
  const [isPlaying, setIsPlaying] = useState(false);
  const urls = safeVideoUrls(video);
  return (
    <div className="space-y-2">
      <div className="relative aspect-video w-full overflow-hidden rounded-xl border-2 border-line bg-bg-elevated shadow-hard">
        {isPlaying && urls.embed ? (
          <iframe
            src={`${urls.embed}?${EMBED_PARAMS}`}
            title={video.title}
            allow="autoplay; encrypted-media; picture-in-picture"
            // YouTube's embed refuses to play without a Referer; pin the
            // browser default so a future site-wide no-referrer can't break it.
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
            className="absolute inset-0 h-full w-full"
          />
        ) : (
          <button
            type="button"
            onClick={() => setIsPlaying(true)}
            disabled={!urls.embed}
            aria-label={`Play ${video.title} on YouTube`}
            className="group absolute inset-0 flex h-full w-full items-center justify-center focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-accent"
          >
            {urls.thumb ? (
              <img
                src={urls.thumb}
                alt=""
                width={THUMB_WIDTH}
                height={THUMB_HEIGHT}
                loading="lazy"
                decoding="async"
                className="absolute inset-0 h-full w-full object-cover"
              />
            ) : null}
            <span className="relative flex h-14 w-14 items-center justify-center rounded-full border-2 border-line bg-danger text-white shadow-hard motion-safe:transition-transform motion-safe:group-hover:scale-105">
              <Play className="ml-0.5 h-6 w-6 fill-current" aria-hidden />
            </span>
          </button>
        )}
      </div>
      {urls.watch ? (
        <a
          href={urls.watch}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex text-caption font-semibold text-accent-cyan underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Watch on YouTube
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : null}
    </div>
  );
}
