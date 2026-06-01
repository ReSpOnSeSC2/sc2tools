import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readConsent,
  setConsent,
  subscribeConsent,
} from "@/lib/analytics/consent";

/**
 * Consent store — the gate that decides whether Google Analytics is
 * ever allowed to load. These tests pin the opt-in contract: the
 * default is "unset" (no tracking), a choice persists, and subscribers
 * are notified synchronously so the GA loader reacts on click.
 */
describe("analytics consent store", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("defaults to 'unset' so nothing tracks before a choice", () => {
    expect(readConsent()).toBe("unset");
  });

  it("persists and reads back a granted choice", () => {
    setConsent("granted");
    expect(readConsent()).toBe("granted");
  });

  it("persists and reads back a denied choice", () => {
    setConsent("denied");
    expect(readConsent()).toBe("denied");
  });

  it("notifies subscribers when consent changes", () => {
    const cb = vi.fn();
    const unsubscribe = subscribeConsent(cb);
    setConsent("granted");
    expect(cb).toHaveBeenCalledTimes(1);
    unsubscribe();
    setConsent("denied");
    expect(cb).toHaveBeenCalledTimes(1); // no further calls after unsubscribe
  });

  it("treats unreadable storage as 'unset' (never assume consent)", () => {
    vi.spyOn(window.localStorage.__proto__, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readConsent()).toBe("unset");
  });
});
