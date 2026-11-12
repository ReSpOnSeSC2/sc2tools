import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GA_MEASUREMENT_ID,
  readConsent,
  setConsent,
  subscribeConsent,
  syncAnalyticsOptOut,
} from "@/lib/analytics/consent";

const STORAGE_KEY = "sc2tools.analyticsConsent.v1";
const optOutFlag = () => window[`ga-disable-${GA_MEASUREMENT_ID}`];

function storageChange(key: string | null, value: string | null, storageArea = window.localStorage) {
  window.dispatchEvent(new StorageEvent("storage", { key, newValue: value, storageArea }));
}

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
    window.history.pushState({}, "", "/");
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
    window.sessionStorage.clear();
    window.history.pushState({}, "", "/");
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

  it("applies a revocation once before notifying every subscriber", () => {
    setConsent("granted");
    document.cookie = "_ga=GA1.1.123; path=/";
    document.cookie = "theme=dark; path=/";
    const gtag = vi.fn(() => expect(optOutFlag()).toBe(true));
    window.gtag = gtag;
    const subscriber = vi.fn(() => {
      expect(gtag).toHaveBeenCalledTimes(1);
      expect(document.cookie).toBe("theme=dark");
    });
    const unsubscribeFirst = subscribeConsent(subscriber);
    const unsubscribeSecond = subscribeConsent(subscriber);
    try {
      window.localStorage.setItem(STORAGE_KEY, "denied");
      storageChange(STORAGE_KEY, "denied");
      expect(gtag.mock.calls).toEqual([["consent", "update", { analytics_storage: "denied" }]]);
      expect(subscriber).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribeFirst();
      unsubscribeSecond();
    }
  });

  it("sets the current safe page state before granting a loaded tag", () => {
    setConsent("denied");
    window.history.pushState({}, "", "/app/game/private-id?tab=macro&utm_source=discord");
    const gtag = vi.fn(() => expect(optOutFlag()).toBe(false));
    window.gtag = gtag;
    const unsubscribe = subscribeConsent();
    try {
      window.localStorage.setItem(STORAGE_KEY, "granted");
      storageChange(STORAGE_KEY, "granted");
      expect(gtag.mock.calls).toEqual([
        ["set", { page_location: `${window.location.origin}/app/game/:gameId?utm_source=discord`, page_title: "/app/game/:gameId" }],
        ["consent", "update", { analytics_storage: "granted" }],
      ]);
    } finally {
      unsubscribe();
    }
  });

  it.each([
    [null, null],
    [STORAGE_KEY, null],
    [STORAGE_KEY, "invalid"],
  ])("keeps a loaded tag denied when consent becomes unset (%s, %s)", (key, value) => {
    setConsent("granted");
    const gtag = vi.fn();
    window.gtag = gtag;
    const unsubscribe = subscribeConsent();
    try {
      if (value === null) window.localStorage.clear();
      else window.localStorage.setItem(STORAGE_KEY, value);
      storageChange(key, value);
      expect(readConsent()).toBe("unset");
      expect(optOutFlag()).toBe(true);
      expect(gtag.mock.calls).toEqual([["consent", "update", { analytics_storage: "denied" }]]);
    } finally {
      unsubscribe();
    }
  });

  it("uses the latest persisted choice after a queued event and an earlier failed local write", () => {
    const failedWrite = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    setConsent("granted");
    failedWrite.mockRestore();
    const gtag = vi.fn();
    window.gtag = gtag;
    const unsubscribe = subscribeConsent();
    try {
      window.localStorage.setItem(STORAGE_KEY, "denied");
      storageChange(STORAGE_KEY, "granted");
      expect(readConsent()).toBe("denied");
      expect(optOutFlag()).toBe(true);
      expect(gtag.mock.calls).toEqual([["consent", "update", { analytics_storage: "denied" }]]);
    } finally {
      unsubscribe();
    }
  });

  it("ignores unrelated local storage and session storage changes", () => {
    setConsent("granted");
    const gtag = vi.fn();
    const subscriber = vi.fn();
    window.gtag = gtag;
    const unsubscribe = subscribeConsent(subscriber);
    try {
      storageChange("unrelated", "value");
      storageChange(STORAGE_KEY, "denied", window.sessionStorage);
      storageChange(null, null, window.sessionStorage);
      expect(gtag).not.toHaveBeenCalled();
      expect(subscriber).not.toHaveBeenCalled();
      expect(optOutFlag()).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  describe("Google's opt-out flag", () => {
    it("is off only for an opted-in visitor on a page that may be measured", () => {
      expect(syncAnalyticsOptOut()).toBe(true);
      setConsent("granted");
      expect(syncAnalyticsOptOut()).toBe(false);
      expect(optOutFlag()).toBe(false);
      setConsent("denied");
      expect(syncAnalyticsOptOut()).toBe(true);
      expect(optOutFlag()).toBe(true);
    });

    it.each(["/admin/users", "/overlay/secret-token", "/dock/secret-token", "/players/abc/replays"])(
      "stays on for an opted-in visitor on an untracked page (%s)",
      (path) => {
        setConsent("granted");
        window.history.pushState({}, "", path);
        expect(syncAnalyticsOptOut()).toBe(true);
        expect(optOutFlag()).toBe(true);
        window.history.pushState({}, "", "/guides");
        expect(syncAnalyticsOptOut()).toBe(false);
        expect(optOutFlag()).toBe(false);
      },
    );

    it("is not lowered by accepting analytics on an untracked page", () => {
      window.history.pushState({}, "", "/admin/users");
      setConsent("granted");
      expect(optOutFlag()).toBe(true);
    });

    it("is not lowered on an untracked page when another tab accepts", () => {
      window.history.pushState({}, "", "/admin/users");
      const gtag = vi.fn();
      window.gtag = gtag;
      const unsubscribe = subscribeConsent();
      try {
        window.localStorage.setItem(STORAGE_KEY, "granted");
        storageChange(STORAGE_KEY, "granted");
        expect(optOutFlag()).toBe(true);
        expect(gtag.mock.calls).toEqual([["consent", "update", { analytics_storage: "granted" }]]);
      } finally {
        unsubscribe();
      }
    });
  });
});
