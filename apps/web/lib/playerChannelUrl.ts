/** Validate canonical public channel links before rendering them in any surface. */
export function safeChannelUrl(raw: unknown, platform: "twitch" | "youtube"): string | null {
  if (typeof raw !== "string" || raw.length > 300) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const path = url.pathname.replace(/\/+$/, "");
    const legacyYouTube = /^\/[A-Za-z0-9._-]{1,100}$/.test(path)
      && !["watch", "shorts", "live", "feed", "results", "playlist", "playlists", "gaming", "premium", "account", "subscriptions", "upload", "features", "embed", "redirect", "oops", "error", "logout", "signin", "channel", "user", "c", "about", "t", "reporthistory", "paid_memberships"].includes(path.slice(1).toLowerCase());
    const valid = platform === "twitch"
      ? host === "twitch.tv" && /^\/[a-zA-Z0-9_]{1,25}$/.test(path) && !/^\/(videos|directory|downloads|jobs|p|settings|search|subscriptions|inventory|wallet|login|signup|turbo)$/i.test(path)
      : host === "youtube.com" && (legacyYouTube || /^\/(?:@[\p{L}\p{N}._%-]{1,100}|channel\/UC[a-zA-Z0-9_-]{22}|(?:c|user)\/[a-zA-Z0-9_.-]{1,100})$/u.test(path));
    if (!valid) return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch { return null; }
}
