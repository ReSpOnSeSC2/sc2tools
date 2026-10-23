import { describe, expect, it } from "vitest";
import { WHATS_NEW, matchesGoals } from "../whatsNew";
import { getArticle } from "../help";
import { GET } from "@/app/changelog/rss.xml/route";

describe("curated product updates", () => {
  it("keeps stable unique anchors, descending valid dates and resolving help links", () => {
    expect(new Set(WHATS_NEW.map((entry) => entry.id)).size).toBe(WHATS_NEW.length);
    for (const [i, entry] of WHATS_NEW.entries()) {
      expect(entry.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/); expect(Number.isFinite(Date.parse(entry.date))).toBe(true);
      if (i) expect(Date.parse(WHATS_NEW[i - 1].date)).toBeGreaterThanOrEqual(Date.parse(entry.date));
      if (entry.helpSlug) expect(getArticle(entry.helpSlug), entry.helpSlug).toBeDefined();
      expect(entry.highlights.length).toBeGreaterThan(0);
    }
  });
  it("filters the sheet by explicit goals while legacy and mixed goals keep the full catalogue", () => {
    const stream = WHATS_NEW.find((entry) => entry.audience === "stream-studio")!;
    expect(matchesGoals(stream, ["improve"])).toBe(false); expect(matchesGoals(stream, ["stream"])).toBe(true);
    expect(matchesGoals(stream)).toBe(true); expect(matchesGoals(stream, [])).toBe(true); expect(matchesGoals(stream, ["improve", "stream"])).toBe(true);
  });
  it("publishes a static escaped RSS item for every curated update", async () => {
    const response = GET(); const xml = await response.text(); const parsed = new DOMParser().parseFromString(xml, "application/xml");
    expect(response.headers.get("Content-Type")).toContain("application/rss+xml"); expect(parsed.querySelector("parsererror")).toBeNull();
    expect(parsed.querySelectorAll("item")).toHaveLength(WHATS_NEW.length); expect(xml).toContain("/changelog#personal-notifications-and-replies");
    expect(parsed.querySelector("item title")?.textContent).toBe(WHATS_NEW[0].title);
  });
});
