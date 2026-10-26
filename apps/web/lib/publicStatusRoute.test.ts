import { describe, expect, it } from "vitest";
import { isPublicStatusRequest, isPublicStatusRoute, statusHostRedirect } from "./publicStatusRoute";

describe("exact public status routes", () => {
  it("opens only the status document outside the normal authenticated shell", () => {
    expect(isPublicStatusRoute("/status")).toBe(true);
    for (const pathname of [null, "", "/", "/status/", "/Status", "/status-private", "/status/details", "/app/status", "/api/ping"]) {
      expect(isPublicStatusRoute(pathname), String(pathname)).toBe(false);
    }
  });

  it("adds only the exact credential-free website ping to the middleware bypass", () => {
    expect(isPublicStatusRequest("/status")).toBe(true);
    expect(isPublicStatusRequest("/api/ping")).toBe(true);
    for (const pathname of ["/status/", "/status-private", "/status/details", "/api/ping/", "/api/ping/private", "/api/ping-private", "/api/Ping", "/api/ping.json", "/app", "/admin", "/settings", "/players/person/replays/game.one"]) {
      expect(isPublicStatusRequest(pathname), pathname).toBe(false);
    }
  });
});

describe("fixed status-host canonical destination", () => {
  it.each([
    "https://status.sc2tools.com/",
    "https://status.sc2tools.com/status?token=private#fragment",
    "https://status.sc2tools.com/app/game/private-game?owner=private&redirect=https://evil.test/",
    "http://STATUS.SC2TOOLS.COM:8080/settings?secret=private",
  ])("drops every incoming path, query and fragment from %s", requestUrl => {
    expect(statusHostRedirect(requestUrl)).toBe("https://sc2tools.com/status");
  });

  it.each([
    "https://sc2tools.com/status",
    "https://status.sc2tools.com.evil.test/app",
    "https://status-sc2tools.com/app",
    "https://notstatus.sc2tools.com/app",
    "https://status.sc2tools.com@evil.test/app",
    "https://evil.test/app?host=status.sc2tools.com",
    "https://status.sc2tools.com./status",
    "/status",
    "not a URL",
  ])("does not treat a lookalike or malformed URL as the alias: %s", requestUrl => {
    expect(statusHostRedirect(requestUrl)).toBeNull();
  });
});
