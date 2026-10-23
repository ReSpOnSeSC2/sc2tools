/**
 * Every literal help link in the app resolves: <HelpLink> and
 * <LazyHelpLink> slugs (and section anchors), and `helpSlug` props on
 * empty states. A renamed article or heading id fails here instead of
 * leaving a link that renders as plain text.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getArticle, helpArticleAnchors } from "../index";

const WEB_ROOT = path.resolve(__dirname, "../../..");
const SOURCE_DIRS = ["app", "components"];
const HELP_LINK_RE = /<(?:Lazy)?HelpLink\b([^>]*)>/g;
const HELP_SLUG_PROP_RE = /\bhelpSlug="([^"]+)"/g;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tests__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) out.push(full);
  }
  return out;
}

interface Usage {
  file: string;
  slug: string;
  anchor: string | null;
}

function literalHelpLinks(): Usage[] {
  const usages: Usage[] = [];
  for (const dir of SOURCE_DIRS) {
    for (const file of sourceFiles(path.join(WEB_ROOT, dir))) {
      const source = readFileSync(file, "utf8");
      const name = path.relative(WEB_ROOT, file);
      for (const match of source.matchAll(HELP_LINK_RE)) {
        const slug = /\bslug="([^"]+)"/.exec(match[1])?.[1];
        if (slug) usages.push({ file: name, slug, anchor: /\banchor="([^"]+)"/.exec(match[1])?.[1] ?? null });
      }
      for (const match of source.matchAll(HELP_SLUG_PROP_RE)) usages.push({ file: name, slug: match[1], anchor: null });
    }
  }
  return usages;
}

describe("help links in the app", () => {
  const usages = literalHelpLinks();

  it("finds the links pages make", () => {
    expect(usages).toEqual(
      expect.arrayContaining([
        { file: path.join("app", "reviews", "(board)", "page.tsx"), slug: "replay-reviews", anchor: null },
        { file: path.join("app", "reviews", "(board)", "page.tsx"), slug: "replay-reviews", anchor: "asking-for-a-review" },
        { file: path.join("app", "reviews", "mine", "page.tsx"), slug: "replay-reviews", anchor: null },
        { file: path.join("components", "reviews", "ReviewPage.tsx"), slug: "replay-reviews", anchor: "who-can-review" },
        { file: path.join("app", "coaching", "CoachingWorkspace.tsx"), slug: "coaching", anchor: null },
      ]),
    );
  });

  it("points every literal slug and anchor at a real article section", () => {
    for (const { file, slug, anchor } of usages) {
      const article = getArticle(slug);
      expect(article, `${file}: no help article "${slug}"`).toBeDefined();
      if (article && anchor) {
        expect(helpArticleAnchors(article), `${file}: no section #${anchor} in "${slug}"`).toContain(anchor);
      }
    }
  });
});
