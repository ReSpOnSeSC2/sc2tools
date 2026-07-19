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
  kickEmoteUrl,
  renderTextWithEmotes,
  twitchEmoteUrl,
  type ChatEmote,
} from "@/lib/multichat/emotes";
import {
  collectKickEmotes,
  kickBadgeTags,
  parseKickChatEvent,
  stripKickEmoteTags,
} from "@/lib/multichat/kick";
import {
  normalizeTwitchChannel,
  parseIrcTags,
  parseTwitchEmotesTag,
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

  test("parses the emotes= tag into codes + CDN urls", () => {
    // 25 = Kappa (0-4 and 12-16), 1902 = Keepo (6-10) against the
    // matching text — exactly the wire format Twitch documents.
    const line =
      "@badges=;color=#FF69B4;display-name=EmoteFan;emotes=25:0-4,12-16/1902:6-10;id=e1;tmi-sent-ts=1768686000123 " +
      ":emotefan!emotefan@emotefan.tmi.twitch.tv PRIVMSG #chan :Kappa Keepo Kappa";
    const m = parseTwitchMessage(line);
    expect(m!.text).toBe("Kappa Keepo Kappa");
    expect(m!.emotes).toEqual([
      { code: "Kappa", url: twitchEmoteUrl("25") },
      { code: "Keepo", url: twitchEmoteUrl("1902") },
    ]);
  });

  test("emote-less messages carry no emotes field", () => {
    expect(parseTwitchMessage(RAW_PRIVMSG)!.emotes).toBeUndefined();
  });

  test("parseTwitchEmotesTag drops malformed and out-of-range entries", () => {
    expect(parseTwitchEmotesTag(undefined, "Kappa")).toEqual([]);
    expect(parseTwitchEmotesTag("", "Kappa")).toEqual([]);
    expect(parseTwitchEmotesTag("25:0-99", "Kappa")).toEqual([]);
    expect(parseTwitchEmotesTag("25:4-0", "Kappa")).toEqual([]);
    expect(parseTwitchEmotesTag("25:junk", "Kappa")).toEqual([]);
    // Duplicate code (same substring under two ids) keeps the first.
    expect(parseTwitchEmotesTag("25:0-4/33:0-4", "Kappa")).toEqual([
      { code: "Kappa", url: twitchEmoteUrl("25") },
    ]);
  });

  test("emote ranges count code points, not UTF-16 units", () => {
    // The emoji occupies ONE code-point slot (0); Kappa starts at 2.
    expect(parseTwitchEmotesTag("25:2-6", "💜 Kappa")).toEqual([
      { code: "Kappa", url: twitchEmoteUrl("25") },
    ]);
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

  test("collects [emote:id:name] markup as renderable emotes", () => {
    const m = parseKickChatEvent(KICK_EVENT);
    expect(m!.emotes).toEqual([
      { code: ":KEKW:", url: kickEmoteUrl("37226") },
    ]);
    // Codes dedupe; nameless markup contributes nothing.
    expect(
      collectKickEmotes("[emote:1:Pog] hi [emote:1:Pog] [emote:2:]"),
    ).toEqual([{ code: ":Pog:", url: kickEmoteUrl("1") }]);
    expect(collectKickEmotes("no emotes here")).toEqual([]);
    // Plain-text messages carry no emotes field at all.
    expect(
      parseKickChatEvent({ ...KICK_EVENT, content: "plain text" })!.emotes,
    ).toBeUndefined();
  });
});

/* ──────────────── emotes ──────────────── */

describe("renderTextWithEmotes", () => {
  const kappa: ChatEmote = { code: "Kappa", url: twitchEmoteUrl("25") };
  const kekw: ChatEmote = { code: ":KEKW:", url: kickEmoteUrl("37226") };

  test("splits text into string/emote segments", () => {
    expect(renderTextWithEmotes("gg Kappa wp", [kappa])).toEqual([
      "gg ",
      kappa,
      " wp",
    ]);
    expect(renderTextWithEmotes("Kappa Kappa", [kappa])).toEqual([
      kappa,
      " ",
      kappa,
    ]);
    expect(renderTextWithEmotes("nice opener :KEKW:", [kekw])).toEqual([
      "nice opener ",
      kekw,
    ]);
  });

  test("no emotes (or no matches) → the original text, once", () => {
    expect(renderTextWithEmotes("hello", [])).toEqual(["hello"]);
    expect(renderTextWithEmotes("hello", [kappa])).toEqual(["hello"]);
    expect(renderTextWithEmotes("", [kappa])).toEqual([]);
  });

  test("longer codes win over their prefixes", () => {
    const short: ChatEmote = { code: "KEK", url: kickEmoteUrl("1") };
    const long: ChatEmote = { code: "KEKW", url: kickEmoteUrl("2") };
    expect(renderTextWithEmotes("KEKW KEK", [short, long])).toEqual([
      long,
      " ",
      short,
    ]);
  });

  test("regex metacharacters in codes are treated literally", () => {
    const paren: ChatEmote = { code: ":-)", url: twitchEmoteUrl("1") };
    expect(renderTextWithEmotes("hi :-)", [paren])).toEqual(["hi ", paren]);
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
