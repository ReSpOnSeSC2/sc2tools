import { describe, expect, it } from "vitest";
import { getArticle } from "../index";
import { helpArticleCrumbs, helpArticleJsonLd, helpFaqItems } from "../jsonLd";
import { helpSitemapRows } from "../sitemap";
import type { HelpArticle } from "../types";

const SITE = "https://sc2tools.com";

function article(slug: string): HelpArticle {
  const found = getArticle(slug);
  if (!found) throw new Error(slug);
  return found;
}

describe("help structured data", () => {
  it("builds a three-level breadcrumb trail", () => {
    expect(helpArticleCrumbs(article("stream-dock"))).toEqual([
      { name: "Help center", path: "/help" },
      { name: "Stream Studio", path: "/help#stream-studio" },
      { name: "Stream Dock (your control panel)", path: "/help/stream-dock" },
    ]);
    const [breadcrumbs] = helpArticleJsonLd(article("stream-dock"), SITE);
    expect(breadcrumbs).toMatchObject({
      "@type": "BreadcrumbList",
      itemListElement: [
        { position: 1, name: "Help center", item: `${SITE}/help` },
        { position: 2, item: `${SITE}/help#stream-studio` },
        { position: 3, item: `${SITE}/help/stream-dock` },
      ],
    });
  });

  it("marks troubleshooting question lists up as an FAQPage", () => {
    const faq = helpFaqItems(article("troubleshooting-and-support"));
    expect(faq[0]).toEqual({
      question: "Changes not showing in OBS?",
      answer: expect.stringContaining("Press Save first"),
    });
    const blocks = helpArticleJsonLd(article("troubleshooting-and-support"), SITE);
    expect(blocks.map((block) => block["@type"])).toEqual(["BreadcrumbList", "FAQPage"]);
    expect(blocks[1]).toMatchObject({
      mainEntity: expect.arrayContaining([
        { "@type": "Question", name: "Widget blank?", acceptedAnswer: { "@type": "Answer", text: expect.any(String) } },
      ]),
    });
  });

  it("marks a step-by-step article up as a HowTo with plain-text steps", () => {
    const blocks = helpArticleJsonLd(article("getting-started"), SITE);
    expect(blocks.map((block) => block["@type"])).toEqual(["BreadcrumbList", "HowTo"]);
    const howTo = blocks[1] as { step: Array<{ name: string; text: string; position: number }>; url: string };
    expect(howTo.url).toBe(`${SITE}/help/getting-started`);
    expect(howTo.step[0]).toMatchObject({ position: 1, name: "Create your account" });
    expect(howTo.step[0].text).not.toMatch(/\*\*|\]\(/);
  });

  it("adds only breadcrumbs when nothing else fits", () => {
    const blocks = helpArticleJsonLd(article("stream-dock"), SITE);
    expect(blocks.map((block) => block["@type"])).toEqual(["BreadcrumbList"]);
  });
});

describe("helpSitemapRows", () => {
  it("lists the hub and every article dated by its own update", () => {
    const rows = helpSitemapRows(SITE);
    expect(rows[0]).toMatchObject({ url: `${SITE}/help`, priority: 0.6 });
    const gettingStarted = rows.find((row) => row.url === `${SITE}/help/getting-started`);
    expect(gettingStarted?.lastModified).toEqual(new Date(article("getting-started").updated));
    expect(new Set(rows.map((row) => row.url)).size).toBe(rows.length);
  });

  it("dates the hub by its newest article and lists nothing without articles", () => {
    const rows = helpSitemapRows(SITE, [
      { ...article("stream-dock"), updated: "2026-01-02" },
      { ...article("getting-started"), updated: "2026-03-04" },
    ]);
    expect(rows[0].lastModified).toEqual(new Date("2026-03-04"));
    expect(rows.map((row) => row.url)).toEqual([
      `${SITE}/help`,
      `${SITE}/help/getting-started`,
      `${SITE}/help/stream-dock`,
    ]);
    expect(helpSitemapRows(SITE, [])).toEqual([]);
  });

  it("leaves noindex articles out, and dates the hub by the listed ones", () => {
    const rows = helpSitemapRows(SITE, [
      { ...article("stream-dock"), updated: "2026-01-02" },
      { ...article("getting-started"), updated: "2026-03-04", noindex: true },
    ]);
    expect(rows.map((row) => row.url)).toEqual([`${SITE}/help`, `${SITE}/help/stream-dock`]);
    expect(rows[0].lastModified).toEqual(new Date("2026-01-02"));
    expect(helpSitemapRows(SITE, [{ ...article("stream-dock"), noindex: true }])).toEqual([]);
  });
});
