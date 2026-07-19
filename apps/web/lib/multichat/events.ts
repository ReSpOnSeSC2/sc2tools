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
  | "follow";

export const CHAT_EVENT_KINDS: readonly ChatEventKind[] = [
  "sub",
  "resub",
  "giftsub",
  "raid",
  "member",
  "superchat",
  "gift",
  "follow",
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
};

/** Hard cap on retained events — a log widget wants recency, not history. */
export const EVENT_CAP = 50;
