import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";
import path from "node:path";

const { JSDOM } = createRequire(path.resolve(process.cwd(), "package.json"))("jsdom") as {
  JSDOM: new (html: string, options?: { contentType: string }) => { window: { document: Document; close(): void } };
};

test("every sitemap route has its own canonical and coherent social title", async ({ request }, info) => {
  test.skip(info.project.name !== "desktop-1280", "Metadata is independent of viewport.");
  test.setTimeout(180_000);
  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.status()).toBe(200);
  const xml = new JSDOM(await sitemap.text(), { contentType: "text/xml" });
  const locations = [...xml.window.document.querySelectorAll("url > loc")].map(node => node.textContent || "");
  xml.window.close();
  expect(locations.length).toBeGreaterThan(10);
  // Build-time outages may leave only static sitemap rows until the hourly
  // refresh. Always exercise each synthetic dynamic page family as well.
  const origin = new URL(locations[0]).origin;
  const urls = [...new Set([...locations, ...[
    "/reviews/e2eReviewFixture", "/guides/pvz/stargate-into-glaives", "/guides/pvz/counter/12-pool",
    "/community/builds/fixture-community-polish", "/players/fixture-builder-0123456789",
  ].map(route => origin + route)])];

  const root = await request.get("/");
  const home = new JSDOM((await root.text()).match(/<(?:meta|link)\b[^>]*>/gi)?.join("") || "");
  const rootTitle = home.window.document.querySelector('meta[property="og:title"]')?.getAttribute("content");
  home.window.close();
  expect(rootTitle).toBeTruthy();

  // Four local reads at a time; no scripts, external assets or account APIs run.
  for (let offset = 0; offset < urls.length; offset += 4) {
    await Promise.all(urls.slice(offset, offset + 4).map(async location => {
      const expectedUrl = new URL(location);
      const route = expectedUrl.pathname + expectedUrl.search;
      // The ordinary Community request intentionally simulates an outage in
      // this suite. Its opt-in public fixture exercises indexable metadata
      // while preserving that existing outage coverage.
      const response = await request.get(route === "/community" ? "/community?q=fixture" : route);
      expect.soft(response.status(), route).toBe(200);
      const html = await response.text();
      const parsed = new JSDOM(html.match(/<(?:meta|link)\b[^>]*>/gi)?.join("") || "");
      try {
        const doc = parsed.window.document;
        const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute("href");
        expect.soft(canonical, route).toBeTruthy();
        if (canonical) expect.soft(new URL(canonical).href, route).toBe(expectedUrl.href);
        const title = doc.querySelector('meta[property="og:title"]')?.getAttribute("content");
        expect.soft(title, route).toBeTruthy();
        if (expectedUrl.pathname !== "/") expect.soft(title, route).not.toBe(rootTitle);
        expect.soft(doc.querySelector('meta[name="twitter:title"]')?.getAttribute("content"), route).toBe(title);
        expect.soft(doc.querySelector('meta[property="og:image"]')?.getAttribute("content"), route).toBeTruthy();
        expect.soft(doc.querySelector('meta[name="robots"]')?.getAttribute("content") || "", route).not.toContain("noindex");
      } finally { parsed.window.close(); }
    }));
  }
  info.annotations.push({ type: "metadata routes", description: String(urls.length) });
});

test("public social-image routes return real PNGs from local public fixtures", async ({ request }, info) => {
  test.skip(info.project.name !== "desktop-1280", "Image responses are independent of viewport.");
  for (const route of ["/try", "/download", "/community/builds/fixture-community-polish", "/community/authors/fixture-community-author"]) {
    const response = await request.get(route + "/opengraph-image");
    expect(response.status(), route).toBe(200);
    expect(response.headers()["content-type"], route).toContain("image/png");
    const png = await response.body();
    expect([...png.subarray(0, 8)], route).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect([png.readUInt32BE(16), png.readUInt32BE(20)], route).toEqual([1200, 630]);
  }
});
