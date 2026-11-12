import { expect, test } from "@playwright/test";
import { captureAccessibility, checkAccessibility } from "./accessibility-check";
import { openPracticeLinkFixture } from "./practice-link-fixture";

test.beforeEach(async ({ page }, info) => {
  if (info.project.name === "desktop-1280") return;
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Linux; Android 15) Chrome/140.0" });
    Object.defineProperty(navigator, "maxTouchPoints", { value: 5 });
  });
});

test("rejects an alias absent from the owner registry", async ({ request }) => {
  expect((await request.get("/b/no-such-practice-link")).status()).toBe(404);
});

test("allows Watch while explaining why unrecorded steps cannot be drilled or graded", async ({ page, request }, info) => {
  await openPracticeLinkFixture(page, request, "dark", true);
  await expect(page.getByRole("button", { name: "Play video" })).toBeVisible();
  await expect(page.getByText("This build has no recorded steps.")).toBeVisible();
  await page.getByRole("tab", { name: "Drill" }).click();
  await expect(page.getByText("This build has no timed steps for a drill.")).toBeVisible();
  await captureAccessibility(page, info, "practice-dark-no-steps", true);
  if (info.project.name === "desktop-1280" && info.project.use.browserName !== "firefox") {
    await page.getByRole("tab", { name: "Grade" }).click();
    await expect(page.getByText(/Grade needs at least six timed/)).toBeVisible();
  }
});

for (const theme of ["light", "dark"]) {
  test(`Practice Link Watch, Drill and supported Grade in ${theme}`, async ({ page, request }, info) => {
    const external: string[] = [];
    page.on("request", request => {
      if (request.url().includes("youtube")) external.push(request.url());
    });
    await page.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () => {
        Object.defineProperty(window, "SpeechSynthesisUtterance", { value: class { constructor(readonly text: string) {} } });
        Object.defineProperty(window, "speechSynthesis", { value: {
          getVoices: () => [], addEventListener() {}, removeEventListener() {}, cancel() {},
          speak: (utterance: SpeechSynthesisUtterance) => { document.body.dataset.lastSpeech = utterance.text; },
        } });
        Object.defineProperty(navigator, "canShare", { value: () => true });
        Object.defineProperty(navigator, "share", { value: async (data: ShareData) => {
          const image = await createImageBitmap(data.files![0]);
          document.body.dataset.share = `${image.width}x${image.height} ${data.text}`;
          image.close();
        } });
      });
    });
    await openPracticeLinkFixture(page, request, theme);
    const watch = page.getByRole("tab", { name: "Watch" });
    await expect(watch).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("button", { name: "Play video" })).toBeVisible();
    expect(external).toEqual([]);
    const expectNoHorizontalOverflow = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
    await expectNoHorizontalOverflow();
    await captureAccessibility(page, info, `practice-${theme}-watch`, true);
    await page.route("https://www.youtube.com/iframe_api", route => route.abort(), { times: 1 });
    const video = page.getByRole("group", { name: "Build video" });
    await page.getByRole("button", { name: "Play video" }).press("Enter");
    await expect(video).toBeFocused();
    await expect(page.getByRole("alert")).toContainText("YouTube playback is unavailable");
    await expectNoHorizontalOverflow();
    await captureAccessibility(page, info, `practice-${theme}-watch-error`, true);
    await page.getByRole("button", { name: "Retry video" }).press("Enter");
    await expect(video).toBeFocused();
    await expect(page.locator("iframe")).toBeVisible();
    await expect(page.getByRole("status")).toHaveCount(0);
    await page.getByRole("button", { name: /Gateway/ }).click();
    await expect(page.locator("[aria-current=step]")).toContainText("Gateway");
    expect(external.filter(url => url.endsWith("/iframe_api"))).toHaveLength(2);
    expect(external.some(url => url.startsWith("https://www.youtube-nocookie.com/embed/"))).toBe(true);

    await watch.focus();
    await watch.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Drill" })).toBeFocused();
    await expect(page.locator("iframe")).toHaveCount(0);
    const start = page.getByRole("button", { name: "Start drill" });
    expect((await start.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await start.click();
    await expect(page.locator("body")).toHaveAttribute("data-last-speech", "14 — Pylon");
    await page.getByRole("button", { name: "Forward one second" }).click();
    await page.getByRole("button", { name: "Pause" }).click();
    await expectNoHorizontalOverflow();
    await checkAccessibility(page, info, "/b/:alias", theme);
    await captureAccessibility(page, info, `practice-${theme}-drill`, true);

    const gradeTab = page.getByRole("tab", { name: "Grade" });
    if (info.project.name !== "desktop-1280" || info.project.use.browserName === "firefox") {
      await expect(gradeTab).toHaveCount(0);
      return;
    }
    await page.setViewportSize({ width: 1000, height: 800 });
    await expect(gradeTab).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
    await gradeTab.click();
    await expect(page.getByRole("button", { name: "Choose a replay" })).toBeVisible();
    await captureAccessibility(page, info, `practice-${theme}-grade-intake`, true);
    await page.locator('input[type="file"]').setInputFiles({ name: "broken.SC2Replay", mimeType: "application/octet-stream", buffer: Buffer.from("fixture") });
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await captureAccessibility(page, info, `practice-${theme}-grade-error`, true);
    await page.getByRole("button", { name: "Try again" }).press("Enter");
    await expect(page.getByRole("button", { name: "Choose a replay" })).toBeFocused();
    await page.locator('input[type="file"]').setInputFiles({ name: "local.SC2Replay", mimeType: "application/octet-stream", buffer: Buffer.from("fixture") });
    await page.getByRole("button", { name: /Local player/ }).click();
    await expect(page.getByText("Grade S")).toBeVisible();
    await expect(page.getByText(/different patch eras/)).toBeVisible();
    await page.getByRole("button", { name: "Share grade card" }).click();
    await expect(page.locator("body")).toHaveAttribute("data-share", /1200x630.*Fixture creator.*sc2tools\.com\/b\/fixture/s);
    const shared = await page.locator("body").getAttribute("data-share");
    expect(shared).not.toMatch(/private-fixture-id|Local player|local\.SC2Replay/);
    await captureAccessibility(page, info, `practice-${theme}-grade-result`, true);
  });
}
