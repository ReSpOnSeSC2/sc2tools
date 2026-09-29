import { describe, expect, it } from "vitest";

import {
  analyticsPageLocation,
  analyticsSearch,
  isUntrackedPath,
  normalizePagePath,
} from "@/lib/analytics/pageLocation";

describe("isUntrackedPath", () => {
  it.each([
    "/admin",
    "/admin/users",
    "/admin/users/346d2a86/opponents",
    "/overlay/tok123",
    "/overlay/tok123/scene/between-games",
    "/dock/tok123",
    "/players/reaver-7a6b/replays",
    "/players/reaver-7a6b/replays/01J",
    "/p/legacy-share/replays",
  ])("never reports %s", (path) => {
    expect(isUntrackedPath(path)).toBe(true);
  });

  it.each(["/", "/app", "/guides/pvz", "/administration", "/overlays", "/players/reaver/replays-archive"])(
    "reports %s",
    (path) => {
      expect(isUntrackedPath(path)).toBe(false);
    },
  );

  it("treats a missing pathname as trackable (nothing to hide)", () => {
    expect(isUntrackedPath(null)).toBe(false);
  });
});

describe("normalizePagePath", () => {
  it("collapses per-record screens to one page per screen type", () => {
    expect(normalizePagePath("/app/game/2026-07-20T13:15:04|WalmartWiFi|Lockdown LE|1056")).toBe(
      "/app/game/:gameId",
    );
    expect(normalizePagePath("/app/opponents/1-S2-1-20646762")).toBe("/app/opponents/:pulseId");
    expect(normalizePagePath("/community/opponents/2-S2-1-6910729")).toBe("/community/opponents/:pulseId");
    expect(normalizePagePath("/community/authors/user_2abc")).toBe("/community/authors/:userId");
  });

  it("leaves list pages and public content untouched", () => {
    expect(normalizePagePath("/app/opponents")).toBe("/app/opponents");
    expect(normalizePagePath("/guides/pvt/robo-first")).toBe("/guides/pvt/robo-first");
    expect(normalizePagePath("/community/builds/pvt-3-gate-e2d2dc")).toBe("/community/builds/pvt-3-gate-e2d2dc");
  });
});

describe("analyticsSearch", () => {
  it("keeps attribution parameters and drops everything else", () => {
    expect(analyticsSearch("?tab=opponents&opponent=2-S2-1-1&utm_source=reddit&utm_medium=social")).toBe(
      "?utm_source=reddit&utm_medium=social",
    );
    expect(analyticsSearch("?gclid=abc&opponentName=TcUltimate")).toBe("?gclid=abc");
  });

  it("keeps the PWA launch marker", () => {
    expect(analyticsSearch("?source=pwa")).toBe("?source=pwa");
  });

  it("returns an empty string when nothing is left", () => {
    expect(analyticsSearch("?tab=macro")).toBe("");
    expect(analyticsSearch("")).toBe("");
    expect(analyticsSearch(null)).toBe("");
  });
});

describe("analyticsPageLocation", () => {
  it("builds a normalized absolute location without a hash or private params", () => {
    expect(
      analyticsPageLocation("https://sc2tools.com", "/app/game/g1", "?opponent=2-S2-1-1&utm_campaign=launch"),
    ).toBe("https://sc2tools.com/app/game/:gameId?utm_campaign=launch");
  });

  it("never repeats the query string", () => {
    expect(analyticsPageLocation("https://sc2tools.com", "/", "?source=pwa")).toBe("https://sc2tools.com/?source=pwa");
  });
});
