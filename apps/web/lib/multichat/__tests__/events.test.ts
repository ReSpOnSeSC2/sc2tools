// Multichat events — parser tests. Twitch fixtures are raw USERNOTICE
// lines in the exact wire format Twitch's IRC gateway delivers
// (tag names and system-msg escaping per the official IRC docs); Kick
// fixtures follow the payloads the public Pusher channel delivers for
// subscription/gift/host events.

import { describe, expect, test } from "vitest";
import {
  CHAT_EVENT_KINDS,
  EVENT_KIND_LABEL,
  isChatEventKind,
} from "@/lib/multichat/events";
import { parseKickEvent } from "@/lib/multichat/kick";
import { parseTwitchUserNotice } from "@/lib/multichat/twitch";

/* ──────────────── twitch USERNOTICE ──────────────── */

const RAW_RESUB =
  "@badge-info=subscriber/8;badges=subscriber/6;color=#0000FF;display-name=ResubGuy;emotes=;flags=;id=aaaa1111-2222-3333-4444-555566667777;login=resubguy;mod=0;msg-id=resub;msg-param-cumulative-months=8;msg-param-months=0;msg-param-should-share-streak=0;msg-param-sub-plan-name=Channel\\sSubscription;msg-param-sub-plan=1000;room-id=71092938;subscriber=1;system-msg=ResubGuy\\ssubscribed\\sat\\sTier\\s1.\\sThey've\\ssubscribed\\sfor\\s8\\smonths!;tmi-sent-ts=1768686000123;user-id=987654;user-type= " +
  ":tmi.twitch.tv USERNOTICE #somechannel :Love this stream!";

const RAW_MYSTERY_GIFT =
  "@badge-info=;badges=sub-gifter/50;color=;display-name=GiftLord;emotes=;flags=;id=bbbb1111-2222-3333-4444-555566667777;login=giftlord;mod=0;msg-id=submysterygift;msg-param-mass-gift-count=5;msg-param-origin-id=abc123;msg-param-sender-count=55;msg-param-sub-plan=1000;room-id=71092938;subscriber=0;system-msg=GiftLord\\sis\\sgifting\\s5\\sTier\\s1\\sSubs\\sto\\sthe\\scommunity!;tmi-sent-ts=1768686001000;user-id=111;user-type= " +
  ":tmi.twitch.tv USERNOTICE #somechannel";

const RAW_SINGLE_GIFT =
  "@badges=;display-name=Gifty;id=cccc1111-2222-3333-4444-555566667777;login=gifty;msg-id=subgift;msg-param-recipient-display-name=LuckyOne;msg-param-recipient-user-name=luckyone;msg-param-sub-plan=1000;tmi-sent-ts=1768686002000 " +
  ":tmi.twitch.tv USERNOTICE #somechannel";

const RAW_RAID =
  "@badge-info=;badges=;color=#5F9EA0;display-name=RaidLeader;emotes=;flags=;id=dddd1111-2222-3333-4444-555566667777;login=raidleader;mod=0;msg-id=raid;msg-param-displayName=RaidLeader;msg-param-login=raidleader;msg-param-viewerCount=42;room-id=71092938;subscriber=0;system-msg=42\\sraiders\\sfrom\\sRaidLeader\\shave\\sjoined!;tmi-sent-ts=1768686003000;user-id=222;user-type= " +
  ":tmi.twitch.tv USERNOTICE #somechannel";

