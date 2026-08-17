// Multichat events — parser tests. Twitch fixtures are raw USERNOTICE
// lines in the exact wire format Twitch's IRC gateway delivers
// (tag names and system-msg escaping per the official IRC docs); Kick
// fixtures follow the payloads the public Pusher channel delivers for
// subscription/gift/host events.

import { describe, expect, test, vi } from "vitest";
import {
  appendEvents,
  CHAT_EVENT_KINDS,
  chatEventIdentity,
  EVENT_KIND_LABEL,
  isChatEventKind,
} from "@/lib/multichat/events";
import { parseKickEvent } from "@/lib/multichat/kick";
import {
  parseTwitchCheer,
  parseTwitchUserNotice,
} from "@/lib/multichat/twitch";

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
      dedupeKey: "support:resub:resubguy:8",
      dedupeWindowMs: 120_000,
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

  test("single subgift names its recipient with singular wording", () => {
    const e = parseTwitchUserNotice(RAW_SINGLE_GIFT);
    expect(e).toMatchObject({
      kind: "giftsub",
      user: "Gifty",
      detail: "gifted a sub to LuckyOne",
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

  test("anonymous gift subscriptions are still recognized", () => {
    const e = parseTwitchUserNotice(
      "@id=anon-1;msg-id=anonsubgift;msg-param-recipient-display-name=Lucky;tmi-sent-ts=1768686004500 " +
        ":tmi.twitch.tv USERNOTICE #chan",
    );
    expect(e).toMatchObject({
      kind: "giftsub",
      user: "Anonymous",
      detail: "gifted a sub to Lucky",
    });
  });

  test("bits-tagged PRIVMSG becomes a separate cheer event", () => {
    const e = parseTwitchCheer(
      "@badges=;bits=250;color=#00FF00;display-name=CheerFan;id=cheer-msg-1;tmi-sent-ts=1768686004600 " +
        ":cheerfan!cheerfan@cheerfan.tmi.twitch.tv PRIVMSG #chan :Cheer250 gg",
    );
    expect(e).toEqual({
      platform: "twitch",
      id: "cheer-msg-1:cheer",
      kind: "cheer",
      user: "CheerFan",
      detail: "cheered",
      amount: "250 bits",
      atMs: 1768686004600,
      dedupeKey: "support:cheer:cheerfan:250:16bz365",
      dedupeWindowMs: 120_000,
    });
    expect(parseTwitchCheer(RAW_RESUB)).toBeNull();
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

  test("uses collision-resistant ids for same-tick events with no source identity", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_234_567);
    const payload = { username: "NoId", months: 1 };
    const first = parseKickEvent(
      "App\\Events\\SubscriptionEvent",
      payload,
    );
    const second = parseKickEvent(
      "App\\Events\\SubscriptionEvent",
      payload,
    );
    now.mockRestore();

    expect(first!.atMs).toBe(1_234_567);
    expect(second!.atMs).toBe(1_234_567);
    expect(first!.id).not.toBe(second!.id);
    expect(first!.id).toMatch(/^SubscriptionEvent:received:1234567:\d+:NoId$/);
  });

  test("preserves stable source ids and downstream dedupe", () => {
    const payload = {
      id: "transport-follow-1",
      follower: { username: "StableFollower" },
    };
    const first = parseKickEvent("channel.followed", payload)!;
    const replay = parseKickEvent("channel.followed", payload)!;

    expect(first.id).toBe("transport-follow-1");
    expect(replay.id).toBe("transport-follow-1");
    expect(appendEvents([], [first, replay])).toEqual([first]);
    expect(
      parseKickEvent("channel.followed", {
        event_id: "alternate-transport-id",
        follower_username: "Alternate",
      })!.id,
    ).toBe("alternate-transport-id");
  });

  test("coalesces Kick public and official copies of the same follow", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_725_000_000_000);
    const direct = parseKickEvent("channel.followed", {
      id: "public-follow-id",
      follower: { username: "SameFollower" },
    })!;
    now.mockRestore();
    const official = {
      ...direct,
      id: "official-webhook-id",
      detail: "followed on Kick",
      official: true,
    };
    expect(appendEvents([], [direct, official])).toEqual([
      expect.objectContaining({
        id: "public-follow-id",
        detail: "followed on Kick",
        official: true,
        alternateIds: ["official-webhook-id"],
      }),
    ]);
  });

  test("follow and channel reward payloads are recognized defensively", () => {
    expect(
      parseKickEvent("channel.followed", {
        id: "follow-1",
        follower: { username: "NewFollower" },
      }),
    ).toMatchObject({
      kind: "follow",
      user: "NewFollower",
      detail: "followed",
    });
    expect(
      parseKickEvent("channel.reward.redemption.updated", {
        id: "reward-1",
        user: { username: "Redeemer" },
        reward: { title: "Hydrate" },
      }),
    ).toMatchObject({
      kind: "reward",
      user: "Redeemer",
      detail: "redeemed Hydrate",
    });
  });

  test("drops unknown events and payloads without a user", () => {
    expect(parseKickEvent("App\\Events\\PinnedMessageCreatedEvent", {})).toBeNull();
    expect(parseKickEvent("App\\Events\\SubscriptionEvent", {})).toBeNull();
    expect(parseKickEvent("App\\Events\\StreamHostEvent", {})).toBeNull();
  });
});

