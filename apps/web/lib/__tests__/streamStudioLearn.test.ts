import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { ALL_WIDGETS } from "@/components/overlay/widgetLifecycle";
import { getArticle } from "@/lib/help";
import { WIDGET_GROUPS, WIDGET_GUIDES } from "@/lib/streamStudioLearn";

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Stream Studio learning catalog", () => {
  it("covers every supported widget exactly once", () => {
    const ids = WIDGET_GUIDES.map((guide) => guide.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...ALL_WIDGETS].sort());
  });

  it("ships a full-size visual example for every widget", async () => {
    for (const guide of WIDGET_GUIDES) {
      const image = await sharp(resolve(process.cwd(), "public/images/widget-examples", `${guide.id}.webp`)).metadata();
      expect(image.format, guide.id).toBe("webp");
      expect(image.width, guide.id).toBe(1400);
      expect(image.height, guide.id).toBe(900);
    }
  });

  it("uses the current Settings labels so instructions can be found", () => {
    const settings = source("components/analyzer/settings/overlayWidgetMeta.ts");
    const catalog = settings.match(/const WIDGETS:[\s\S]*?= \[([\s\S]*?)\n\];/)?.[1];
    expect(catalog).toBeTruthy();
    const labels = new Map(
      [...catalog!.matchAll(/id: "([^"]+)",\s*label: "([^"]+)"/g)]
        .map((match) => [match[1], match[2]]),
    );
    expect(labels.size).toBe(ALL_WIDGETS.length);
    for (const guide of WIDGET_GUIDES) expect(guide.name).toBe(labels.get(guide.id));
  });

  it("only recommends All-in-one for widgets it actually renders", () => {
    const client = source("components/OverlayClient.tsx");
    const composite = client.match(/const COMPOSITE_WIDGETS:[\s\S]*?= \[([\s\S]*?)\n\];/)?.[1];
    expect(composite).toBeTruthy();
    const ids = [...composite!.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    const recommended = WIDGET_GUIDES.filter((guide) => guide.source === "all-in-one").map((guide) => guide.id);
    expect([...recommended].sort()).toEqual([...ids].sort());
  });

  it("keeps instructions complete, navigable, and free of token URLs", () => {
    const groups = new Set(WIDGET_GROUPS.map((group) => group.id));
    expect(groups.size).toBe(5);
    for (const guide of WIDGET_GUIDES) {
      expect(groups.has(guide.group)).toBe(true);
      expect(guide.setup.length).toBeGreaterThanOrEqual(3);
      expect(guide.setup.length).toBeLessThanOrEqual(5);
      expect(guide.needs.length).toBeGreaterThan(0);
      expect(guide.example.headline).toMatch(/illustrative/i);
      expect(guide.example.lines.length).toBeGreaterThan(0);
      const settings = new URL(guide.settingsHref, "https://example.invalid");
      expect(settings.pathname).toBe("/settings"); expect(settings.searchParams.get("section")).toBe("widgets");
      expect(settings.searchParams.get("widget")).toBe(guide.id);
      expect(guide.recommendedSize.width).toBeGreaterThanOrEqual(100); expect(guide.recommendedSize.height).toBeGreaterThanOrEqual(100);
      expect(guide.check.length).toBeGreaterThan(30);
      expect(guide.troubleshooting.length).toBeGreaterThan(30);
      expect(guide.related.length).toBeGreaterThan(0);
      expect(new Set(guide.related).size).toBe(guide.related.length);
      for (const related of guide.related) {
        expect(ALL_WIDGETS).toContain(related);
        expect(related).not.toBe(guide.id);
      }
      expect(JSON.stringify(guide)).not.toMatch(/\/overlay\/[^\s]+|\/dock\/[^\s]+|https?:\/\//);
    }
  });

  it("teaches the manual controls and conditional states that commonly look broken", () => {
    const byId = new Map(WIDGET_GUIDES.map((guide) => [guide.id, guide]));
    expect(byId.get("build-profile")?.check).toContain("no Test button");
    expect(byId.get("build-profile")?.setup.join(" ")).toContain("Show widget");
    expect(byId.get("ghost-build")?.troubleshooting).toContain("old URL");
    expect(byId.get("countdown-timer")?.appears).toContain("until Clear");
    expect(byId.get("chat-highlight")?.appears).toContain("Clear highlight");
    expect(byId.get("chat-poll")?.explanation).toContain("Close poll");
    expect(byId.get("scouting")?.explanation).toContain("suppressed");
    expect(byId.get("cheese")?.explanation).toContain("40%");
  });

  it("tells streamers how much opponent history the scouting intel needs", () => {
    const byId = new Map(WIDGET_GUIDES.map((guide) => [guide.id, guide]));
    for (const id of ["fav-opening", "best-answer", "cheese", "scouting"] as const) {
      const guide = byId.get(id);
      expect(guide?.needs.join(" "), id).toMatch(/at least 2 earlier games vs this opponent in this matchup/i);
      expect(guide?.helpSlug, id).toBe("opponent-scouting");
    }
    expect(byId.get("fav-opening")?.example.lines.join(" ")).toContain("3 of last 5 games");
    for (const guide of WIDGET_GUIDES) {
      if (guide.helpSlug) expect(getArticle(guide.helpSlug), guide.id).toBeDefined();
    }
  });
});


it("describes saved Display time for each timed widget and leaves persistent visibility explicit", () => {
  const timed = WIDGET_GUIDES.filter(guide => ["opponent", "match-result", "post-game", "mmr-delta", "streak", "cheese", "rematch", "rival", "rank", "meta", "fav-opening", "best-answer", "scouting", "randomizer", "lower-third"].includes(guide.id));
  expect(timed).toHaveLength(15);
  for (const guide of timed) { expect(guide.appears).toContain("Default display time:"); expect(guide.appears).toContain("Save overlay display"); expect(guide.appears).toContain("20s"); }
  expect(WIDGET_GUIDES.find(guide => guide.id === "session")!.appears).not.toContain("Default display time:");
});
