import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GA_MEASUREMENT_ID,
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
    delete window[`ga-disable-${GA_MEASUREMENT_ID}`];
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

  it("honors a new session choice when writes fail but old storage is readable", () => {
    setConsent("granted");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota exceeded"); });
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

  it("uses this session's explicit choice when storage is unreadable", () => {
    setConsent("denied");
    vi.spyOn(window.localStorage.__proto__, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readConsent()).toBe("denied");
  });
});

/**
 * Changing the choice after gtag.js has loaded this visit (Settings →
 * Misc): gtag hears about it, and turning analytics off deletes the
 * Google Analytics cookies without a reload.
 */
describe("changing consent mid-visit", () => {
  afterEach(() => {
    window.localStorage.clear();
    delete window.gtag;
    delete window[`ga-disable-${GA_MEASUREMENT_ID}`];
    for (const name of ["_ga", "_ga_TEST123", "_gid", "theme"]) {
      document.cookie = `${name}=; Max-Age=0; path=/`;
    }
  });

  it("passes the new choice to a running gtag", () => {
    const gtag = vi.fn();
    window.gtag = gtag;
    setConsent("denied");
    expect(gtag).toHaveBeenLastCalledWith("consent", "update", { analytics_storage: "denied" });
    expect(window[`ga-disable-${GA_MEASUREMENT_ID}`]).toBe(true);
    setConsent("granted");
    expect(gtag).toHaveBeenLastCalledWith("consent", "update", { analytics_storage: "granted" });
    expect(window[`ga-disable-${GA_MEASUREMENT_ID}`]).toBe(false);
  });

  it("deletes only the Google Analytics cookies when turned off", () => {
    document.cookie = "_ga=GA1.1.123; path=/";
    document.cookie = "_ga_TEST123=GS1.1.456; path=/";
    document.cookie = "_gid=GA1.1.789; path=/";
    document.cookie = "theme=dark; path=/";
    setConsent("denied");
    expect(document.cookie).not.toMatch(/_ga|_gid/);
    expect(document.cookie).toContain("theme=dark");
  });

  it("leaves cookies alone when turned on, and works before gtag loads", () => {
    document.cookie = "_ga=GA1.1.123; path=/";
    expect(() => setConsent("granted")).not.toThrow();
    expect(document.cookie).toContain("_ga=GA1.1.123");
  });

  it("stops an already-loaded tracker when another tab revokes consent", () => {
    setConsent("granted");
    const callback = vi.fn();
    const unsubscribe = subscribeConsent(callback);
    window.localStorage.setItem("sc2tools.analyticsConsent.v1", "denied");
    window.dispatchEvent(new StorageEvent("storage", { key: "sc2tools.analyticsConsent.v1", newValue: "denied" }));
    expect(window[`ga-disable-${GA_MEASUREMENT_ID}`]).toBe(true);
    expect(callback).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
