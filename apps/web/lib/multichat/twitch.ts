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

import type { ChatBadge, ChatEngine, EngineCallbacks } from "./types";

export const TWITCH_IRC_URL = "wss://irc-ws.chat.twitch.tv:443";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

export interface ParsedTwitchMessage {
  id: string;
  user: string;
  text: string;
  color?: string;
  badges: ChatBadge[];
  atMs: number;
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
  text = text.trim();
  if (!text) return null;
  const ts = Number(tags["tmi-sent-ts"]);
  return {
    id: tags.id || `${tags["tmi-sent-ts"] || Date.now()}-${m[1]}`,
    user: tags["display-name"] || m[1],
    text,
    color: /^#[0-9A-Fa-f]{6}$/.test(tags.color || "") ? tags.color : undefined,
    badges: twitchBadgeTags(tags.badges),
    atMs: Number.isFinite(ts) ? ts : Date.now(),
  };
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
      try {
        ws?.close();
      } catch {
        /* already down */
      }
    },
  };
}
