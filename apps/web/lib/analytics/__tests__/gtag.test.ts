import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { gaEvent, isGtagReady, pageview, tagSessionAsInternal } from "@/lib/analytics/gtag";
import {
  INTERNAL_TRAFFIC_STORAGE_KEY,
  isInternalBrowser,
  markInternalBrowser,
} from "@/lib/analytics/internalTraffic";

/**
 * The gtag wrappers decide what Google Analytics receives: normalized
 * page locations (no page_path, so no duplicated query strings), nothing
 * from untracked surfaces, and the internal-traffic marker on admin
 * browsers.
 */
describe("gtag wrappers", () => {
  const gtag = vi.fn();

  beforeEach(() => {
    window.gtag = gtag;
  });

  afterEach(() => {
    gtag.mockReset();
    delete window.gtag;
    window.localStorage.clear();
  });

  it("are no-ops before consent loads gtag.js", () => {
    delete window.gtag;
    expect(isGtagReady()).toBe(false);
    pageview("/");
    gaEvent("agent_download");
    expect(gtag).not.toHaveBeenCalled();
  });

  it("sends a normalized page_location and no page_path", () => {
    pageview("/app/opponents/1-S2-1-20646762", "?tab=timeline&utm_source=discord");
    expect(gtag).toHaveBeenCalledTimes(1);
    const [command, name, params] = gtag.mock.calls[0];
    expect(command).toBe("event");
    expect(name).toBe("page_view");
    expect(params).toEqual({
      page_location: `${window.location.origin}/app/opponents/:pulseId?utm_source=discord`,
    });
  });

  it("skips untracked surfaces", () => {
    pageview("/admin/users");
    pageview("/overlay/secret-token");
    expect(gtag).not.toHaveBeenCalled();
  });

  it("tags events from an internal browser", () => {
    expect(markInternalBrowser()).toBe(true);
    expect(markInternalBrowser()).toBe(false);
    expect(isInternalBrowser()).toBe(true);
    pageview("/");
    gaEvent("overlay_url_copied", { widget: "scouting" });
    expect(gtag.mock.calls[0][2]).toMatchObject({ traffic_type: "internal" });
    expect(gtag.mock.calls[1][2]).toEqual({ widget: "scouting", traffic_type: "internal" });
  });

  it("leaves visitors' events untagged", () => {
    gaEvent("agent_download", { platform: "windows" });
    expect(gtag.mock.calls[0][2]).toEqual({ platform: "windows" });
  });

  it("can tag the rest of a running session as internal", () => {
    tagSessionAsInternal();
    expect(gtag).toHaveBeenCalledWith("set", { traffic_type: "internal" });
  });

  it("keeps the storage key the init script reads", () => {
    expect(INTERNAL_TRAFFIC_STORAGE_KEY).toBe("sc2tools.internalTraffic.v1");
  });
});
