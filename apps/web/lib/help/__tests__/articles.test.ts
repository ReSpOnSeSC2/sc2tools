/**
 * Content checks for every help article: the conventions later articles
 * must follow (one file per article at <category>/<slug>.ts, unique
 * slugs, valid dates) and that every link an article makes resolves to a
 * real page, settings tab or article.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultTabVisibility, settingsTabFromParam } from "@/lib/settingsRegistry";
import { listHelpArticleFiles } from "@/scripts/gen-help-index.mjs";
import { ALL_HELP_ARTICLES, getArticle, helpArticleAnchors, resolveLegacyAnchor } from "../index";
import { helpSitemapRows } from "../sitemap";
import { helpArticleLinks, helpBlockText } from "../articleText";
import { isHelpCategoryId } from "../categories";
import { helpArticleSlugFromHref, helpHrefKind } from "../inline";
import { POPULAR_HELP_SLUGS } from "../popular";
import { HELP_WIDGET_IDS } from "../widgets";
import type { HelpArticle } from "../types";

const WEB_ROOT = path.resolve(__dirname, "../../..");
const APP_DIR = path.join(WEB_ROOT, "app");
const PUBLIC_DIR = path.join(WEB_ROOT, "public");
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function hasPage(dir: string): boolean {
  return ["page.tsx", "page.ts", "page.jsx", "page.js"].some((file) => existsSync(path.join(dir, file)));
}

/** True when the app router has a page for these path segments. */
function routeExists(segments: string[], dir = APP_DIR): boolean {
  if (segments.length === 0 && hasPage(dir)) return true;
  const dirs = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  // Route groups are transparent; optional catch-alls match zero or more segments.
  if (dirs.some((name) => /^\(.+\)$/.test(name) && routeExists(segments, path.join(dir, name)))) return true;
  if (dirs.some((name) => /^\[\[\.\.\..+\]\]$/.test(name) && hasPage(path.join(dir, name)))) return true;
  if (segments.length === 0) return false;
  const [head, ...rest] = segments;
  if (dirs.includes(head) && routeExists(rest, path.join(dir, head))) return true;
  if (dirs.some((name) => /^\[\.\.\..+\]$/.test(name) && hasPage(path.join(dir, name)))) return true;
  return dirs.some((name) => /^\[[^.\]]+\]$/.test(name) && routeExists(rest, path.join(dir, name)));
}

/** Why an in-app link is broken, or null when it resolves. */
function brokenInternalLink(href: string): string | null {
  const url = new URL(href, "https://sc2tools.com");
  const slug = helpArticleSlugFromHref(url.pathname);
  if (slug) {
    const article = getArticle(slug);
    if (!article) return `no help article "${slug}"`;
    const anchor = url.hash.slice(1);
    if (anchor && !helpArticleAnchors(article).includes(anchor)) return `no section #${anchor} in "${slug}"`;
    return null;
  }
  if (!routeExists(url.pathname.split("/").filter(Boolean))) return `no page at ${url.pathname}`;
  if (url.pathname === "/settings") {
    const tab = url.searchParams.get("tab");
    const canonicalTab = settingsTabFromParam(tab);
    if (tab !== null && !(canonicalTab && defaultTabVisibility(canonicalTab))) return `no visible settings tab "${tab}"`;
    if (url.hash && tab === "help" && !resolveLegacyAnchor(url.hash)
      && !(url.hash === "#my-reports" && readFileSync(path.join(process.cwd(), "components/notifications/MyReports.tsx"), "utf8").includes('id="my-reports"'))) return `no help section ${url.hash}`;
  }
  return null;
}

function allTextFields(article: HelpArticle): string[] {
  return [article.title, article.summary, ...article.body.map(helpBlockText)];
}

