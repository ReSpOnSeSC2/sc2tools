import { afterEach, describe, expect, it } from "vitest";

import {
  SIGN_UP_WINDOW_MS,
  readTrackedSignUp,
  rememberTrackedSignUp,
  shouldTrackSignUp,
  signUpMethod,
} from "@/lib/analytics/signUp";

const NOW = Date.parse("2026-09-29T12:00:00Z");

describe("shouldTrackSignUp", () => {
  it("reports an account created moments ago", () => {
    const createdAt = new Date(NOW - 60_000);
    expect(shouldTrackSignUp({ userId: "user_1", createdAt, now: NOW, trackedUserId: null })).toBe(true);
  });

  it("ignores accounts older than the sign-up window", () => {
    const createdAt = new Date(NOW - SIGN_UP_WINDOW_MS - 1);
    expect(shouldTrackSignUp({ userId: "user_1", createdAt, now: NOW, trackedUserId: null })).toBe(false);
  });

  it("reports each account once per browser", () => {
    const createdAt = new Date(NOW - 60_000);
    expect(shouldTrackSignUp({ userId: "user_1", createdAt, now: NOW, trackedUserId: "user_1" })).toBe(false);
    expect(shouldTrackSignUp({ userId: "user_2", createdAt, now: NOW, trackedUserId: "user_1" })).toBe(true);
  });

  it("needs a creation date", () => {
    expect(shouldTrackSignUp({ userId: "user_1", createdAt: null, now: NOW, trackedUserId: null })).toBe(false);
  });
});

describe("signUpMethod", () => {
  it("names the social provider", () => {
    expect(signUpMethod([{ provider: "google" }])).toBe("google");
    expect(signUpMethod([{ provider: "oauth_twitch" }])).toBe("twitch");
  });

  it("falls back to email", () => {
    expect(signUpMethod([])).toBe("email");
    expect(signUpMethod(undefined)).toBe("email");
  });
});

describe("tracked sign-up memory", () => {
  afterEach(() => window.localStorage.clear());

  it("round-trips the reported account id", () => {
    expect(readTrackedSignUp()).toBeNull();
    rememberTrackedSignUp("user_9");
    expect(readTrackedSignUp()).toBe("user_9");
  });
});
