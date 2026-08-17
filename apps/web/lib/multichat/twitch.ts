// Twitch chat engine — anonymous read-only IRC over WebSocket.
//
// Twitch's chat gateway accepts anonymous "justinfan" logins for
// read-only access: no OAuth, no API key, just the channel name.
// (Verified live: CAP REQ tags → NICK justinfanNNNNN → JOIN #chan
// streams real PRIVMSGs with full tag metadata.)
//
// The parser is pure and unit-tested; the engine wraps it with the
// socket lifecycle: PING/PONG keepalive and auto-reconnect with
// exponential backoff so an OBS scene left open all day self-heals.

import { twitchEmoteUrl, type ChatEmote } from "./emotes";
import type { ChatEvent, ChatEventKind } from "./events";
import type { ChatBadge, ChatEngine, EngineCallbacks } from "./types";

export const TWITCH_IRC_URL = "wss://irc-ws.chat.twitch.tv:443";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
/**
 * Community gift children normally follow their summary on the same ordered
 * IRC socket. Hold a linked child briefly so a source that joins mid-bundle
 * can still recognize it when the summary was genuinely missed, without
 * rendering/sounding both the summary and every child in the normal case.
 */
const COMMUNITY_GIFT_CHILD_WAIT_MS = 1500;
const COMMUNITY_GIFT_ORIGIN_CAP = 256;

export interface ParsedTwitchMessage {
  id: string;
  user: string;
  text: string;
  color?: string;
  badges: ChatBadge[];
  atMs: number;
  /** Emotes present in `text` — only set when the message carries any. */
  emotes?: ChatEmote[];
  /** Dedicated supporter event emitted alongside this chat line. */
  pairedEventKind?: ChatEventKind;
}

/** Parse the IRCv3 tag prefix ("@a=1;b=2 ...") into a map. */
export function parseIrcTags(tagPart: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const pair of tagPart.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    tags[pair.slice(0, eq)] = pair
      .slice(eq + 1)
      // IRCv3 escaping: \s = space, \: = ';', \\ = backslash.
      .replace(/\\s/g, " ")
      .replace(/\\:/g, ";")
      .replace(/\\\\/g, "\\");
  }
  return tags;
}

/** Map the Twitch `badges` tag to normalised badge tags. */
export function twitchBadgeTags(badgesTag: string | undefined): ChatBadge[] {
  if (!badgesTag) return [];
  const out: ChatBadge[] = [];
  for (const entry of badgesTag.split(",")) {
    const name = entry.split("/")[0];
    if (name === "broadcaster") out.push("owner");
    else if (name === "moderator") out.push("moderator");
    else if (name === "subscriber" || name === "founder") out.push("member");
    else if (name === "vip") out.push("vip");
    else if (name === "partner") out.push("verified");
  }
  return out;
}

/**
 * Parse the IRC `emotes=` tag ("id:start-end,start-end/id:start-end")
 * against the message text into renderable emotes. Ranges are
 * inclusive CODE-POINT offsets (Twitch counts characters, not UTF-16
 * units — emoji before an emote would skew a .slice()). Only the
 * first range per id is needed to learn the code; codes dedupe.
 */
export function parseTwitchEmotesTag(
  emotesTag: string | undefined,
  text: string,
): ChatEmote[] {
  if (!emotesTag) return [];
  const chars = Array.from(text);
  const out: ChatEmote[] = [];
  const seen = new Set<string>();
  for (const entry of emotesTag.split("/")) {
    const colon = entry.indexOf(":");
    if (colon <= 0) continue;
    const id = entry.slice(0, colon);
    const firstRange = entry.slice(colon + 1).split(",")[0];
    const m = /^(\d+)-(\d+)$/.exec(firstRange || "");
    if (!m) continue;
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (start > end || end >= chars.length) continue;
    const code = chars.slice(start, end + 1).join("");
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push({ code, url: twitchEmoteUrl(id) });
  }
  return out;
}

/**
 * Parse one raw IRC line into a chat message, or null for anything
 * that isn't a user PRIVMSG (JOINs, NOTICEs, ROOMSTATE, …).
 */
