/** Convert milliseconds to "H:MM:SS" (or "MM:SS" under an hour). */
export function formatOffset(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const min = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h > 0
    ? `${h}:${String(min).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${min}:${String(s).padStart(2, "0")}`;
}

/** Only marked moments at least ten seconds apart qualify for YouTube chapters. */
export function toYouTubeChapters(moments: ReadonlyArray<{ atMs: number; reason: string }>, streamStartMs: number | null): string[] {
  if (streamStartMs === null || !Number.isFinite(streamStartMs)) return [];
  const chapters = ["0:00 Stream start"];
  let previousMs = 0;
  for (const moment of [...moments].sort((a, b) => a.atMs - b.atMs)) {
    const offset = moment.atMs - streamStartMs;
    if (!Number.isFinite(offset) || offset < previousMs + 10_000) continue;
    const title = moment.reason.replace(/[\r\n\u2028\u2029]+/gu, " ").trim().slice(0, 100) || "Clip moment";
    chapters.push(`${formatOffset(offset)} ${title}`);
    previousMs = offset;
  }
  return chapters;
}

/**
 * Deep-link a VOD at an offset. Twitch uses an h/m/s value while
 * YouTube accepts seconds. Unknown hosts remain ordinary links.
 */
export function vodLinkAt(vodUrl: string, offsetMs: number): string {
  let url: URL;
  try {
    url = new URL(vodUrl);
  } catch {
    return vodUrl;
  }

  const totalSec = Math.max(0, Math.floor(offsetMs / 1000));
  const host = url.hostname.replace(/^www\./, "");
  if (host === "twitch.tv" || host.endsWith(".twitch.tv")) {
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    url.searchParams.set("t", `${h}h${m}m${s}s`);
    return url.toString();
  }
  if (
    host === "youtube.com"
    || host.endsWith(".youtube.com")
    || host === "youtu.be"
  ) {
    url.searchParams.set("t", `${totalSec}s`);
    return url.toString();
  }
  return url.toString();
}
