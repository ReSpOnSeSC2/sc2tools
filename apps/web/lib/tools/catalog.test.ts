import { describe, expect, it } from "vitest";
import { toolsCatalog } from "./catalog";

describe("public tool directory", () => {
  const hrefs = (gates: Parameters<typeof toolsCatalog>[0]) => toolsCatalog(gates).flatMap(section => section.tools.map(tool => tool.href));

  it("shows the released public tools regardless of optional rollouts", () => {
    const base = hrefs({ browser: false, guides: false, reviews: false });
    expect(base).toEqual(expect.arrayContaining(["/arcade", "/arcade/scout", "/match", "/balance", "/balance/claim", "/permit", "/live"]));
    for (const path of ["/try", "/try#balance-court", "/career", "/wrapped", "/guides", "/reviews"]) expect(base).not.toContain(path);
  });

  it("exposes browser tools and public guides and reviews when their options allow them", () => {
    const all = hrefs({ browser: true, guides: true, reviews: true });
    expect(all).toEqual(expect.arrayContaining(["/try", "/try#balance-court", "/career", "/wrapped", "/guides", "/reviews"]));
    expect(new Set(all).size).toBe(all.length);
    expect(all).not.toContain("/balance/verdict");
  });
});
