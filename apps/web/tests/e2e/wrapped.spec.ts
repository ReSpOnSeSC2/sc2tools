import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page, type Request } from "@playwright/test";
import { checkManifest, checkPointer } from "../../lib/instant/engineManifest";
import { captureAccessibility, checkAccessibility } from "./accessibility-check";

const ENABLED = process.env.NEXT_PUBLIC_INSTANT_IMPORT === "all";
const REPLAY = path.resolve(__dirname, "../../../replay-engine/tests/fixtures/replays/warpgate_adept_tracking.SC2Replay");
const REPLAY_MTIME = Date.UTC(2026, 4, 8);

function recapRequestPaths() {
  const publicRoot = path.resolve(__dirname, "../../public");
  const readJson = (pathname: string): unknown => JSON.parse(readFileSync(path.join(publicRoot, pathname), "utf8"));
  const pointer = checkPointer(readJson("/engine/current.json"));
  const manifest = checkManifest(readJson(pointer.manifest));
  const staticRoot = path.resolve(__dirname, "../../.next/static");
  const nextAssets = readdirSync(staticRoot, { recursive: true, encoding: "utf8" })
    .filter((name) => statSync(path.join(staticRoot, name)).isFile())
    .map((name) => `/_next/static/${name.replaceAll(path.sep, "/")}`);
  return new Set(["/wrapped", "/engine/current.json", pointer.manifest, ...manifest.assets.map((asset) => asset.path), ...nextAssets]);
}

function isRecapRequest(request: Request, site: string, allowedPaths: ReadonlySet<string>): boolean {
  const url = new URL(request.url());
  return url.origin === site && !url.search && allowedPaths.has(url.pathname) &&
    ["GET", "HEAD"].includes(request.method()) && request.postData() === null;
}

async function assertNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth),
  );
}

async function dropReplay(page: Page) {
  const transfer = await page.evaluateHandle(({ contents, lastModified }) => {
    const data = new DataTransfer();
    const bytes = Uint8Array.from(atob(contents), (char) => char.charCodeAt(0));
    data.items.add(new File([bytes], "Private Fixture.SC2Replay", { lastModified }));
    return data;
  }, { contents: readFileSync(REPLAY).toString("base64"), lastModified: REPLAY_MTIME });
  await page.getByRole("region", { name: "Choose your replays" }).dispatchEvent("drop", { dataTransfer: transfer });
}

test.describe("/wrapped local year recap", () => {
  test.skip(!ENABLED, "Instant Analysis must be rolled out to everyone");

  test("signed-out intake fits the viewport with accessible controls", async ({ page }, info) => {
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.goto("/wrapped");
      await expect(page.getByRole("heading", { name: "Your 2026 in StarCraft II" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Choose a folder" })).toBeVisible();
      await assertNoOverflow(page);
      await checkAccessibility(page, info, "/wrapped", theme);
      await captureAccessibility(page, info, `wrapped-${theme}`, true);
    }
  });

  test("reads a real replay without sending files, results or analytics", { tag: "@slow" }, async ({ page }, info) => {
    test.setTimeout(150_000);
    const site = new URL(String(info.project.use.baseURL)).origin;
    const allowedPaths = recapRequestPaths();
    const outbound: string[] = [], engine: string[] = [];
    await page.context().addCookies([{ url: site, name: "__session", value: "synthetic-expired" }]);
    page.context().on("request", (request) => {
      const url = new URL(request.url());
      if (!["http:", "https:"].includes(url.protocol)) return;
      if (!isRecapRequest(request, site, allowedPaths)) outbound.push(`${request.method()} ${url.href}`);
      if (url.origin === site && url.pathname === "/engine/current.json") engine.push(url.pathname);
    });
    await page.context().route("**/*", (route) => isRecapRequest(route.request(), site, allowedPaths) ? route.continue() : route.abort());
    await page.goto("/wrapped");
    expect(engine).toEqual([]);
    await dropReplay(page);
    await expect(page.getByRole("heading", { name: "Which player are you?" })).toBeVisible({ timeout: 120_000 });
    await page.getByRole("button", { name: /response/i }).click();
    const open = page.getByRole("button", { name: "View recap" });
    await expect(open).toBeVisible();
    await open.click();
    await expect(page.getByRole("dialog", { name: "Year in review" })).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(page.getByText("Time played", { exact: true })).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByText("Busiest month", { exact: true })).toBeVisible();
    await assertNoOverflow(page);
    await page.keyboard.press("Escape");
    await expect(open).toBeFocused();
    expect(engine).toHaveLength(1);
    expect(outbound).toEqual([]);
  });
});
