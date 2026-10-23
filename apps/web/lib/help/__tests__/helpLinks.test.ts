/**
 * Every place the app links to help must reach a real article: each
 * analyzer section's "How to read this", and every <HelpLink>,
 * <LazyHelpLink> and `helpSlug` written in the source. An unknown slug
 * renders as plain text (HelpLink never shows a dead link), so without
 * this check a typo would quietly drop the help link.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { slugForTab, TABS } from "@/components/analyzer/tabs";
import { getArticle } from "../index";

const WEB_ROOT = path.resolve(__dirname, "../../..");
const SOURCE_DIRS = ["app", "components", "lib"];

/** Source files (.ts/.tsx), skipping tests and generated output. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const HELP_LINK_SLUG_RE = /<(?:Lazy)?HelpLink\b[^>]*?\bslug=(?:"([^"]+)"|\{"([^"]+)"\})/g;
const HELP_SLUG_PROP_RE = /\bhelpSlug(?:=|:\s*)(?:"([^"]+)"|\{"([^"]+)"\})/g;

/** Every literal help slug a source file links to, with where it was found. */
function literalHelpSlugs(): Array<{ slug: string; where: string }> {
  const found: Array<{ slug: string; where: string }> = [];
  for (const dir of SOURCE_DIRS) {
    for (const file of sourceFiles(path.join(WEB_ROOT, dir))) {
      const source = readFileSync(file, "utf8");
      for (const re of [HELP_LINK_SLUG_RE, HELP_SLUG_PROP_RE]) {
        for (const match of source.matchAll(re)) {
          found.push({ slug: match[1] ?? match[2], where: path.relative(WEB_ROOT, file) });
        }
      }
    }
  }
  return found;
}

describe("help links in the app", () => {
  it("has a help article for every analyzer section, at the section's own slug", () => {
    for (const tab of TABS) {
      const slug = slugForTab(tab.id);
      const article = getArticle(slug);
      expect(article, `${tab.id} → /help/${slug}`).toBeDefined();
      expect(article?.category, slug).toBe("analyzer");
    }
    // Today (/app) is the landing page rather than a routed section.
    expect(getArticle("today")?.category).toBe("analyzer");
  });

  it("finds the help slugs written in the source", () => {
    const slugs = literalHelpSlugs().map((item) => item.slug);
    // A few known links, so a broken scan can't pass silently.
    expect(slugs).toEqual(expect.arrayContaining(["something-went-wrong", "analyzer-filters", "opponent-scouting"]));
  });

  it("points every HelpLink, LazyHelpLink and helpSlug at an existing article", () => {
    for (const { slug, where } of literalHelpSlugs()) {
      expect(getArticle(slug), `${where} links to /help/${slug}`).toBeDefined();
    }
  });
});