/* ──────────────── kinds ──────────────── */

describe("event kinds", () => {
  test("pairs public and official copies one-to-one in either arrival order", () => {
    const direct = {
      platform: "kick" as const,
      id: "public-sub-1",
      kind: "sub" as const,
      user: "SameViewer",
      detail: "subscribed",
      atMs: 1_000,
      dedupeKey: "support:sub:sameviewer",
      dedupeWindowMs: 120_000,
    };
    const official = {
      ...direct,
      id: "official-sub-1",
      detail: "subscribed on Kick",
      atMs: 1_200,
      official: true,
    };

    const publicFirst = appendEvents([], [direct, official]);
    expect(publicFirst).toEqual([
      expect.objectContaining({
        id: "public-sub-1",
        official: true,
        transportPaired: true,
        alternateIds: ["official-sub-1"],
      }),
    ]);
    expect(chatEventIdentity(publicFirst[0])).toBe(chatEventIdentity(direct));
    // Both transport retries are remembered after the semantic pair is
    // consumed, so a durable socket replay cannot re-add the action.
    expect(appendEvents(publicFirst, [direct, official])).toBe(publicFirst);

    const officialFirst = appendEvents([], [official, direct]);
    expect(officialFirst).toEqual([
      expect.objectContaining({
        id: "official-sub-1",
        official: true,
        transportPaired: true,
        alternateIds: ["public-sub-1"],
      }),
    ]);
    expect(appendEvents(officialFirst, [official, direct])).toBe(officialFirst);
  });

  test("never collapses repeated same-origin support and consumes pairs only once", () => {
    const directOne = {
      platform: "twitch" as const,
      id: "public-gift-1",
      kind: "giftsub" as const,
      user: "GiftLord",
      detail: "gifted 5 subs",
      amount: "5",
      atMs: 10_000,
      dedupeKey: "support:giftsub:giftlord:5",
      dedupeWindowMs: 120_000,
    };
    const directTwo = { ...directOne, id: "public-gift-2", atMs: 11_000 };
    const officialOne = {
      ...directOne,
      id: "official-gift-1",
      atMs: 10_100,
      official: true,
    };
    const officialTwo = {
      ...directTwo,
      id: "official-gift-2",
      atMs: 11_100,
      official: true,
    };

    expect(appendEvents([], [directOne, directTwo])).toHaveLength(2);
    expect(appendEvents([], [officialOne, officialTwo])).toHaveLength(2);
    const paired = appendEvents([], [directOne, officialOne, directTwo, officialTwo]);
    expect(paired).toHaveLength(2);
    expect(paired).toEqual([
      expect.objectContaining({
        id: "public-gift-1",
        alternateIds: ["official-gift-1"],
        transportPaired: true,
      }),
      expect.objectContaining({
        id: "public-gift-2",
        alternateIds: ["official-gift-2"],
        transportPaired: true,
      }),
    ]);
  });

  test("Kick public and official new-sub fingerprints match exactly", () => {
    const direct = parseKickEvent("App\\Events\\SubscriptionEvent", {
      id: "kick-public-sub",
      username: "ExactViewer",
      months: 1,
      created_at: new Date(20_000).toISOString(),
    })!;
    expect(direct.dedupeKey).toBe("support:sub:exactviewer");
    const official = {
      ...direct,
      id: "kick-official-sub",
      official: true,
      detail: "subscribed on Kick",
    };
    expect(appendEvents([], [direct, official])).toHaveLength(1);
  });

  test("cumulative events replace one row instead of double-counting", () => {
    const first = {
      platform: "youtube" as const,
      id: "gift-1:combo:1",
      updateKey: "jewels:gift-1",
      updateVersion: 1,
      kind: "gift" as const,
      user: "JewelFan",
      detail: "sent Galaxy",
      amount: "100 Jewels",
      atMs: 1_000,
    };
    const latest = {
      ...first,
      id: "gift-1:combo:3",
      updateVersion: 3,
      detail: "sent Galaxy x3",
      amount: "300 Jewels",
      atMs: 2_000,
    };
    const result = appendEvents([first], [latest]);
    expect(result).toEqual([latest]);
    expect(appendEvents(result, [first])).toBe(result);
  });

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
