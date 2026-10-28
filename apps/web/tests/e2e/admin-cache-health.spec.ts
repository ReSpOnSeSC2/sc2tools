import { expect, test, type Page } from "@playwright/test";
import { checkAccessibility } from "./accessibility-check";
import { openAdminCacheHealthFixture } from "./admin-cache-health-fixture.mjs";

const figures = ["Cache hits", "Cache misses", "Stored entries", "Accounted bytes", "Reserved bytes"];
const specimens = [
  { state: "old", status: "Not reported", values: null },
  { state: "malformed", status: "Not reported", values: null },
  { state: "off", status: "Off", values: null },
  { state: "zero", status: "Enabled", values: ["0", "0", "0", "0 B", "0 B"] },
  { state: "enabled", status: "Enabled", values: ["3", "4", "2", "1.00 kB", "512 B"] },
  { state: "maximum", status: "Enabled", values: ["9007199254740991", "9007199254740991", "512", "67.1 MB", "1 B"] },
];

async function tileGeometry(page: Page) {
  return page.getByRole("region", { name: "Personal chart cache", exact: true }).evaluate(card => {
    const border = card.getBoundingClientRect(), failures: Array<{ text: string; issue: string }> = [];
    for (const element of Array.from(card.querySelectorAll<HTMLElement>("h3,p,dt,dd"))) {
      const text = element.textContent?.trim() ?? "", style = getComputedStyle(element);
      if (style.textOverflow === "ellipsis" || style.webkitLineClamp !== "none") failures.push({ text, issue: "text is truncated" });
      const range = document.createRange(); range.selectNodeContents(element);
      for (const line of Array.from(range.getClientRects())) {
        if (line.left < border.left + 1 || line.right > border.right - 1 || line.top < border.top + 1 || line.bottom > border.bottom - 1) {
          failures.push({ text, issue: "rendered text escapes the card" }); break;
        }
      }
      if (element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1) failures.push({ text, issue: "label or value overflows its allocated space" });
    }
    return { failures, horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      width: border.width, height: border.height, text: card.textContent };
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`Personal chart cache ${theme}: honest status, contained labels and accessible figures`, async ({ page }, info) => {
    test.setTimeout(180_000);
    const evidence = await openAdminCacheHealthFixture(page, { theme });
    const widths = info.project.name === "mobile-360" ? [320, 390] : [info.project.name === "tablet-768" ? 768 : 1280];
    const observations = [];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      for (const specimen of specimens) {
        await evidence.showState(specimen.state);
        const card = page.getByRole("region", { name: "Personal chart cache", exact: true });
        await expect(card.getByRole("heading", { level: 3, name: "Personal chart cache", exact: true })).toBeVisible();
        await expect(card.getByRole("status")).toHaveText(specimen.status);
        await expect(card.locator("button,a,input,select,textarea,[role=switch],[role=checkbox],[contenteditable=true]")).toHaveCount(0);
        if (specimen.values) {
          await expect(card.locator("dt")).toHaveText(figures);
          await expect(card.locator("dd")).toHaveText(specimen.values);
          await expect(card).toContainText("Counts are for this API process since restart.");
          await expect(card).toContainText("not total process memory");
          await expect(card).not.toContainText(/saved|speedup|hit rate|%/i);
        } else {
          await expect(card.locator("dl,dt,dd")).toHaveCount(0);
          for (const label of figures) await expect(card.getByText(label, { exact: true })).toHaveCount(0);
          await expect(card).not.toContainText("0 B");
          if (specimen.state === "off") await expect(card).toContainText("Cache activity figures are hidden while it is off.");
          else await expect(card).toContainText("Cache status is unavailable from this API response.");
        }
        await expect(card).not.toContainText(/must-not-render|NaN|Infinity|Disabled/);
        const geometry = await tileGeometry(page);
        expect(geometry.failures, `${width}px ${specimen.state}`).toEqual([]);
        expect(geometry.horizontalOverflow, `${width}px ${specimen.state}`).toBe(false);
        observations.push({ width, state: specimen.state, status: specimen.status, ...geometry });
        await checkAccessibility(page, info, `/admin-cache-health-${width}-${specimen.state}`, theme);
        await info.attach(`cache-${theme}-${width}-${specimen.state}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      }
    }
    expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]);
    expect(evidence.requests.every(entry => entry.startsWith("GET https://admin-cache-health-fixture.local/") && !entry.includes("/v1/"))).toBe(true);
    await info.attach("cache-status-layout-and-boundaries", { body: JSON.stringify({ observations, errors: evidence.errors,
      requests: evidence.requests, unexpectedRequests: evidence.unexpectedRequests }), contentType: "application/json" });
  });
}
