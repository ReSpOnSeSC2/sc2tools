import type { LiveGameEnvelope } from "./types";

/** Links arrive from the cloud's approved exact identity lookup. Revalidate the
 * URL scheme/host at the display boundary; never form a channel from a name. */
export function OpponentStreamChip({ live }: { live?: LiveGameEnvelope | null }) {
  if (!live || live.isReplay || !["match_loading", "match_started", "match_in_progress"].includes(live.phase)) return null;
  for (const platform of ["twitch", "youtube"] as const) {
    const raw = live.opponentChannels?.[platform];
    if (typeof raw !== "string" || raw.length > 300) continue;
    let url; try { url = new URL(raw); } catch { continue; }
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || host !== (platform === "twitch" ? "twitch.tv" : "youtube.com") || !url.pathname || url.pathname === "/") continue;
    return <a href={url.href} target="_blank" rel="noopener noreferrer" style={{ display: "block", padding: "3px 10px", fontSize: 12, color: "inherit", textDecoration: "underline", overflowWrap: "anywhere" }}>Streams on {platform === "twitch" ? "Twitch" : "YouTube"} {url.pathname}</a>;
  }
  return null;
}
