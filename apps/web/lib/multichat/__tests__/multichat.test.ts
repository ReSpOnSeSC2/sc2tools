// Multichat lib — parser + feed tests. Twitch fixtures are raw IRC
// lines in the exact wire format captured from a live anonymous
// irc-ws.chat.twitch.tv session; Kick fixtures follow the documented
// ChatMessageEvent payload the public Pusher channel delivers.

import { describe, expect, test } from "vitest";
import { appendMessages, fallbackColor, FEED_CAP } from "@/lib/multichat/feed";
import {
  normalizeKickChannelInput,
  normalizeTikTokUsernameInput,
  parseKickChatroomInput,
} from "@/lib/multichat/config";
import {
  kickBadgeTags,
  parseKickChatEvent,
  stripKickEmoteTags,
} from "@/lib/multichat/kick";
import {
  normalizeTwitchChannel,
  parseIrcTags,
  parseTwitchMessage,
  twitchBadgeTags,
} from "@/lib/multichat/twitch";
import type { ChatMessage } from "@/lib/multichat/types";

/* ──────────────── twitch ──────────────── */

const RAW_PRIVMSG =
  "@badge-info=subscriber/14;badges=subscriber/12,vip/1;client-nonce=abc;color=#FF69B4;display-name=SomeViewer;emotes=;first-msg=0;flags=;id=b3f7a1c2-9d4e-4f1a-8b2c-1234567890ab;mod=0;returning-chatter=0;room-id=71092938;subscriber=1;tmi-sent-ts=1768686000123;turbo=0;user-id=987654;user-type= " +
  ":someviewer!someviewer@someviewer.tmi.twitch.tv PRIVMSG #somechannel :hello world KEKW";

describe("twitch IRC parsing", () => {
  test("parses a fully-tagged PRIVMSG", () => {
    const m = parseTwitchMessage(RAW_PRIVMSG);
    expect(m).toEqual({
      id: "b3f7a1c2-9d4e-4f1a-8b2c-1234567890ab",
      user: "SomeViewer",
      text: "hello world KEKW",
      color: "#FF69B4",
      badges: ["member", "vip"],
      atMs: 1768686000123,
    });
  });

  test("falls back to the login when display-name is absent", () => {
    const m = parseTwitchMessage(
      ":plainuser!plainuser@plainuser.tmi.twitch.tv PRIVMSG #chan :no tags here",
    );
    expect(m).toMatchObject({ user: "plainuser", text: "no tags here" });
    expect(m!.color).toBeUndefined();
  });

  test("unwraps /me ACTION frames", () => {
    const m = parseTwitchMessage(
      "@id=x;display-name=Y :y!y@y.tmi.twitch.tv PRIVMSG #chan :ACTION waves",
    );
    // \x01 wrappers: text is "ACTION waves" + trailing \x01 stripped by regex
    expect(m!.text.startsWith("waves")).toBe(true);
  });

  test("ignores non-PRIVMSG traffic", () => {
    expect(parseTwitchMessage("PING :tmi.twitch.tv")).toBeNull();
    expect(
      parseTwitchMessage(
        ":justinfan1.tmi.twitch.tv 366 justinfan1 #chan :End of /NAMES list",
      ),
    ).toBeNull();
    expect(
      parseTwitchMessage(
        "@room-id=1 :tmi.twitch.tv ROOMSTATE #chan",
      ),
    ).toBeNull();
  });

  test("parseIrcTags handles IRCv3 escapes", () => {
    expect(parseIrcTags("a=x\\sy;b=1\\:2")).toEqual({ a: "x y", b: "1;2" });
  });

  test("badge mapping covers broadcaster/mod/sub/vip", () => {
    expect(twitchBadgeTags("broadcaster/1,moderator/1")).toEqual([
      "owner",
      "moderator",
    ]);
    expect(twitchBadgeTags("founder/0")).toEqual(["member"]);
    expect(twitchBadgeTags(undefined)).toEqual([]);
  });

  test("normalizeTwitchChannel accepts names, #names, and URLs", () => {
    expect(normalizeTwitchChannel("SomeChannel")).toBe("somechannel");
    expect(normalizeTwitchChannel("#SomeChannel")).toBe("somechannel");
    expect(normalizeTwitchChannel("https://www.twitch.tv/somechannel")).toBe(
      "somechannel",
    );
    expect(normalizeTwitchChannel("bad name")).toBeNull();
    expect(normalizeTwitchChannel("")).toBeNull();
  });
});

/* ──────────────── kick ──────────────── */

