import { describe, expect, it } from "vitest";
import {
  ALL_HELP_ARTICLES,
  articlesByCategory,
  formatHelpDate,
  getArticle,
  helpAnchorPath,
  helpArticleAnchors,
  helpArticlePath,
  helpAudienceLabel,
  helpSettingsPath,
  orderedArticles,
  popularArticles,
  relatedArticles,
  resolveLegacyAnchor,
} from "../index";
import { HELP_CATEGORIES, helpCategory, isHelpCategoryId } from "../categories";
import type { HelpArticle } from "../types";

function fixture(slug: string, fields: Partial<HelpArticle> = {}): HelpArticle {
  return {
    slug,
    title: slug,
    summary: "s",
    category: "builds",
    audience: "all",
    keywords: ["k"],
    updated: "2026-10-22",
    body: [{ type: "paragraph", text: "p" }],
    related: [],
    ...fields,
  };
}

describe("help categories", () => {
  it("lists every topic once, in display order", () => {
    expect(HELP_CATEGORIES.map((category) => category.id)).toEqual([
      "getting-started",
      "desktop-app",
      "analyzer",
      "game-page",
      "opponents",
      "builds",
      "stream-studio",
      "account-data",
      "troubleshooting",
    ]);
    expect(helpCategory("account-data").name).toBe("Account & data");
    expect(isHelpCategoryId("builds")).toBe(true);
    expect(isHelpCategoryId("nope")).toBe(false);
  });
});

describe("help registry", () => {
  it("looks articles up by slug", () => {
    expect(getArticle("getting-started")?.title).toBe("Getting started (5 minutes)");
    expect(getArticle("nope")).toBeUndefined();
    expect(helpArticlePath("stream-dock")).toBe("/help/stream-dock");
    expect(helpSettingsPath("stream-dock")).toBe("/settings?tab=help#stream-dock");
    expect(helpAnchorPath("opponents", "net-mmr")).toBe("/help/opponents#net-mmr");
  });

  it("lists an article's section anchors in reading order", () => {
    const article = fixture("anchored", {
      body: [
        { type: "heading", text: "First", anchor: "first" },
        { type: "paragraph", text: "p" },
        { type: "heading", text: "No anchor" },
        { type: "heading", text: "Second", anchor: "second" },
      ],
    });
    expect(helpArticleAnchors(article)).toEqual(["first", "second"]);
    expect(helpArticleAnchors(fixture("plain"))).toEqual([]);
  });

  it("groups articles by topic in display order, skipping empty topics", () => {
    const groups = articlesByCategory();
    expect(groups[0].category.id).toBe("getting-started");
    // Ordered by `order`: the 5-minute setup first, then how Help works.
    expect(groups[0].articles.map((article) => article.slug).slice(0, 2)).toEqual(["getting-started", "how-to-use-help"]);
    expect(groups.every((group) => group.articles.length > 0)).toBe(true);
    const order = HELP_CATEGORIES.map((category) => category.id);
    const shown = groups.map((group) => order.indexOf(group.category.id));
    expect([...shown].sort((a, b) => a - b)).toEqual(shown);
    expect(orderedArticles()).toHaveLength(ALL_HELP_ARTICLES.length);
  });

  it("orders a topic by `order`, then title", () => {
    const groups = articlesByCategory([
      fixture("zeta", { title: "Zeta" }),
      fixture("alpha", { title: "Alpha" }),
      fixture("first", { title: "Yankee", order: 1 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].articles.map((article) => article.slug)).toEqual(["first", "alpha", "zeta"]);
  });

  it("resolves slugs and legacy anchors, with or without #", () => {
    const articles = [fixture("new-name", { legacyAnchors: ["old-name"] }), fixture("other")];
    expect(resolveLegacyAnchor("#old-name", articles)).toBe("new-name");
    expect(resolveLegacyAnchor("old-name", articles)).toBe("new-name");
    expect(resolveLegacyAnchor("#new-name", articles)).toBe("new-name");
    expect(resolveLegacyAnchor("#Other", articles)).toBe("other");
    expect(resolveLegacyAnchor("#missing", articles)).toBeNull();
    expect(resolveLegacyAnchor("#", articles)).toBeNull();
    expect(resolveLegacyAnchor("#%E0%A4%A", articles)).toBeNull();
    expect(resolveLegacyAnchor("#build-check-in")).toBe("build-check-in");
  });

  it("returns related and popular articles that exist", () => {
    const article = getArticle("obs-overlay-setup");
    expect(article).toBeDefined();
    expect(relatedArticles(article!).map((item) => item.slug)).toEqual(article!.related);
    const popular = popularArticles();
    expect(popular[0].slug).toBe("getting-started");
    expect(popular.length).toBeGreaterThan(2);
  });

  it("formats dates in UTC and labels the audience", () => {
    expect(formatHelpDate("2026-10-22")).toBe("October 22, 2026");
    expect(formatHelpDate("2026-01-01")).toBe("January 1, 2026");
    expect(helpAudienceLabel(fixture("a", { audience: "streamer" }))).toBe("For streamers");
    expect(helpAudienceLabel(fixture("a", { audience: "player" }))).toBe("For players");
    expect(helpAudienceLabel(fixture("a", { audience: "all" }))).toBeNull();
  });
});
