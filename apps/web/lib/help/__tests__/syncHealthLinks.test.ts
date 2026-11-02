/**
 * Every help link Sync health makes lands on a real section. The slugs and
 * anchors live in lib/syncHealth.ts (not in JSX literals), and the API sends
 * its own `helpSlug`s, so the literal-slug scans in helpLinks.test.ts and
 * helpLinkUsage.test.ts cannot see them.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SYNC_HEALTH_CODES,
  SYNC_HEALTH_HELP,
  SYNC_NOT_REPORTED_HELP,
  SYNC_REASONS,
  SYNC_WINDOW_REASON,
  doctorHelp,
} from "@/lib/syncHealth";
import { getArticle, helpArticleAnchors } from "../index";

function sections(): Array<{ where: string; slug: string; anchor?: string }> {
  return [
    { where: "the card", slug: SYNC_HEALTH_HELP.helpSlug, anchor: SYNC_HEALTH_HELP.anchor },
    { where: "not reported", slug: SYNC_NOT_REPORTED_HELP.helpSlug, anchor: SYNC_NOT_REPORTED_HELP.anchor },
    ...SYNC_HEALTH_CODES.map((code) => ({ where: code, slug: SYNC_REASONS[code].helpSlug, anchor: SYNC_REASONS[code].anchor })),
    { where: "sync window", slug: SYNC_WINDOW_REASON.helpSlug, anchor: SYNC_WINDOW_REASON.anchor },
    ...(SYNC_WINDOW_REASON.fix.kind === "help" ? [{ where: "Change sync window", slug: SYNC_WINDOW_REASON.fix.helpSlug, anchor: SYNC_WINDOW_REASON.fix.anchor }] : []),
    ...SYNC_HEALTH_CODES.map((code) => ({ where: `Doctor ${code}`, ...doctorHelp({ id: code })! })),
  ];
}

describe("Sync health help links", () => {
  it("points every reason, fix and state at an existing article section", () => {
    const links = sections();
    expect(links.length).toBeGreaterThan(SYNC_HEALTH_CODES.length * 2);
    for (const { where, slug, anchor } of links) {
      const article = getArticle(slug);
      expect(article, `${where} → /help/${slug}`).toBeDefined();
      if (article && anchor) expect(helpArticleAnchors(article), `${where} → /help/${slug}#${anchor}`).toContain(anchor);
    }
  });

  it("gives each reason its own section of Why didn't my game show up?", () => {
    const anchors = SYNC_HEALTH_CODES.map((code) => SYNC_REASONS[code].anchor);
    expect(new Set(anchors).size).toBe(anchors.length);
    expect(getArticle("my-game-didnt-show-up")?.updated).toBe("2026-11-01");
  });

  it("resolves every helpSlug the API's rules send", () => {
    const source = readFileSync(path.resolve(__dirname, "../../../../api/src/services/syncHealth.js"), "utf8");
    const rules = source.match(/SYNC_HEALTH_RULES = Object\.freeze\(\{([\s\S]*?)\n\}\);/)?.[1] ?? "";
    const slugs = [...rules.matchAll(/helpSlug: "([a-z0-9-]+)"/g)].map((match) => match[1]);
    expect(slugs).toHaveLength(SYNC_HEALTH_CODES.length);
    for (const slug of slugs) expect(getArticle(slug), slug).toBeDefined();
  });
});