describe("twitch USERNOTICE parsing", () => {
  test("resub — months from msg-param-cumulative-months, message ignored", () => {
    const e = parseTwitchUserNotice(RAW_RESUB);
    expect(e).toEqual({
      platform: "twitch",
      id: "aaaa1111-2222-3333-4444-555566667777",
      kind: "resub",
      user: "ResubGuy",
      detail: "subscribed for 8 months",
      amount: undefined,
      atMs: 1768686000123,
    });
    // The trailing user message never leaks into the event.
    expect(JSON.stringify(e)).not.toContain("Love this stream");
  });

  test("submysterygift — amount from mass-gift-count", () => {
    const e = parseTwitchUserNotice(RAW_MYSTERY_GIFT);
    expect(e).toMatchObject({
      kind: "giftsub",
      user: "GiftLord",
      detail: "gifted 5 subs",
      amount: "5",
      atMs: 1768686001000,
    });
  });

  test("single subgift defaults to 1 with singular wording", () => {
    const e = parseTwitchUserNotice(RAW_SINGLE_GIFT);
    expect(e).toMatchObject({
      kind: "giftsub",
      user: "Gifty",
      detail: "gifted 1 sub",
      amount: "1",
    });
  });

  test("raid — party size + raider from msg-param-displayName", () => {
    const e = parseTwitchUserNotice(RAW_RAID);
    expect(e).toMatchObject({
      kind: "raid",
      user: "RaidLeader",
      detail: "raiding with 42 viewers",
      amount: "42",
      atMs: 1768686003000,
    });
  });

  test("sub — plain first-time subscription", () => {
    const e = parseTwitchUserNotice(
      "@display-name=NewSub;id=x1;login=newsub;msg-id=sub;tmi-sent-ts=1768686004000 " +
        ":tmi.twitch.tv USERNOTICE #chan",
    );
    expect(e).toMatchObject({ kind: "sub", user: "NewSub", detail: "subscribed" });
  });

  test("resub without cumulative months still reads sensibly", () => {
    const e = parseTwitchUserNotice(
      "@display-name=Y;id=x2;login=y;msg-id=resub;tmi-sent-ts=1 " +
        ":tmi.twitch.tv USERNOTICE #chan",
    );
    expect(e!.detail).toBe("resubscribed");
  });

  test("id falls back to tmi-sent-ts + login when the id tag is absent", () => {
    const e = parseTwitchUserNotice(
      "@display-name=Z;login=z;msg-id=sub;tmi-sent-ts=1768686005000 " +
        ":tmi.twitch.tv USERNOTICE #chan",
    );
    expect(e!.id).toBe("1768686005000-z");
  });

  test("ignores non-USERNOTICE traffic and unsurfaced msg-ids", () => {
    expect(parseTwitchUserNotice("PING :tmi.twitch.tv")).toBeNull();
    expect(
      parseTwitchUserNotice(
        ":someviewer!someviewer@someviewer.tmi.twitch.tv PRIVMSG #chan :hi",
      ),
    ).toBeNull();
    expect(
      parseTwitchUserNotice(
        "@display-name=Mod;login=mod;msg-id=announcement;tmi-sent-ts=1 " +
          ":tmi.twitch.tv USERNOTICE #chan :big news",
      ),
    ).toBeNull();
  });
});

/* ──────────────── kick events ──────────────── */

describe("kick event parsing", () => {
  test("SubscriptionEvent — months>1 reads as resub", () => {
    expect(
      parseKickEvent("App\\Events\\SubscriptionEvent", {
        chatroom_id: 4242,
        username: "LoyalFan",
        months: 6,
      }),
    ).toMatchObject({
      platform: "kick",
      kind: "resub",
      user: "LoyalFan",
      detail: "subscribed for 6 months",
    });
    expect(
      parseKickEvent("App\\Events\\SubscriptionEvent", {
        username: "NewFan",
        months: 1,
      }),
    ).toMatchObject({ kind: "sub", detail: "subscribed" });
  });

  test("GiftedSubscriptionsEvent — count from gifted_usernames", () => {
    const e = parseKickEvent("App\\Events\\GiftedSubscriptionsEvent", {
      chatroom_id: 4242,
      gifted_usernames: ["a", "b", "c"],
      gifter_username: "BigSpender",
    });
    expect(e).toMatchObject({
      kind: "giftsub",
      user: "BigSpender",
      detail: "gifted 3 subs",
      amount: "3",
    });
    // Absent recipient list still reads as one gift.
    expect(
      parseKickEvent("App\\Events\\GiftedSubscriptionsEvent", {
        gifter_username: "Solo",
      }),
    ).toMatchObject({ detail: "gifted 1 sub", amount: "1" });
  });

  test("StreamHostEvent — raid with party size", () => {
    expect(
      parseKickEvent("App\\Events\\StreamHostEvent", {
        chatroom_id: 4242,
        host_username: "HostGuy",
        number_viewers: 120,
      }),
    ).toMatchObject({
      kind: "raid",
      user: "HostGuy",
      detail: "raiding with 120 viewers",
      amount: "120",
    });
  });

  test("synthesizes an id when the payload has none", () => {
    const e = parseKickEvent("App\\Events\\SubscriptionEvent", {
      username: "NoId",
      months: 1,
    });
    expect(e!.id).toContain("App\\Events\\SubscriptionEvent-");
    expect(e!.id).toContain("-NoId");
  });

  test("drops unknown events and payloads without a user", () => {
    expect(parseKickEvent("App\\Events\\PinnedMessageCreatedEvent", {})).toBeNull();
    expect(parseKickEvent("App\\Events\\SubscriptionEvent", {})).toBeNull();
    expect(parseKickEvent("App\\Events\\StreamHostEvent", {})).toBeNull();
  });
});

/* ──────────────── kinds ──────────────── */

describe("event kinds", () => {
  test("isChatEventKind accepts every known kind, rejects the rest", () => {
    for (const kind of CHAT_EVENT_KINDS) {
      expect(isChatEventKind(kind)).toBe(true);
    }
    expect(isChatEventKind("dance")).toBe(false);
    expect(isChatEventKind("")).toBe(false);
    expect(isChatEventKind(undefined)).toBe(false);
  });

  test("every kind has a label", () => {
    for (const kind of CHAT_EVENT_KINDS) {
      expect(EVENT_KIND_LABEL[kind].length).toBeGreaterThan(0);
    }
    expect(EVENT_KIND_LABEL.giftsub).toBe("Gift subs");
    expect(EVENT_KIND_LABEL.superchat).toBe("Super Chat");
  });
});
