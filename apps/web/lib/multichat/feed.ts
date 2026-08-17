// Multichat feed — pure merge/store helpers. No I/O, no React.

import type { ChatEvent } from "./events";
import type { ChatMessage, ChatPlatform } from "./types";

/** Hard cap on retained messages — OBS sources run for hours. */
export const FEED_CAP = 200;

/** A display row in the unified, chronological chat/event timeline. */
export type ChatDisplayItem =
  | { rowType: "message"; item: ChatMessage }
  | { rowType: "event"; item: ChatEvent };

/**
 * Merge messages and normalized platform events for presentation only.
 *
 * Keeping this separate from the message feed is deliberate: callers can
 * render follows/subs/gifts in chronological context without accidentally
 * passing those events through message-only effects such as TTS, dings,
 * commands, or translation.
 */
export function mergeDisplayFeed(
  messages: ReadonlyArray<ChatMessage>,
  events: ReadonlyArray<ChatEvent>,
  cap: number = Number.POSITIVE_INFINITY,
): ChatDisplayItem[] {
  const rows: Array<{ row: ChatDisplayItem; sourceOrder: number }> = [
    ...messages.map((item, sourceOrder) => ({
      row: { rowType: "message" as const, item },
      sourceOrder,
    })),
    ...events.map((item, eventOrder) => ({
      row: { rowType: "event" as const, item },
      sourceOrder: messages.length + eventOrder,
    })),
  ];

  rows.sort(
    (a, b) =>
      a.row.item.atMs - b.row.item.atMs || a.sourceOrder - b.sourceOrder,
  );
  const merged = rows.map(({ row }) => row);
  if (!Number.isFinite(cap)) return merged;
  const boundedCap = Math.max(0, Math.trunc(cap));
  return merged.length > boundedCap
    ? merged.slice(merged.length - boundedCap)
    : merged;
}

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
