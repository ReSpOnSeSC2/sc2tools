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

  const root = await request.get("/");
  const home = new JSDOM((await root.text()).match(/<(?:meta|link)\b[^>]*>/gi)?.join("") || "");
  const rootTitle = home.window.document.querySelector('meta[property="og:title"]')?.getAttribute("content");
  home.window.close();
  expect(rootTitle).toBeTruthy();

  // Four local reads at a time; no scripts, external assets or account APIs run.
  for (let offset = 0; offset < locations.length; offset += 4) {
    await Promise.all(locations.slice(offset, offset + 4).map(async location => {
      const expectedUrl = new URL(location);
      const route = expectedUrl.pathname + expectedUrl.search;
      const response = await request.get(route);
      expect(response.status(), route).toBe(200);
      const html = await response.text();
      const parsed = new JSDOM(html.match(/<(?:meta|link)\b[^>]*>/gi)?.join("") || "");
      try {
        const doc = parsed.window.document;
        const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute("href");
        expect(canonical, route).toBeTruthy();
        expect(new URL(canonical!).href, route).toBe(expectedUrl.href);
        const title = doc.querySelector('meta[property="og:title"]')?.getAttribute("content");
        expect(title, route).toBeTruthy();
        if (expectedUrl.pathname !== "/") expect(title, route).not.toBe(rootTitle);
        expect(doc.querySelector('meta[name="twitter:title"]')?.getAttribute("content"), route).toBe(title);
        expect(doc.querySelector('meta[property="og:image"]')?.getAttribute("content"), route).toBeTruthy();
        expect(doc.querySelector('meta[name="robots"]')?.getAttribute("content") || "", route).not.toContain("noindex");
      } finally { parsed.window.close(); }
    }));
  }
});