describe("help articles", () => {
  it.each(["account", "foundation", "preferences", "misc", "overlay", "streaming"])("accepts the visible Settings destination %s, including old aliases", (tab) => {
    expect(brokenInternalLink(`/settings?tab=${tab}`)).toBeNull();
  });

  it("still rejects an unknown Settings destination", () => {
    expect(brokenInternalLink("/settings?tab=no-such-tab")).toBe('no visible settings tab "no-such-tab"');
  });

  it("ships the Settings → Help guide plus the new getting-started articles", () => {
    for (const slug of [
      "getting-started",
      "how-to-use-help",
      "dashboard-and-analyzer",
      "build-check-in",
      "obs-overlay-setup",
      "multi-platform-chat",
      "stream-dock",
      "viewer-engagement",
      "troubleshooting-and-support",
      "backups-and-export",
      // The how-tos for features that shipped without one.
      "install-and-pair",
      "browser-import",
      "desktop-app-overview",
      "replay-folders",
      "today",
      "analyzer-filters",
      "opponents",
      "strategies",
      "trends",
      "macro",
      "maps",
      "builds",
      "replays",
      "arcade",
      "reading-the-charts",
      "game-page",
      "game-page-replay",
      "game-page-accurate-playback",
      "opponent-dossier",
      "custom-builds",
      "rules-explained",
      "practice-ghost-build",
      "randomizer",
      "publish-community-builds",
      "delete-account",
      "public-profile",
      "player-channels",
      "voice",
      "obs-auto-scene-switching",
      "my-game-didnt-show-up",
      "a-page-asked-me-to-sign-in",
    ]) {
      expect(getArticle(slug), slug).toBeDefined();
    }
    expect(getArticle("backups-and-export")?.category).toBe("account-data");
    expect(getArticle("how-to-use-help")?.category).toBe("getting-started");
  });

  it("has unique, well-formed slugs", () => {
    const slugs = ALL_HELP_ARTICLES.map((article) => article.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(SLUG_RE);
  });

  it("keeps one file per article at <category>/<slug>.ts", () => {
    // The generated registry lists files in the same order as ALL_HELP_ARTICLES.
    const files = listHelpArticleFiles();
    expect(files).toHaveLength(ALL_HELP_ARTICLES.length);
    ALL_HELP_ARTICLES.forEach((article, index) => {
      expect(files[index], article.slug).toBe(`${article.category}/${article.slug}.ts`);
    });
  });

  it("fills every required field with a known category, audience and real date", () => {
    for (const article of ALL_HELP_ARTICLES) {
      expect(isHelpCategoryId(article.category), article.slug).toBe(true);
      expect(["player", "streamer", "all"], article.slug).toContain(article.audience);
      expect(article.title.trim(), article.slug).not.toBe("");
      expect(article.summary.trim(), article.slug).not.toBe("");
      expect(article.keywords.length, article.slug).toBeGreaterThan(0);
      expect(article.body.length, article.slug).toBeGreaterThan(0);
      expect(article.updated, article.slug).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const date = new Date(`${article.updated}T00:00:00Z`);
      expect(date.toISOString().slice(0, 10), `${article.slug} updated`).toBe(article.updated);
    }
  });

  it("closes all inline markup", () => {
    for (const article of ALL_HELP_ARTICLES) {
      for (const text of allTextFields(article)) {
        expect(text, article.slug).not.toMatch(/\*\*|\]\(|`/);
      }
    }
  });

  it("links related articles that exist, never itself or twice", () => {
    for (const article of ALL_HELP_ARTICLES) {
      expect(new Set(article.related).size, article.slug).toBe(article.related.length);
      for (const slug of article.related) {
        expect(slug, article.slug).not.toBe(article.slug);
        expect(getArticle(slug), `${article.slug} → related ${slug}`).toBeDefined();
      }
    }
  });

  it("resolves every link: pages, settings tabs, help sections and articles", () => {
    for (const article of ALL_HELP_ARTICLES) {
      for (const href of helpArticleLinks(article)) {
        const kind = helpHrefKind(href);
        expect(kind, `${article.slug}: ${href}`).not.toBeNull();
        if (kind === "internal") expect(brokenInternalLink(href), `${article.slug}: ${href}`).toBeNull();
      }
    }
  });

  it("has a link checker that catches broken links", () => {
    for (const ok of ["/", "/sign-up", "/devices", "/app", "/settings", "/settings?tab=import", "/settings?tab=checkin", "/settings?tab=help#build-check-in", "/settings?tab=help#my-reports", "/help/getting-started", "/help/opponents#net-mmr", "/help/replay-reviews#who-can-review"]) {
      expect(brokenInternalLink(ok), ok).toBeNull();
    }
    for (const broken of ["/nope", "/settings?tab=nope", "/settings?tab=help#nope", "/help/nope", "/help/opponents#nope", "/help/replay-reviews#nope"]) {
      expect(brokenInternalLink(broken), broken).not.toBeNull();
    }
  });

  it("points settingsLink blocks at in-app pages", () => {
    const hrefs = ALL_HELP_ARTICLES.flatMap((article) =>
      article.body.flatMap((block) => (block.type === "settingsLink" ? [block.href] : [])),
    );
    expect(hrefs).toContain("/settings?tab=overlay");
    for (const href of hrefs) expect(helpHrefKind(href), href).toBe("internal");
  });

  it("keeps legacy anchors unique and resolving to their article", () => {
    const taken = new Set(ALL_HELP_ARTICLES.map((article) => article.slug));
    for (const article of ALL_HELP_ARTICLES) {
      for (const anchor of article.legacyAnchors ?? []) {
        expect(taken.has(anchor), `${article.slug}: legacy anchor ${anchor} is already used`).toBe(false);
        taken.add(anchor);
        expect(resolveLegacyAnchor(`#${anchor}`)).toBe(article.slug);
      }
    }
    // The Build check-in settings page and older links use this anchor.
    expect(resolveLegacyAnchor("#build-check-in")).toBe("build-check-in");
  });

  it("uses known widgets, local images with alt text and rectangular tables", () => {
    for (const article of ALL_HELP_ARTICLES) {
      for (const block of article.body) {
        if (block.type === "widget") expect(HELP_WIDGET_IDS, article.slug).toContain(block.widget);
        if (block.type === "image") {
          expect(block.alt.trim(), article.slug).not.toBe("");
          expect(block.src, article.slug).toMatch(/^\/[^/]/);
          expect(existsSync(path.join(PUBLIC_DIR, block.src)), `${article.slug}: ${block.src}`).toBe(true);
        }
        if (block.type === "table") {
          for (const row of block.rows) expect(row, article.slug).toHaveLength(block.head.length);
        }
        if (block.type === "steps" || block.type === "list") expect(block.items.length, article.slug).toBeGreaterThan(0);
      }
    }
  });

  it("gives section anchors a stable, unique id within each article", () => {
    for (const article of ALL_HELP_ARTICLES) {
      const anchors = helpArticleAnchors(article);
      expect(new Set(anchors).size, `${article.slug}: repeated anchor`).toBe(anchors.length);
      for (const anchor of anchors) expect(anchor, article.slug).toMatch(SLUG_RE);
    }
  });

  it("covers each analyzer section: what it answers, how to drill in and how much data it needs", () => {
    for (const slug of ["today", "opponents", "strategies", "trends", "macro", "maps", "builds", "arcade"]) {
      const article = getArticle(slug);
      expect(article?.category, slug).toBe("analyzer");
      expect(helpArticleAnchors(article!), slug).toContain("sample-size");
    }
    // The anchors the filter bar's and the tables' info tips link to.
    expect(helpArticleAnchors(getArticle("analyzer-filters")!)).toEqual(
      expect.arrayContaining(["defaults", "patch-presets", "too-short", "matchup", "active-filters"]),
    );
    expect(helpArticleAnchors(getArticle("opponents")!)).toEqual(
      expect.arrayContaining(["group-same-player", "mmr-impact", "net-mmr", "pulse-id"]),
    );
    expect(helpArticleAnchors(getArticle("reading-the-charts")!)).toContain("min-games");
  });

  it("says the numbers come from fixed rules, never AI, wherever stats are explained", () => {
    for (const slug of ["dashboard-and-analyzer", "today", "opponents", "macro", "reading-the-charts", "game-page"]) {
      const text = allTextFields(getArticle(slug)!).join(" ");
      expect(text, slug).toMatch(/fixed rules, never AI/);
    }
  });

  it("lists only existing articles as Popular", () => {
    for (const slug of POPULAR_HELP_SLUGS) expect(getArticle(slug), slug).toBeDefined();
  });

  it("keeps section anchors well-formed and unique within each article", () => {
    for (const article of ALL_HELP_ARTICLES) {
      const anchors = helpArticleAnchors(article);
      expect(new Set(anchors).size, article.slug).toBe(anchors.length);
      for (const anchor of anchors) expect(anchor, article.slug).toMatch(SLUG_RE);
    }
  });
});

describe("reviews and coaching articles", () => {
  it("explains replay reviews publicly, section by section", () => {
    const article = getArticle("replay-reviews");
    expect(article?.category).toBe("reviews-coaching");
    expect(article?.audience).toBe("all");
    expect(article?.signedInOnly).toBeFalsy();
    expect(article?.noindex).toBeFalsy();
    // Other pages and later articles link to these; never rename one.
    expect(helpArticleAnchors(article!)).toEqual([
      "how-it-works",
      "asking-for-a-review",
      "finding-requests",
      "writing-a-review",
      "who-can-review",
      "karma-and-badges",
      "your-reviewer-profile",
      "my-reviews",
      "closing-and-sharing",
      "blocking-and-reporting",
    ]);
    const text = allTextFields(article!).join(" ");
    expect(text).toContain("20 to 500 characters");
    expect(text).toContain("all of the game's chat");
    expect(text).toContain("20 games synced");
    expect(text).toContain("15 minutes");
    expect(text).toContain("Race (asker race)");
    expect(text).toContain("Search the game picker");
    expect(helpArticleLinks(article!)).toEqual(expect.arrayContaining(["/download", "/reviews", "/reviews/mine"]));
  });

  it("keeps the invite-only coaching article signed-in, unindexed and out of the sitemap", () => {
    const article = getArticle("coaching");
    expect(article?.category).toBe("reviews-coaching");
    expect(article?.signedInOnly).toBe(true);
    expect(article?.noindex).toBe(true);
    expect(helpArticleAnchors(article!)).toEqual([
      "roles-and-linking",
      "locker",
      "practice-sharing",
      "practice-plans",
      "how-progress-is-counted",
      "sessions",
    ]);
    expect(allTextFields(article!).join(" ")).toContain("the workspace never grades or scores your play");
    const urls = helpSitemapRows("https://sc2tools.com").map((row) => row.url);
    expect(urls).not.toContain("https://sc2tools.com/help/coaching");
    expect(urls).toContain("https://sc2tools.com/help/replay-reviews");
  });
});