export function parseTwitchMessage(line: string): ParsedTwitchMessage | null {
  if (!line.includes(" PRIVMSG #")) return null;
  let tags: Record<string, string> = {};
  let rest = line;
  if (rest.startsWith("@")) {
    const space = rest.indexOf(" ");
    if (space === -1) return null;
    tags = parseIrcTags(rest.slice(1, space));
    rest = rest.slice(space + 1);
  }
  // :nick!nick@nick.tmi.twitch.tv PRIVMSG #chan :text
  const m = rest.match(/^:([^!\s]+)![^\s]*\s+PRIVMSG\s+#\S+\s+:(.*)$/);
  if (!m) return null;
  let text = m[2];
  // /me actions arrive as \x01ACTION <text>\x01.
  const action = text.match(/^ACTION (.*)$/);
  if (action) text = action[1];
  // Emote indices are relative to the user-typed text (post-ACTION
  // unwrap, pre-trim) — resolve codes before trimming shifts offsets.
  const emotes = parseTwitchEmotesTag(tags.emotes, text);
  text = text.trim();
  if (!text) return null;
  const ts = Number(tags["tmi-sent-ts"]);
  const bits = Number(tags.bits);
  return {
    id: tags.id || `${tags["tmi-sent-ts"] || Date.now()}-${m[1]}`,
    user: tags["display-name"] || m[1],
    text,
    color: /^#[0-9A-Fa-f]{6}$/.test(tags.color || "") ? tags.color : undefined,
    badges: twitchBadgeTags(tags.badges),
    atMs: Number.isFinite(ts) ? ts : Date.now(),
    // Omitted (not []) when absent — keeps emote-less parses toEqual
    // their pre-emote shape.
    ...(emotes.length > 0 ? { emotes } : {}),
    ...(Number.isInteger(bits) && bits > 0
      ? { pairedEventKind: "cheer" as const }
      : {}),
  };
}

/**
 * A Twitch cheer is a normal PRIVMSG with a positive `bits` IRC tag.
 * Keep the chat line and also emit a distinct event id so engagement
 * de-duplication cannot mistake the recognition event for its message.
 */
export function parseTwitchCheer(line: string): ChatEvent | null {
  if (!line.startsWith("@") || !line.includes(" PRIVMSG #")) return null;
  const space = line.indexOf(" ");
  if (space === -1) return null;
  const tags = parseIrcTags(line.slice(1, space));
  const bits = Number(tags.bits);
  if (!Number.isInteger(bits) || bits <= 0) return null;
  const message = parseTwitchMessage(line);
  if (!message) return null;
  return {
    platform: "twitch",
    id: `${message.id}:cheer`,
    kind: "cheer",
    user: message.user,
    detail: "cheered",
    amount: `${bits} ${bits === 1 ? "bit" : "bits"}`,
    atMs: message.atMs,
    dedupeKey: `support:cheer:${supportActorKey(message.user)}:${bits}:${supportShortHash(message.text)}`,
    dedupeWindowMs: 2 * 60 * 1000,
  };
}

/**
 * Parse one raw USERNOTICE line into a platform event, or null for
 * msg-ids we don't surface (announcements, rituals, …). USERNOTICEs
 * carry the acting user in tags (`login`/`display-name`), not the IRC
 * prefix (that's always tmi.twitch.tv), and may append a user-written
 * message after the trailing colon — deliberately ignored here, the
 * events feed wants the happening, not the caption.
 */
interface ParsedTwitchUserNotice {
  event: ChatEvent;
  notice: string;
  /** Twitch community-gift linkage shared by the summary and child notices. */
  giftOriginId?: string;
}

function parseTwitchUserNoticeEnvelope(
  line: string,
): ParsedTwitchUserNotice | null {
  if (!line.includes(" USERNOTICE #")) return null;
  let tags: Record<string, string> = {};
  let rest = line;
  if (rest.startsWith("@")) {
    const space = rest.indexOf(" ");
    if (space === -1) return null;
    tags = parseIrcTags(rest.slice(1, space));
    rest = rest.slice(space + 1);
  }
  if (!/^:\S+\s+USERNOTICE\s+#\S+/.test(rest)) return null;

  const notice = tags["msg-id"] || "";
  const anonymous = notice === "anonsubgift" || notice === "anonsubmysterygift";
  const login = tags.login || "";
  const user = tags["display-name"] || login || (anonymous ? "Anonymous" : "");
  if (!user) return null;

  let kind: ChatEvent["kind"];
  let detail: string;
  let amount: string | undefined;
  let eventUser = user;
  let dedupeSuffix = "";
  switch (notice) {
    case "sub":
      kind = "sub";
      detail = "subscribed";
      dedupeSuffix = `sub:${supportActorKey(user)}`;
      break;
    case "resub": {
      kind = "resub";
      const months = Number(tags["msg-param-cumulative-months"]);
      detail =
        Number.isFinite(months) && months > 0
          ? `subscribed for ${months} months`
          : "resubscribed";
      dedupeSuffix = `resub:${supportActorKey(user)}:${Number.isFinite(months) ? months : 0}`;
      break;
    }
    case "subgift":
    case "anonsubgift": {
      kind = "giftsub";
      amount = "1";
      const recipient = String(
        tags["msg-param-recipient-display-name"] ||
          tags["msg-param-recipient-user-name"] ||
          tags["msg-param-recipient-name"] ||
          "",
      )
        .trim()
        .slice(0, 60);
      detail = recipient ? `gifted a sub to ${recipient}` : "gifted 1 sub";
      dedupeSuffix = `giftsub:${supportActorKey(user)}:1`;
      break;
    }
    case "submysterygift":
    case "anonsubmysterygift": {
      kind = "giftsub";
      const rawCount = Number(tags["msg-param-mass-gift-count"]);
      const count = Number.isSafeInteger(rawCount) && rawCount > 0 ? rawCount : 1;
      amount = String(count);
      detail = `gifted ${count} ${count === 1 ? "sub" : "subs"}`;
      dedupeSuffix = `giftsub:${supportActorKey(user)}:${count}`;
      break;
    }
    case "raid": {
      kind = "raid";
      const viewers = Number(tags["msg-param-viewerCount"]) || 0;
      amount = String(viewers);
      detail = `raiding with ${viewers} viewers`;
      eventUser = tags["msg-param-displayName"] || tags["msg-param-login"] || user;
      dedupeSuffix = `raid:${supportActorKey(eventUser)}:${viewers}`;
      break;
    }
    default:
      return null;
  }

  const ts = Number(tags["tmi-sent-ts"]);
  const giftOriginId = String(
    tags["msg-param-origin-id"] || tags["msg-param-community-gift-id"] || "",
  )
    .trim()
    .slice(0, 160);
  return {
    notice,
    ...(giftOriginId ? { giftOriginId } : {}),
    event: {
      platform: "twitch",
      id: tags.id || `${tags["tmi-sent-ts"] || Date.now()}-${login || eventUser}`,
      kind,
      user: eventUser,
      detail,
      amount,
      atMs: Number.isFinite(ts) ? ts : Date.now(),
      dedupeKey: `support:${dedupeSuffix}`,
      dedupeWindowMs: 2 * 60 * 1000,
    },
  };
}

function supportActorKey(value: unknown): string {
  return String(value || "viewer").trim().toLowerCase().replace(/\s+/g, "_").slice(0, 100);
}

function supportShortHash(value: unknown): string {
  let hash = 0x811c9dc5;
  for (const char of String(value || "").trim().toLowerCase()) {
    hash ^= char.codePointAt(0) || 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

export function parseTwitchUserNotice(line: string): ChatEvent | null {
  return parseTwitchUserNoticeEnvelope(line)?.event ?? null;
}

/** Normalise a pasted channel value ("#Name", twitch.tv URL) to lowercase login. */
export function normalizeTwitchChannel(raw: string): string | null {
  let input = String(raw || "").trim().toLowerCase();
  input = input.replace(/^https?:\/\//, "").replace(/^www\./, "");
  if (input.startsWith("twitch.tv/")) input = input.slice("twitch.tv/".length);
  input = input.replace(/^#/, "").split(/[/?#]/)[0];
  return /^[a-z0-9_]{3,25}$/.test(input) ? input : null;
}

export function createTwitchChat(
  opts: { channel: string; callbacks: EngineCallbacks; url?: string },
): ChatEngine {
  const channel = normalizeTwitchChannel(opts.channel);
  const { callbacks } = opts;
  if (!channel) {
    callbacks.onStatus("error", "invalid channel");
    return { close: () => undefined };
  }

  let closed = false;
  let ws: WebSocket | null = null;
  let attempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const recognizedGiftOrigins = new Set<string>();
  const pendingGiftChildren = new Map<
    string,
    { events: ChatEvent[]; timer: ReturnType<typeof setTimeout> }
  >();

  const rememberGiftOrigin = (originId: string) => {
    if (recognizedGiftOrigins.has(originId)) return false;
    recognizedGiftOrigins.add(originId);
    while (recognizedGiftOrigins.size > COMMUNITY_GIFT_ORIGIN_CAP) {
      const oldest = recognizedGiftOrigins.values().next().value;
      if (typeof oldest !== "string") break;
      recognizedGiftOrigins.delete(oldest);
    }
    return true;
  };

  const flushGiftChildren = (originId: string) => {
    const pending = pendingGiftChildren.get(originId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingGiftChildren.delete(originId);
    // Mark this origin recognized before delivery. If a very late summary
    // appears after the fallback window, suppress it rather than double-alert.
    if (!rememberGiftOrigin(originId) || closed) return;
    for (const event of pending.events) callbacks.onEvent?.(event);
  };

  const holdGiftChild = (originId: string, event: ChatEvent) => {
    if (recognizedGiftOrigins.has(originId)) return;
    const existing = pendingGiftChildren.get(originId);
    if (existing) {
      existing.events.push(event);
      return;
    }
    // A hostile/unexpected stream cannot grow an unbounded timer map. Flush
    // the oldest origin as a standalone fallback instead of dropping support.
    if (pendingGiftChildren.size >= COMMUNITY_GIFT_ORIGIN_CAP) {
      const oldest = pendingGiftChildren.keys().next().value;
      if (typeof oldest === "string") flushGiftChildren(oldest);
    }
    const timer = setTimeout(
      () => flushGiftChildren(originId),
      COMMUNITY_GIFT_CHILD_WAIT_MS,
    );
    pendingGiftChildren.set(originId, { events: [event], timer });
  };

  const handleUserNotice = (line: string) => {
    const parsed = parseTwitchUserNoticeEnvelope(line);
    if (!parsed) return;
    const originId = parsed.giftOriginId;
    const isSummary =
      parsed.notice === "submysterygift" ||
      parsed.notice === "anonsubmysterygift";
    const isChild =
      parsed.notice === "subgift" || parsed.notice === "anonsubgift";
    if (!originId || (!isSummary && !isChild)) {
      callbacks.onEvent?.(parsed.event);
      return;
    }
    // Independent OBS Browser Sources each hold their own IRC connection. Use
    // the shared community-gift origin as the normalized event id so a source
    // that saw the summary and one that joined mid-bundle and fell back to a
    // child still produce one engagement credit server-side.
    const correlatedEvent = {
      ...parsed.event,
      id: `community-gift:${originId.slice(0, 96)}`,
    };
    if (isSummary) {
      const pending = pendingGiftChildren.get(originId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingGiftChildren.delete(originId);
      }
      if (rememberGiftOrigin(originId)) callbacks.onEvent?.(correlatedEvent);
      return;
    }
    holdGiftChild(originId, correlatedEvent);
  };

  const connect = () => {
    if (closed) return;
    callbacks.onStatus("connecting");
    ws = new WebSocket(opts.url || TWITCH_IRC_URL);
    ws.onopen = () => {
      ws?.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
      ws?.send(`NICK justinfan${Math.floor(10000 + Math.random() * 80000)}`);
      ws?.send(`JOIN #${channel}`);
    };
    ws.onmessage = (event) => {
      for (const line of String(event.data).split("\r\n")) {
        if (!line) continue;
        if (line.startsWith("PING")) {
          ws?.send("PONG :tmi.twitch.tv");
          continue;
        }
        // 366 = end of JOIN names list — we're in the room.
        if (line.includes(" 366 ")) {
          attempts = 0;
          callbacks.onStatus("connected");
          continue;
        }
        const parsed = parseTwitchMessage(line);
        if (parsed) {
          callbacks.onMessage({ platform: "twitch", ...parsed });
          const cheer = parseTwitchCheer(line);
          if (cheer) callbacks.onEvent?.(cheer);
          continue;
        }
        if (line.includes(" USERNOTICE #")) {
          handleUserNotice(line);
        }
      }
    };
    ws.onclose = () => {
      ws = null;
      if (closed) return;
      callbacks.onStatus("connecting", "reconnecting");
      const delay = Math.min(
        RECONNECT_MAX_MS,
        RECONNECT_BASE_MS * 2 ** Math.min(attempts, 5),
      );
      attempts += 1;
      retryTimer = setTimeout(connect, delay);
    };
    ws.onerror = () => {
      // onclose always follows — reconnect handled there.
    };
  };

  connect();

  return {
    close: () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      for (const pending of pendingGiftChildren.values()) {
        clearTimeout(pending.timer);
      }
      pendingGiftChildren.clear();
      try {
        ws?.close();
      } catch {
        /* already down */
      }
    },
  };
}
