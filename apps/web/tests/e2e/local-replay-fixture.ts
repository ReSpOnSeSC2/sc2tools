import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { expect, type Page, type Request } from "@playwright/test";
import { checkManifest, checkPointer } from "../../lib/instant/engineManifest";

const REPLAY = path.resolve(__dirname, "../../../replay-engine/tests/fixtures/replays/warpgate_adept_tracking.SC2Replay");
export const REAL_REPLAY = readFileSync(REPLAY).toString("base64");

type ReplayFixture = { contents: string; name: string; lastModified: number };

export function localReplayRequestPaths(route: string) {
  const publicRoot = path.resolve(__dirname, "../../public");
  const readJson = (pathname: string): unknown => JSON.parse(readFileSync(path.join(publicRoot, pathname), "utf8"));
  const pointer = checkPointer(readJson("/engine/current.json"));
  const manifest = checkManifest(readJson(pointer.manifest));
  const staticRoot = path.resolve(__dirname, "../../.next/static");
  const nextAssets = readdirSync(staticRoot, { recursive: true, encoding: "utf8" })
    .filter((name) => statSync(path.join(staticRoot, name)).isFile())
    .map((name) => `/_next/static/${name.replaceAll(path.sep, "/")}`);
  return new Set([
    route, "/manifest.webmanifest",
    "/icons/pwa/icon-192.png", "/icons/pwa/icon-512.png", "/icons/pwa/apple-touch-icon.png",
    "/engine/current.json", pointer.manifest, ...manifest.assets.map((asset) => asset.path), ...nextAssets,
  ]);
}

export function isLocalReplayRequest(request: Request, site: string, allowedPaths: ReadonlySet<string>): boolean {
  const url = new URL(request.url());
  return url.origin === site && !url.search && allowedPaths.has(url.pathname) &&
    ["GET", "HEAD"].includes(request.method()) && request.postData() === null;
}

export async function assertNoReplayOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth),
  );
}

export async function dropLocalReplays(page: Page, files: ReplayFixture[]) {
  const transfer = await page.evaluateHandle((fixtures) => {
    const data = new DataTransfer();
    for (const { contents, lastModified, name } of fixtures) {
      const bytes = Uint8Array.from(atob(contents), (char) => char.charCodeAt(0));
      data.items.add(new File([bytes], name, { lastModified }));
    }
    return data;
  }, files);
  try {
    await page.getByRole("region", { name: "Choose your replays" }).dispatchEvent("drop", { dataTransfer: transfer });
  } finally {
    await transfer.dispose();
  }
}
