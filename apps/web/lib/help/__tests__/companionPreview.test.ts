import { describe, expect, it } from "vitest";
import { getArticle } from "../index";
import { helpBlockText } from "../articleText";

describe("Companion preview availability", () => {
  it("distinguishes native preview instructions from the current stable installer", () => {
    for (const slug of ["desktop-companion", "install-app", "randomizer", "practice-ghost-build", "build-check-in", "desktop-app-overview"]) {
      const article = getArticle(slug);
      expect(article, slug).toBeDefined();
      const text = article!.body.map(helpBlockText).join(" ");
      expect(text, slug).toContain("Companion 0.21.0 preview");
      expect(text, slug).toContain("current stable download");
    }
    for (const slug of ["desktop-companion", "install-app"]) {
      const first = getArticle(slug)!.body[0];
      expect(first.type).toBe("callout");
      expect(helpBlockText(first)).toContain("signed public release is pending");
      expect(helpBlockText(first)).toContain("unsigned verification builds are separate test artifacts");
    }
  });
});
