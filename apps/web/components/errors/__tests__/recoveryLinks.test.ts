import { describe, expect, it } from "vitest";
import { dashboardLabel, nearestHubLinks, notFoundLinks } from "../recoveryLinks";

const ALL_ON = { tryPage: true, guides: true };

describe("recovery links", () => {
  it("offers no hub for a path outside the known sections", () => {
    expect(nearestHubLinks("/totally/unknown", ALL_ON)).toEqual([]);
    expect(nearestHubLinks("/buildsx", ALL_ON)).toEqual([]);
  });

  it("skips the guides hub while guides are off", () => {
    expect(nearestHubLinks("/guides/pvz", { tryPage: false, guides: false })).toEqual([]);
  });

  it("never repeats a destination or links home or the app in the row", () => {
    const links = notFoundLinks("/community/builds/x", ALL_ON).map((link) => link.href);
    expect(links).toEqual(["/community", "/try", "/guides", "/download"]);
    expect(links).not.toContain("/");
    expect(links).not.toContain("/app");
  });

  it("names the dashboard by where the visitor was", () => {
    expect(dashboardLabel("/app/opponents/x")).toBe("Back to your dashboard");
    expect(dashboardLabel("/apples")).toBe("Open dashboard");
  });
});
