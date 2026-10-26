import { expect, it } from "vitest";
import { publicPlayerSitemapRows } from "@/lib/sitemapEntries";
it("includes only canonical public addresses and real content dates", () => {
  expect(publicPlayerSitemapRows("https://sc2tools.test", { items: [
    { handle: "frontier-0123456789", lastModified: "2026-10-20T00:00:00Z" },
    { handle: "11111111-1111-4111-8111-111111111111" }, { handle: "../admin" },
  ] })).toEqual([{ url: "https://sc2tools.test/players/frontier-0123456789", lastModified: new Date("2026-10-20T00:00:00Z"), changeFrequency: "weekly", priority: 0.4 }]);
  expect(publicPlayerSitemapRows("https://sc2tools.test", null)).toEqual([]);
});
