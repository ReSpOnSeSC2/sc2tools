import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  analyticsPageState,
  gaEvent,
  isGtagReady,
  pageview,
  syncAnalyticsPage,
  tagSessionAsInternal,
} from "@/lib/analytics/gtag";
import { GA_MEASUREMENT_ID, setConsent } from "@/lib/analytics/consent";
import {
  INTERNAL_TRAFFIC_STORAGE_KEY,
  isInternalBrowser,
  markInternalBrowser,
} from "@/lib/analytics/internalTraffic";

/**
 * The gtag wrappers decide what Google Analytics receives: a normalized
 * page on every event (no page_path, so no duplicated query strings),
 * gtag's own page state kept on the same form for its automatic events,
 * nothing from untracked surfaces, and the internal-traffic marker on
 * admin browsers.
 *
 * What gtag.js does with the raw address when these rules are missing was
 * measured against the production container: docs/handoff/growth/X1.md.
 */
describe("gtag wrappers", () => {
  const gtag = vi.fn();
  const ORIGIN = window.location.origin;
  const HOME = `${ORIGIN}/`;

  /** Put the browser on a page, as the router does before effects run. */
  function visit(path: string) {
    window.history.pushState({}, "", path);
  }

  /** Give the document the referrer a full page load would have. */
  function arriveFrom(referrer: string) {
    Object.defineProperty(document, "referrer", { configurable: true, value: referrer });
  }

  function optedOut() {
    return window[`ga-disable-${GA_MEASUREMENT_ID}`];
  }

  beforeEach(() => {
    setConsent("granted");
    window.gtag = gtag;
  });

  afterEach(() => {
    gtag.mockReset();
    delete window.gtag;
    delete window[`ga-disable-${GA_MEASUREMENT_ID}`];
    window.localStorage.clear();
    delete (document as { referrer?: string }).referrer;
    visit("/");
  });

  it("are no-ops before consent loads gtag.js", () => {
    delete window.gtag;
    expect(isGtagReady()).toBe(false);
    pageview("/");
    syncAnalyticsPage("/");
    gaEvent("agent_download");
    expect(gtag).not.toHaveBeenCalled();
  });

  it("sends a normalized page_location and no page_path", () => {
    pageview("/app/opponents/1-S2-1-20646762", "?tab=timeline&utm_source=discord");
    const location = `${ORIGIN}/app/opponents/:pulseId?utm_source=discord`;
    expect(gtag.mock.calls).toEqual([
      ["set", { page_location: location }],
      ["event", "page_view", { page_location: location }],
    ]);
  });

  it("stops every wrapper immediately when consent is revoked mid-visit", () => {
    gaEvent("before_opt_out");
    expect(gtag).toHaveBeenCalledWith("event", "before_opt_out", { page_location: HOME });
    setConsent("denied");
    gtag.mockClear();
    expect(isGtagReady()).toBe(false);
    gaEvent("overlay_url_copied");
    pageview("/welcome");
    syncAnalyticsPage("/welcome");
    tagSessionAsInternal();
    expect(gtag).not.toHaveBeenCalled();
    expect(optedOut()).toBe(true);

    setConsent("granted");
    gtag.mockClear();
    gaEvent("after_opt_in");
    expect(gtag).toHaveBeenCalledWith("event", "after_opt_in", { page_location: HOME });
  });

  it("does not use a still-loaded gtag after the saved choice is cleared", () => {
    window.localStorage.clear();
    expect(isGtagReady()).toBe(false);
    gaEvent("agent_download");
    expect(gtag).not.toHaveBeenCalled();
  });

  it("skips untracked surfaces", () => {
    pageview("/admin/users");
    pageview("/overlay/secret-token");
    syncAnalyticsPage("/dock/secret-token");
    expect(gtag).not.toHaveBeenCalled();
  });

  it("tags events from an internal browser", () => {
    expect(markInternalBrowser()).toBe(true);
    expect(markInternalBrowser()).toBe(false);
    expect(isInternalBrowser()).toBe(true);
    pageview("/");
    gaEvent("overlay_url_copied", { widget: "scouting" });
    expect(gtag.mock.calls[1]).toEqual(["event", "page_view", { page_location: HOME, traffic_type: "internal" }]);
    expect(gtag.mock.calls[2][2]).toEqual({ widget: "scouting", page_location: HOME, traffic_type: "internal" });
  });

  it("leaves visitors' events untagged", () => {
    gaEvent("agent_download", { platform: "windows" });
    expect(gtag.mock.calls[0][2]).toEqual({ platform: "windows", page_location: HOME });
  });

  it("can tag the rest of a running session as internal", () => {
    tagSessionAsInternal();
    expect(gtag).toHaveBeenCalledWith("set", { traffic_type: "internal" });
  });

  it("keeps the storage key the init script reads", () => {
    expect(INTERNAL_TRAFFIC_STORAGE_KEY).toBe("sc2tools.internalTraffic.v1");
  });

  describe("the page every event reports", () => {
    it("states the normalized location on a custom event", () => {
      visit("/app/opponents/1-S2-1-20646762?tab=timeline&utm_source=discord#notes");
      gaEvent("review_requested", { level: "gold" });
      expect(gtag.mock.calls).toEqual([
        [
          "event",
          "review_requested",
          { level: "gold", page_location: `${ORIGIN}/app/opponents/:pulseId?utm_source=discord` },
        ],
      ]);
    });

    it("does not let a caller state a different page", () => {
      visit("/app/game/abc");
      gaEvent("card_shared", { page_location: `${ORIGIN}/app/game/abc`, method: "download" });
      expect(gtag.mock.calls[0][2]).toEqual({
        method: "download",
        page_location: `${ORIGIN}/app/game/:gameId`,
      });
    });

    it("replaces gtag's page state before the page view, referrer included", () => {
      arriveFrom(`${ORIGIN}/app/opponents/1-S2-1-20646762?tab=games`);
      pageview("/app/game/abc", "?tab=macro");
      expect(gtag.mock.calls).toEqual([
        [
          "set",
          {
            page_location: `${ORIGIN}/app/game/:gameId`,
            page_referrer: `${ORIGIN}/app/opponents/:pulseId`,
          },
        ],
        ["event", "page_view", { page_location: `${ORIGIN}/app/game/:gameId` }],
      ]);
    });

    it("syncs the page state on a navigation that sends no page view", () => {
      visit("/status");
      syncAnalyticsPage("/status");
      expect(gtag.mock.calls).toEqual([["set", { page_location: `${ORIGIN}/status` }]]);
    });

    it("describes the browser's own address by default", () => {
      arriveFrom("https://www.reddit.com/");
      visit("/builds/my-secret-build?tab=notes&source=pwa");
      expect(analyticsPageState()).toEqual({
        page_location: `${ORIGIN}/builds/:slug?source=pwa`,
        page_referrer: "https://www.reddit.com/",
      });
    });
  });

  describe("untracked surfaces the visitor is on", () => {
    it("send nothing and raise Google's opt-out flag", () => {
      visit("/admin/users?q=someone");
      gaEvent("agent_download");
      syncAnalyticsPage("/admin/users", "?q=someone");
      pageview("/admin/users", "?q=someone");
      tagSessionAsInternal();
      expect(isGtagReady()).toBe(false);
      expect(gtag).not.toHaveBeenCalled();
      expect(optedOut()).toBe(true);
    });

    it("stay silent for a custom event even before the page was synced", () => {
      visit("/players/abc/replays");
      gaEvent("review_replay_download");
      expect(gtag).not.toHaveBeenCalled();
      expect(optedOut()).toBe(true);
    });

    it("hand analytics back on the next tracked page", () => {
      visit("/overlay/secret-token");
      syncAnalyticsPage("/overlay/secret-token");
      expect(optedOut()).toBe(true);

      visit("/guides");
      syncAnalyticsPage("/guides");
      expect(optedOut()).toBe(false);
      expect(gtag.mock.calls).toEqual([["set", { page_location: `${ORIGIN}/guides` }]]);
    });

    it("are cut down to the site root when they are the referrer", () => {
      arriveFrom(`${ORIGIN}/overlay/secret-token`);
      pageview("/guides");
      expect(gtag.mock.calls[0]).toEqual([
        "set",
        { page_location: `${ORIGIN}/guides`, page_referrer: HOME },
      ]);
    });
  });

  describe("private record pages", () => {
    // Some game ids are built as date|OpponentName|map|length.
    const gameId = encodeURIComponent("2026-11-01T20:00:00|SecretFoe#1234|Alcyone LE|700");
    const pages = [
      {
        name: "a game page",
        path: `/app/game/${gameId}`,
        search: "?tab=macro&opponent=1-S2-1-9988776&opponentName=SecretFoe&utm_source=discord",
        location: `${ORIGIN}/app/game/:gameId?utm_source=discord`,
      },
      {
        name: "an opponent page",
        path: "/app/opponents/1-S2-1-9988776",
        search: "?tab=games&q=SecretFoe",
        location: `${ORIGIN}/app/opponents/:pulseId`,
      },
    ];

    it.each(pages)("no event fired on $name contains the id", ({ path, search, location }) => {
      arriveFrom(`${ORIGIN}/app/opponents/1-S2-1-5544332?q=OtherFoe`);
      visit(`${path}${search}`);

      // Everything the app does on such a page: the shell syncs the page,
      // the tracker reports it, components fire events.
      syncAnalyticsPage(path, search);
      pageview(path, search);
      gaEvent("card_shared", { content_type: "battle_card", method: "web_share" });
      gaEvent("review_requested");
      tagSessionAsInternal();

      expect(gtag).toHaveBeenCalledTimes(6);
      const sent = JSON.stringify(gtag.mock.calls);
      for (const secret of ["SecretFoe", "OtherFoe", "9988776", "5544332", "Alcyone", "2026-11-01"]) {
        expect(sent).not.toContain(secret);
      }
      const addresses = gtag.mock.calls.flatMap((call) => {
        const params = call[call.length - 1] as Record<string, unknown>;
        return [params.page_location, params.page_referrer].filter(Boolean);
      });
      expect(new Set(addresses)).toEqual(new Set([location, `${ORIGIN}/app/opponents/:pulseId`]));
    });
  });
});
