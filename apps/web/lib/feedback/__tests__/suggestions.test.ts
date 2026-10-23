import { describe, expect, it } from "vitest";
import { helpMenuItems } from "@/components/chrome/helpMenu";
import { getArticle, helpArticlePath } from "@/lib/help";
import { SUGGESTION_LIMIT, reportHelpSuggestions } from "../suggestions";

describe("reportHelpSuggestions", () => {
  it("finds the article that answers the subject", () => {
    const slugs = reportHelpSuggestions("overlay not showing in obs").map((article) => article.slug);
    expect(slugs).toContain("troubleshooting-and-support");
    expect(slugs.length).toBeLessThanOrEqual(SUGGESTION_LIMIT);
  });

  it("stays quiet for short subjects and weak one-word matches", () => {
    expect(reportHelpSuggestions("ob")).toEqual([]);
    expect(reportHelpSuggestions("   ")).toEqual([]);
    expect(reportHelpSuggestions("add dark mode")).toEqual([]);
  });
});

describe("report-a-problem help article", () => {
  it("exists and is what the menu's How reports work opens", () => {
    const article = getArticle("report-a-problem");
    expect(article?.category).toBe("troubleshooting");
    expect(article?.signedInOnly).toBe(true);
    const howItWorks = helpMenuItems(true).find((item) => item.key === "how-reports-work");
    expect(howItWorks?.href).toBe(helpArticlePath("report-a-problem"));
  });

  it("explains what is attached, how to remove it and what happens next", () => {
    const headings = getArticle("report-a-problem")!
      .body.filter((block) => block.type === "heading")
      .map((block) => (block.type === "heading" ? block.text : ""));
    expect(headings).toEqual(
      expect.arrayContaining(["What goes with your report", "Remove something", "What happens next"]),
    );
  });
});
