// Multichat events — platform happenings (subs, gift subs, raids,
// memberships, superchats, TikTok gifts/follows) parsed from the SAME
// chat transports the message feed uses. No extra auth, no new
// connections: engines spot event frames in the streams they already
// hold and normalise them here, so everything downstream is
// platform-agnostic — exactly like ChatMessage.

import type { ChatPlatform } from "./types";

export type ChatEventKind =
  | "sub"
  | "resub"
  | "giftsub"
  | "raid"
  | "member"
  | "superchat"
  | "gift"
  | "follow"
  | "cheer"
  | "share"
  | "reward";

export const CHAT_EVENT_KINDS: readonly ChatEventKind[] = [
  "sub",
  "resub",
  "giftsub",
  "raid",
  "member",
  "superchat",
  "gift",
  "follow",
  "cheer",
  "share",
  "reward",
] as const;

/** Narrow an untrusted wire value (relay payloads) to a known kind. */
export function isChatEventKind(value: unknown): value is ChatEventKind {
  return CHAT_EVENT_KINDS.includes(value as ChatEventKind);
}

export interface ChatEvent {
  platform: ChatPlatform;
  /** Platform-scoped id — deduped on (platform, id). */
  id: string;
  kind: ChatEventKind;
  user: string;
  /** Human line, e.g. "resubscribed for 8 months". */
  detail: string;
  /** e.g. gift count, raid party size, superchat amount string. */
  amount?: string;
  atMs: number;
  /**
   * When SC2 Tools first received the provider action. This can be newer than
   * ``atMs`` (notably for YouTube's delayed public-subscriber feed) and lets a
   * late/reconnected alert surface distinguish a missed live alert from old
   * retained history.
   */
  receivedAtMs?: number;
  /**
   * True when a shared relay is catching a late surface up. Replayed events
   * still belong in the unified chat/Dock timeline, but must not fire a
   * second prominent alert or sound.
   */
  replayed?: boolean;
  /**
   * True for a signed provider notification delivered by SC2 Tools.
   * Public chat transports leave this unset so one public + one official
   * observation can be paired without collapsing two same-origin actions.
   */
  official?: boolean;
  /** Internal one-to-one marker after an official/public pair is consumed. */
  transportPaired?: boolean;
  /** Bounded transport-id aliases retained after pairing for retry/replay. */
  alternateIds?: string[];
  /** Stable identity for a cumulative event whose displayed total can update. */
  updateKey?: string;
  /** Monotonic cumulative revision within `updateKey`. */
  updateVersion?: number;
  /** Semantic fingerprint shared by two transports observing one action. */
  dedupeKey?: string;
  /** Maximum occurrence-time distance for matching `dedupeKey` copies. */
  dedupeWindowMs?: number;
}

/** Stable cross-surface identity used for queues, sounds, and reporting. */
export function chatEventIdentity(event: ChatEvent): string {
  return `${event.platform}:${event.updateKey || event.id}`;
}

/**
 * Append ordinary events once and replace cumulative events (for example a
 * YouTube Jewels combo) in place. This yields one row/toast/sound whose amount
 * updates, instead of counting cumulative totals as independent donations.
 */