const KICK_EVENT = {
  id: "c0ffee00-1111-2222-3333-444455556666",
  chatroom_id: 4242,
  content: "nice opener [emote:37226:KEKW]",
  type: "message",
  created_at: "2026-07-18T20:15:00+00:00",
  sender: {
    id: 123,
    username: "KickViewer",
    slug: "kickviewer",
    identity: {
      color: "#75FD48",
      badges: [{ type: "moderator", text: "Moderator" }],
    },
  },
};

describe("kick event parsing", () => {
  test("parses a ChatMessageEvent payload", () => {
    const m = parseKickChatEvent(KICK_EVENT);
    expect(m).toMatchObject({
      id: "c0ffee00-1111-2222-3333-444455556666",
      user: "KickViewer",
      text: "nice opener :KEKW:",
      color: "#75FD48",
      badges: ["moderator"],
    });
    expect(m!.atMs).toBe(Date.parse("2026-07-18T20:15:00+00:00"));
  });

  test("drops emote-only and empty messages", () => {
    expect(
      parseKickChatEvent({ ...KICK_EVENT, content: "[emote:1:]" }),
    ).toBeNull();
    expect(parseKickChatEvent({ ...KICK_EVENT, content: "   " })).toBeNull();
    expect(parseKickChatEvent({ content: "hi" })).toBeNull(); // no sender
  });

  test("stripKickEmoteTags renders names inline", () => {
    expect(stripKickEmoteTags("a [emote:1:Pog] b")).toBe("a :Pog: b");
  });

  test("badge mapping dedupes and covers the known set", () => {
    expect(
      kickBadgeTags([
        { type: "broadcaster" },
        { type: "subscriber" },
        { type: "og" },
        { type: "vip" },
        { type: "verified" },
      ]),
    ).toEqual(["owner", "member", "vip", "verified"]);
  });
});

/* ──────────────── feed ──────────────── */

function msg(id: string, platform: ChatMessage["platform"] = "twitch"): ChatMessage {
  return { platform, id, user: "u", text: "t", badges: [], atMs: 1 };
}

describe("feed", () => {
  test("appends, dedupes on (platform,id), and caps from the front", () => {
    let feed = appendMessages([], [msg("1"), msg("2")]);
    expect(feed.map((m) => m.id)).toEqual(["1", "2"]);
    // Same id from a different platform is a different message.
    feed = appendMessages(feed, [msg("1"), msg("1", "kick")]);
    expect(feed).toHaveLength(3);
    const capped = appendMessages(
      feed,
      Array.from({ length: FEED_CAP + 10 }, (_, i) => msg(`x${i}`)),
    );
    expect(capped).toHaveLength(FEED_CAP);
    expect(capped[capped.length - 1].id).toBe(`x${FEED_CAP + 9}`);
  });

  test("returns the same reference when nothing changes", () => {
    const feed = appendMessages([], [msg("1")]);
    expect(appendMessages(feed, [])).toBe(feed);
    expect(appendMessages(feed, [msg("1")])).toBe(feed);
  });

  test("fallbackColor is deterministic and hsl-shaped", () => {
    expect(fallbackColor("viewer")).toBe(fallbackColor("viewer"));
    expect(fallbackColor("viewer")).toMatch(/^hsl\(\d+ 65% 70%\)$/);
  });
});

/* ──────────────── config helpers ──────────────── */

describe("config input normalisation", () => {
  test("kick channel input", () => {
    expect(normalizeKickChannelInput("https://kick.com/SomeGuy")).toBe(
      "someguy",
    );
    expect(normalizeKickChannelInput("some_guy")).toBe("some_guy");
    expect(normalizeKickChannelInput("bad guy!")).toBeNull();
  });

  test("tiktok username input", () => {
    expect(
      normalizeTikTokUsernameInput("https://www.tiktok.com/@some.user/live"),
    ).toBe("some.user");
    expect(normalizeTikTokUsernameInput("@Some.User")).toBe("some.user");
    expect(normalizeTikTokUsernameInput("x")).toBeNull();
  });

  test("kick chatroom paste accepts id, full JSON, and partial JSON", () => {
    expect(parseKickChatroomInput("4242")).toBe(4242);
    expect(
      parseKickChatroomInput(
        JSON.stringify({ id: 9, slug: "x", chatroom: { id: 777, chatable_type: "App\\Models\\Channel" } }),
      ),
    ).toBe(777);
    expect(
      parseKickChatroomInput('..."chatroom":{"id":555,"chat_mode":...'),
    ).toBe(555);
    expect(parseKickChatroomInput("not json")).toBeNull();
    expect(parseKickChatroomInput("")).toBeNull();
  });
});
