import { describe, expect, it } from "vitest";
import { ISSUES_URL } from "@/lib/siteLinks";
import { dashboardLabel, issueReportHref, nearestHubLinks, notFoundLinks } from "../recoveryLinks";

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

  it("files a report with the reference and the bare path", () => {
    const href = issueReportHref({ digest: "998", path: "/settings?tab=overlay&token=secret#x" });
    expect(href.startsWith(`${ISSUES_URL}/new?`)).toBe(true);
    const params = new URL(href).searchParams;
    expect(params.get("title")).toBe("Error 998");
    expect(params.get("body")).toBe("Error reference: 998\nPage: /settings");
    expect(href).not.toContain("secret");
  });
});
