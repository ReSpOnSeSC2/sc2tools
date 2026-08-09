// Multichat appearance — sanitizer, style derivation, and the
// content-visibility filter (TTL / commands / blocklists / cap).

import { describe, expect, test } from "vitest";
import {
  DEFAULT_APPEARANCE,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  appearanceStyles,
  blockedUserSet,
  hexToRgba,
  sanitizeAppearance,
  visibleMessages,
  type ChatAppearance,
} from "@/lib/multichat/appearance";
import type { ChatMessage } from "@/lib/multichat/types";

function msg(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    platform: "twitch",
    id: over.id ?? `${Math.random()}`,
    user: "viewer",
    text: "hello",
    badges: [],
    atMs: 1_000_000,
    ...over,
  };
}

describe("sanitizeAppearance", () => {
  test("null/garbage input yields the complete default object", () => {
    expect(sanitizeAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(sanitizeAppearance("junk")).toEqual(DEFAULT_APPEARANCE);
    expect(sanitizeAppearance(42)).toEqual(DEFAULT_APPEARANCE);
    expect(sanitizeAppearance({}).messageTtlSec).toBe(30);
    expect(sanitizeAppearance({ messageTtlSec: 0 }).messageTtlSec).toBe(0);
  });

  test("clamps numbers and validates enums / colours", () => {
    const out = sanitizeAppearance({
      fontSize: 999,
      maxVisible: -3,
      messageTtlSec: 100000,
      bgOpacity: 250,
      cornerRadius: "12",
      fontFamily: "comic-sans",
      layout: "bubbles",
      entryAnimation: "explode",
      bgColor: "#ZZZZZZ",
      blockedUsers: "x".repeat(2000),
      showBadges: "yes",
    });
    expect(out.fontSize).toBe(FONT_SIZE_MAX);
    expect(out.maxVisible).toBe(5);
    expect(out.messageTtlSec).toBe(600);
    expect(out.bgOpacity).toBe(100);
    expect(out.cornerRadius).toBe(12);
    expect(out.fontFamily).toBe("inter");
    expect(out.layout).toBe("bubbles");
    expect(out.entryAnimation).toBe("fade");
    expect(out.bgColor).toBe(DEFAULT_APPEARANCE.bgColor);
    expect(out.blockedUsers.length).toBe(500);
    expect(out.showBadges).toBe(true);
    expect(sanitizeAppearance({ fontSize: 1 }).fontSize).toBe(FONT_SIZE_MIN);
  });

  test("valid custom values round-trip unchanged", () => {
    const custom: ChatAppearance = {
      ...DEFAULT_APPEARANCE,
      fontSize: 18,
      bgColor: "#2b0033",
      bgOpacity: 20,
      layout: "two-line",
      newestAt: "top",
      hideCommands: true,
      blockedUsers: "botOne, botTwo",
    };
    expect(sanitizeAppearance(custom)).toEqual(custom);
  });
});

describe("style derivation", () => {
  test("hexToRgba composes colour + opacity", () => {
    expect(hexToRgba("#000000", 50)).toBe("rgba(0,0,0,0.5)");
    expect(hexToRgba("#ff0000", 0)).toBe("rgba(255,0,0,0)");
    expect(hexToRgba("garbage", 100)).toBe("rgba(17,20,27,1)"); // default panel
  });

  test("appearanceStyles reflects density and shadow", () => {
    const compact = appearanceStyles({
      ...DEFAULT_APPEARANCE,
      density: "compact",
      textShadow: true,
    });
    const comfy = appearanceStyles({
      ...DEFAULT_APPEARANCE,
      density: "comfortable",
    });
    expect(compact.rowGap).toBeLessThan(comfy.rowGap);
    expect(compact.textShadow).toContain("rgba");
    expect(comfy.textShadow).toBeUndefined();
  });
});

describe("visibleMessages", () => {
  test("caps to maxVisible keeping the newest", () => {
    const a = { ...DEFAULT_APPEARANCE, maxVisible: 5 };
    const feed = Array.from({ length: 12 }, (_, i) => msg({ id: `m${i}` }));
    const out = visibleMessages(feed, a, 1_000_000);
    expect(out).toHaveLength(5);
    expect(out[4].id).toBe("m11");
  });

  test("TTL expires old lines only when enabled", () => {
    const feed = [
      msg({ id: "old", atMs: 0 }),
      msg({ id: "fresh", atMs: 99_000 }),
    ];
    const withTtl = visibleMessages(
      feed,
      { ...DEFAULT_APPEARANCE, messageTtlSec: 30 },
      100_000,
    );
    expect(withTtl.map((m) => m.id)).toEqual(["fresh"]);
    const withoutTtl = visibleMessages(
      feed,
      { ...DEFAULT_APPEARANCE, messageTtlSec: 0 },
      100_000,
    );
    expect(withoutTtl).toHaveLength(2);
  });

  test("expires a line at the exact configured lifetime", () => {
    const feed = [msg({ id: "timed", atMs: 70_000 })];
    const appearance = { ...DEFAULT_APPEARANCE, messageTtlSec: 30 };

    expect(visibleMessages(feed, appearance, 99_999)).toHaveLength(1);
    expect(visibleMessages(feed, appearance, 100_000)).toHaveLength(0);
  });

  test("hideCommands drops !lines", () => {
    const feed = [msg({ id: "a", text: "!discord" }), msg({ id: "b" })];
    const out = visibleMessages(
      feed,
      { ...DEFAULT_APPEARANCE, hideCommands: true },
      1_000_000,
    );
    expect(out.map((m) => m.id)).toEqual(["b"]);
  });

  test("blocklist hides custom users and known bots, case-insensitively", () => {
    const a = {
      ...DEFAULT_APPEARANCE,
      hideBots: true,
      blockedUsers: " SpamGuy , @otherbot ",
    };
    const set = blockedUserSet(a);
    expect(set.has("spamguy")).toBe(true);
    expect(set.has("otherbot")).toBe(true);
    expect(set.has("nightbot")).toBe(true);
    const feed = [
      msg({ id: "a", user: "NightBot" }),
      msg({ id: "b", user: "SpamGuy" }),
      msg({ id: "c", user: "RealViewer" }),
    ];
    expect(visibleMessages(feed, a, 1_000_000).map((m) => m.id)).toEqual(["c"]);
  });
});
