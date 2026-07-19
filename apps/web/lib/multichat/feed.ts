// Multichat feed — pure merge/store helpers. No I/O, no React.

import type { ChatPlatform } from "./types";

/** Hard cap on retained messages — OBS sources run for hours. */
export const FEED_CAP = 200;

/**
 * Append a batch to the feed: dedupe on (platform, id), keep arrival
 * order, trim from the front past `cap`. Returns the SAME array when
 * nothing changed so React state updates can bail cheaply. Generic
 * over the item shape so messages and events share one store.
 */
export function appendMessages<T extends { platform: ChatPlatform; id: string }>(
  feed: ReadonlyArray<T>,
  incoming: ReadonlyArray<T>,
  cap: number = FEED_CAP,
): T[] {
  if (incoming.length === 0) return feed as T[];
  const seen = new Set(feed.map((m) => `${m.platform}:${m.id}`));
  const fresh: T[] = [];
  for (const m of incoming) {
    const key = `${m.platform}:${m.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(m);
  }
  if (fresh.length === 0) return feed as T[];
  const merged = [...feed, ...fresh];
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

/**
 * Deterministic readable fallback colour for authors on platforms that
 * don't provide one (YouTube, TikTok, colourless Twitch users). Fixed
 * saturation/lightness keeps every hue legible on the dark overlay.
 */
export function fallbackColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return `hsl(${h % 360} 65% 70%)`;
}
