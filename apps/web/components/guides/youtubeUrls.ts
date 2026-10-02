/**
 * Shape checks for the channel video URLs the API ships (§8 Video:
 * watch / thumbnail / nocookie embed URLs built from an 11-char id, plus
 * the channel and playlist links).
 * Guide components only ever render first-party YouTube URLs of exactly
 * these shapes; anything else is dropped (null), never rendered.
 * Plain module (no "use client") so server and client code can share it.
 */
import type { GuideVideo } from "@/lib/guides/types";

const EMBED_URL_RE = /^https:\/\/www\.youtube-nocookie\.com\/embed\/[A-Za-z0-9_-]{11}$/;
const WATCH_URL_RE = /^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/;
const THUMB_URL_RE = /^https:\/\/i\.ytimg\.com\/vi\/[A-Za-z0-9_-]{11}\/[a-z]+\.jpg$/;
const CHANNEL_URL_RE = /^https:\/\/www\.youtube\.com\/(@[A-Za-z0-9_.-]{1,100}|channel\/[A-Za-z0-9_-]{1,64})$/;
const PLAYLIST_URL_RE = /^https:\/\/www\.youtube\.com\/playlist\?list=[A-Za-z0-9_-]{13,64}$/;

export interface SafeVideoUrls {
  embed: string | null;
  watch: string | null;
  thumb: string | null;
}

/**
 * Validated URLs of a video.
 *
 * Example: `safeVideoUrls(video).embed` →
 * "https://www.youtube-nocookie.com/embed/YcTMc_Ee11w".
 */
export function safeVideoUrls(
  video: Pick<GuideVideo, "url" | "thumbnailUrl" | "embedUrl">,
): SafeVideoUrls {
  return {
    embed: EMBED_URL_RE.test(video.embedUrl) ? video.embedUrl : null,
    watch: WATCH_URL_RE.test(video.url) ? video.url : null,
    thumb: THUMB_URL_RE.test(video.thumbnailUrl) ? video.thumbnailUrl : null,
  };
}

/**
 * The channel URL when it is a youtube.com channel/handle URL, else null.
 *
 * Example: `safeChannelUrl("https://www.youtube.com/@ReSpOnSeSC2")` → same string.
 */
export function safeChannelUrl(url: string | null | undefined): string | null {
  return typeof url === "string" && CHANNEL_URL_RE.test(url) ? url : null;
}

/**
 * The playlist URL when it is a canonical youtube.com playlist URL, else null.
 *
 * Example: `safePlaylistUrl("https://www.youtube.com/playlist?list=PLAAAAAAAAAAAAAAAA")` → same string.
 */
export function safePlaylistUrl(url: string | null | undefined): string | null {
  return typeof url === "string" && PLAYLIST_URL_RE.test(url) ? url : null;
}