export function appendEvents(
  current: ReadonlyArray<ChatEvent>,
  incoming: ReadonlyArray<ChatEvent>,
  cap: number = EVENT_CAP,
): ChatEvent[] {
  let changed = false;
  const next = [...current];
  const exactIds = new Set(current.flatMap(exactEventKeys));
  const updateIndexes = new Map<string, number>();
  next.forEach((event, index) => {
    if (event.updateKey) updateIndexes.set(chatEventIdentity(event), index);
  });

  for (const event of incoming) {
    const eventExactIds = exactEventKeys(event);
    const exactId = `${event.platform}:${event.id}`;
    if (eventExactIds.some((id) => exactIds.has(id))) continue;
    if (event.dedupeKey) {
      const windowMs = Math.max(
        0,
        Math.min(10 * 60 * 1000, Number(event.dedupeWindowMs) || 0),
      );
      const incomingIsOfficial = event.official === true;
      let duplicateIndex = -1;
      let closestDistance = Number.POSITIVE_INFINITY;
      next.forEach((previous, index) => {
        const distance = Math.abs(previous.atMs - event.atMs);
        if (
          previous.platform === event.platform
          && previous.dedupeKey === event.dedupeKey
          && previous.transportPaired !== true
          && event.transportPaired !== true
          && (previous.official === true) !== incomingIsOfficial
          && distance <= windowMs
          && distance < closestDistance
        ) {
          duplicateIndex = index;
          closestDistance = distance;
        }
      });
      if (duplicateIndex !== -1) {
        const previous = next[duplicateIndex];
        // The provider record is already durable server-side. If public chat
        // arrived first, merge official fields into that same client identity
        // so cards, sounds and XP reporters do not see a second action.
        if (incomingIsOfficial && previous.official !== true) {
          next[duplicateIndex] = {
            ...previous,
            ...event,
            id: previous.id,
            atMs: previous.atMs,
            official: true,
            transportPaired: true,
            alternateIds: pairedAlternateIds(previous, event),
          };
          exactIds.add(exactId);
          changed = true;
        } else if (previous.transportPaired !== true) {
          next[duplicateIndex] = {
            ...previous,
            transportPaired: true,
            alternateIds: pairedAlternateIds(previous, event),
          };
          exactIds.add(exactId);
          changed = true;
        }
        continue;
      }
    }
    const identity = chatEventIdentity(event);
    const replaceIndex = event.updateKey ? updateIndexes.get(identity) : undefined;
    if (replaceIndex !== undefined) {
      const previous = next[replaceIndex];
      if (
        Number(event.updateVersion || 0) <=
        Number(previous.updateVersion || 0)
      ) {
        if (
          Number(event.updateVersion || 0) === Number(previous.updateVersion || 0)
          && event.official === true
          && previous.official !== true
        ) {
          next[replaceIndex] = {
            ...previous,
            ...event,
            id: previous.id,
            atMs: previous.atMs,
            official: true,
            alternateIds: pairedAlternateIds(previous, event),
          };
          exactIds.add(exactId);
          changed = true;
        }
        continue;
      }
      for (const previousId of exactEventKeys(previous)) exactIds.delete(previousId);
      for (const incomingId of eventExactIds) exactIds.add(incomingId);
      next[replaceIndex] = event;
      changed = true;
      continue;
    }
    updateIndexes.set(identity, next.length);
    for (const incomingId of eventExactIds) exactIds.add(incomingId);
    next.push(event);
    changed = true;
  }

  if (!changed) return current as ChatEvent[];
  const safeCap = Math.max(0, Math.floor(Number(cap) || 0));
  return next.length > safeCap ? next.slice(next.length - safeCap) : next;
}

function exactEventKeys(event: ChatEvent): string[] {
  return [event.id, ...(Array.isArray(event.alternateIds) ? event.alternateIds : [])]
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .slice(0, 9)
    .map((id) => `${event.platform}:${id}`);
}

function pairedAlternateIds(previous: ChatEvent, incoming: ChatEvent): string[] {
  return Array.from(new Set([
    ...(Array.isArray(previous.alternateIds) ? previous.alternateIds : []),
    incoming.id,
    ...(Array.isArray(incoming.alternateIds) ? incoming.alternateIds : []),
  ]))
    .filter((id) => id && id !== previous.id)
    .slice(0, 8);
}

/** Short per-kind labels for event widgets/badges. */
export const EVENT_KIND_LABEL: Record<ChatEventKind, string> = {
  sub: "Sub",
  resub: "Resub",
  giftsub: "Gift subs",
  raid: "Raid",
  member: "Member",
  superchat: "Super Chat",
  gift: "Gift",
  follow: "Follow",
  cheer: "Cheer",
  share: "Share",
  reward: "Reward",
};

/** Hard cap on retained events — a log widget wants recency, not history. */
export const EVENT_CAP = 50;
