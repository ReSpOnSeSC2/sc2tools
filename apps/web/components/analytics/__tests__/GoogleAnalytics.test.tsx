import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const route = vi.hoisted(() => ({ pathname: "/", search: "" }));

// Mock: show each script's text instead of executing it, so the test can
// read the order of the gtag commands the browser would run.
vi.mock("next/script", () => ({
  default: ({ id, src, children }: { id?: string; src?: string; children?: string }) => (
    <pre data-testid={id ?? "gtag-js"} data-src={src}>
      {children}
    </pre>
  ),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => route.pathname,
  useSearchParams: () => new URLSearchParams(route.search),
}));

vi.mock("@/lib/clientApi", () => ({
  useApi: () => ({ data: null }),
}));

vi.mock("@clerk/nextjs", () => ({
  useUser: () => ({ isLoaded: true, user: null }),
}));

import { GoogleAnalytics } from "@/components/analytics/GoogleAnalytics";
import { GA_MEASUREMENT_ID, setConsent } from "@/lib/analytics/consent";

const ORIGIN = window.location.origin;
// Some game ids are built as date|OpponentName|map|length.
const GAME_ID = encodeURIComponent("2026-11-01T20:00:00|SecretFoe#1234|Alcyone LE|700");

/** Load a page the way a full page load would: address, referrer, then React. */
function open(path: string, search = "", referrer = "") {
  route.pathname = path;
  route.search = search;
  window.history.pushState({}, "", `${path}${search}`);
  Object.defineProperty(document, "referrer", { configurable: true, value: referrer });
  return render(<GoogleAnalytics />);
}

function initScript() {
  return screen.getByTestId("ga4-init").textContent ?? "";
}

/**
 * gtag.js reads the browser's address the moment it is configured, and
 * again for every event that does not state a page. The loader has to
 * hand it the normalized page first (measured: docs/handoff/growth/X1.md).
 */
describe("GoogleAnalytics", () => {
  const gtag = vi.fn();

  beforeEach(() => {
    setConsent("granted");
    window.gtag = gtag;
  });

  afterEach(() => {
    cleanup();
    gtag.mockReset();
    delete window.gtag;
    delete window[`ga-disable-${GA_MEASUREMENT_ID}`];
    window.localStorage.clear();
    delete (document as { referrer?: string }).referrer;
    document.title = "";
    window.history.pushState({}, "", "/");
    route.pathname = "/";
    route.search = "";
  });

  it("loads nothing until the visitor opts in", () => {
    setConsent("denied");
    open("/guides");

    expect(screen.queryByTestId("gtag-js")).toBeNull();
    expect(screen.queryByTestId("ga4-init")).toBeNull();
    expect(gtag).not.toHaveBeenCalledWith("event", "page_view", expect.anything());
  });

  it("states the normalized page before config reads the browser's address", () => {
    document.title = "SecretFoe's replay";
    open(
      `/app/game/${GAME_ID}`,
      "?tab=macro&opponentName=SecretFoe&utm_source=discord",
      `${ORIGIN}/app/opponents/1-S2-1-9988776?q=SecretFoe`,
    );

    const script = initScript();
    const state = `gtag('set', ${JSON.stringify({
      page_location: `${ORIGIN}/app/game/:gameId?utm_source=discord`,
      page_title: "/app/game/:gameId",
      page_referrer: `${ORIGIN}/app/opponents/:pulseId`,
    })});`;
    expect(script).toContain(state);
    expect(script.indexOf(state)).toBeLessThan(script.indexOf("gtag('config'"));
    for (const secret of ["SecretFoe", "9988776", "Alcyone", "2026-11-01"]) {
      expect(script).not.toContain(secret);
    }
  });

  it("states the page the router is showing, not the address being left", () => {
    // A client-side navigation renders the new page before the browser's
    // address changes. Here the visitor is leaving a shared replay archive,
    // where analytics never ran, so this is the loader's first mount.
    window.history.pushState({}, "", "/players/reaver-7a6b5c4d3e/replays/01JREPLAY?tab=timeline");
    route.pathname = "/guides";
    route.search = "utm_source=discord&tab=pvz";
    render(<GoogleAnalytics />);

    const script = initScript();
    expect(script).toContain(
      `gtag('set', ${JSON.stringify({ page_location: `${ORIGIN}/guides?utm_source=discord`, page_title: "SC2 Tools" })});`,
    );
    for (const left of ["players", "reaver", "01JREPLAY", "timeline"]) {
      expect(script).not.toContain(left);
    }
  });

  it("reports the first page view with the same normalized location", () => {
    open("/app/opponents/1-S2-1-9988776", "?tab=games");

    const location = `${ORIGIN}/app/opponents/:pulseId`;
    expect(gtag.mock.calls).toEqual([
      ["set", { page_location: location, page_title: "/app/opponents/:pulseId" }],
      ["event", "page_view", { page_location: location }],
    ]);
  });

  it("uses the site label on a public player page with a named browser title", () => {
    document.title = "Example Player · StarCraft II player";
    open("/players/synthetic-profile", "");

    expect(initScript()).toContain('"page_title":"SC2 Tools"');
    expect(initScript()).not.toContain("Example Player");
  });

  it("writes the page as data that cannot close the script element", () => {
    // Another site's referrer passes through unchanged, whatever it holds.
    open("/guides", "", "https://example.org/?next=</script><script>alert(1)</script>");

    const script = initScript();
    expect(script).not.toContain("</script");
    expect(script).toContain("\\u003c/script>");
  });
});
