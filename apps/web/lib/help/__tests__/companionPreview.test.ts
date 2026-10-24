import { describe, expect, it } from "vitest";
import { getArticle } from "../index";
import { helpBlockText } from "../articleText";

describe("Companion preview availability", () => {
  it("distinguishes native preview instructions from the current stable installer", () => {
    for (const slug of ["desktop-companion", "install-app", "randomizer", "practice-ghost-build", "build-check-in", "desktop-app-overview"]) {
      const article = getArticle(slug);
      expect(article, slug).toBeDefined();
      const text = article!.body.map(helpBlockText).join(" ");
      expect(text, slug).toContain(`Companion ${slug === "desktop-companion" ? "0.22.1 verification" : "0.21.0"} preview`);
      expect(text, slug).toContain("current stable download");
    }
    for (const slug of ["desktop-companion", "install-app"]) {
      const first = getArticle(slug)!.body[0];
      expect(first.type).toBe("callout");
      expect(helpBlockText(first)).toContain("signed public release is pending");
      expect(helpBlockText(first)).toContain("unsigned verification builds are separate test artifacts");
    }
  });

  it("documents the small layouts, themed controls and stored replay ranges", () => {
    const text = getArticle("desktop-companion")!.body.map(helpBlockText).join(" ");
    for (const phrase of ["340 × 78", "520 × 480", "1024 × 800", "minimize", "close", "3 minutes", "6 minutes", "10 minutes", "Full build order", "Scouting preview", "repeated production", "Default", "Protoss", "Terran", "Zerg", "animations off"]) {
      expect(text).toContain(phrase);
    }
  });

  it("documents confirmed Hybrid team scope, gradual legacy metadata and illustrated native tools", () => {
    const article = getArticle("desktop-companion")!;
    const text = article.body.map(helpBlockText).join(" ");
    for (const phrase of ["Hybrid team scouting", "Enemy roster", "Right-click Compact", "authoritative team IDs",
      "explicitly identify your own player", "Historical 1v1 MMR", "not current team-ladder rating",
      "randomizer draws are 1v1-only", "Use this target in current team game",
      "does not overwrite a saved 1v1 target", "without resyncing", "actual played date",
      "unpairing discard in-flight metadata replies", "credential-bearing third-party connection logs"]) {
      expect(text).toContain(phrase);
    }
    for (const source of ["/landing/companion-race-skins.png", "/landing/companion-postgame.png", "/landing/companion-randomizer.png", "/landing/companion-team-hybrid.png"]) {
      expect(article.body.some(block => block.type === "image" && block.src === source)).toBe(true);
    }
    expect(text).not.toContain("Actual team-game guidance is unsupported");
  });
});
