import { describe, expect, it } from "vitest";
import { getArticle } from "../index";
import { helpArticleLinks, helpBlockText } from "../articleText";

describe("guide and randomizer accessibility Help", () => {
  it("explains device motion reduction and resolved build announcements", () => {
    const article = getArticle("randomizer")!;
    const text = article.body.map(helpBlockText).join(" ");
    expect(text).toContain("Reveals respect your device's Reduce motion setting and announce the chosen build to screen readers.");
    expect(text).toContain("A retry, refresh or second connected display reuses the first saved pick");
    expect(text).toContain("Every eligible build keeps its configured chance");
  });

  it("links the real legend and all three glossary definitions from guide stats Help", () => {
    const article = getArticle("reading-guide-stats")!;
    const text = article.body.map(helpBlockText).join(" ");
    expect(text).toContain("information button beside Likely range");
    const links = helpArticleLinks(article);
    for (const id of ["likely-range", "publishing-floor", "trend-arrow"]) expect(links).toContain(`/help/glossary#${id}`);
    expect(text).toContain("no AI"); expect(text).toContain("low end"); expect(text).toContain("8-worker");
  });
});
