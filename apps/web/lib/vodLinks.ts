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
