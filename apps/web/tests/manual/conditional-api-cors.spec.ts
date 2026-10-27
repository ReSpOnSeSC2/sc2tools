import { expect, test as base, type Page } from "@playwright/test";
const { startConditionalApiCorsFixture } = require("./conditional-api-cors-fixture.cjs");

type WireCall = { method: string; url: string; origin: string | null; authorization: string | null;
  ifNoneMatch: string | null; requestedHeaders: string | null; status: number; etag: string | null;
  allowOrigin: string | null; allowHeaders: string | null; exposeHeaders: string | null; cacheControl: string | null;
  vary: string | null; contentType: string | null; contentLength: string | number | null; body: string };
type Harness = { browserOrigin: string; apiOrigin: string; calls: WireCall[]; buildEvidence: unknown;
  overflow: { calls: boolean; computes: boolean };
  computes: unknown[]; reads: () => WireCall[]; protocolFaults: (count: 1 | 2) => void;
  bumpOwner: (owner: string) => Promise<void>; counters: () => Record<string, number>;
  close: () => Promise<{ browser: { listening: boolean; openSockets: number }; api: { listening: boolean; openSockets: number } }> };

const test = base.extend<{ harness: Harness }>({
  harness: async ({ page }, provideHarness, info) => {
    const fixture: Harness = await startConditionalApiCorsFixture();
    const errors: string[] = [], blocked: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const allowed = new Set([fixture.browserOrigin, fixture.apiOrigin]);
    // Observe native transport without intercepting the CORS preflight path.
    // The fixture CSP confines scripts/fonts and connections to its local origins.
    page.on("request", request => {
      if (!allowed.has(new URL(request.url()).origin)) blocked.push(request.url());
    });
    try { await provideHarness(fixture); }
    finally {
      const counters = fixture.counters();
      const commits = await page.evaluate(() => ({
        records: (window as unknown as { etagFixtureCommits: unknown[] }).etagFixtureCommits,
        overflow: (window as unknown as { etagFixtureCommitOverflow: boolean }).etagFixtureCommitOverflow,
      })).catch(error => ({ records: [], overflow: true, collectionError: String(error) }));
      const closeReceipt = await fixture.close();
      await info.attach("real-cors-wire.json", { contentType: "application/json", body: Buffer.from(JSON.stringify({
        browserOrigin: fixture.browserOrigin, apiOrigin: fixture.apiOrigin, calls: fixture.calls,
        computes: fixture.computes, counters, errors, blocked, commits, overflow: fixture.overflow,
        closeReceipt, buildEvidence: fixture.buildEvidence,
      }, null, 2)) });
      expect(errors).toEqual([]); expect(blocked).toEqual([]);
      expect(fixture.overflow).toEqual({ calls: false, computes: false }); expect(commits.overflow).toBe(false);
      expect(closeReceipt).toEqual({ browser: { listening: false, openSockets: 0 }, api: { listening: false, openSockets: 0 } });
      expect(counters.active).toBe(0); expect(counters.queued).toBe(0);
      expect(counters.response_leases).toBe(0); expect(counters.reserved_bytes).toBe(0);
    }
  },
});

const tagPattern = /^W\/"uc1-[0-9a-f]{64}"$/;
async function idle(page: Page) { await expect(page.getByLabel("Request state", { exact: true })).toHaveText("idle"); }
async function dto(page: Page, owner = "owner-A", map = "Old", revision = 0) {
  await expect(page.getByRole("region", { name: "Rendered chart DTO" })).toHaveText(JSON.stringify({
    owner, map, revision, points: [{ day: "2026-10-27", games: revision + (map === "Old" ? 2 : 4) }],
  }));
}
async function readAfter(page: Page, fixture: Harness, action: () => Promise<unknown>, count = 1) {
  const before = fixture.reads().length;
  await action(); await expect.poll(() => fixture.reads().length).toBe(before + count); await idle(page);
  return fixture.reads().slice(before);
}
async function refresh(page: Page, fixture: Harness, count = 1) {
  return readAfter(page, fixture, () => page.getByRole("button", { name: "Refresh chart", exact: true }).click(), count);
}
async function warm(page: Page, fixture: Harness) {
  await page.goto(fixture.browserOrigin); await dto(page); await idle(page);
  expect(fixture.reads()).toHaveLength(1); expect(fixture.reads()[0].ifNoneMatch).toBeNull();
  await page.getByRole("button", { name: "Confirm enhancement ready" }).click();
  await expect(page.getByLabel("Enhancement state", { exact: true })).toHaveText("ready");
  const [retained] = await refresh(page, fixture);
  expect(retained.status).toBe(200); expect(retained.ifNoneMatch).toBeNull(); expect(retained.etag).toMatch(tagPattern);
  const [reconstructed] = await refresh(page, fixture);
  expect(reconstructed.status).toBe(304); expect(reconstructed.ifNoneMatch).toBe(retained.etag);
  expect(reconstructed.etag).toBe(retained.etag); expect(reconstructed.body).toBe("");
  expect(reconstructed.contentType).toBeNull(); expect(reconstructed.contentLength).toBeNull();
  await dto(page); await expect(page.getByRole("alert")).toHaveCount(0);
  return retained.etag!;
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
}

test("real CORS ETag/304 delivery preserves DTOs and owner, filter and #rev isolation", async ({ page, harness }, info) => {
  const firstTag = await warm(page, harness);
  // Native browser fetch: confirms JS header visibility rather than relying on DevTools/Node headers.
  const readable = await page.evaluate(async origin => {
    const response = await fetch(`${origin}/v1/timeseries?map=HeaderProbe`, {
      headers: { Authorization: "Bearer etag-browser-owner-A" }, cache: "no-store",
    });
    return { status: response.status, etag: response.headers.get("ETag"),
      cacheControl: response.headers.get("Cache-Control"), dto: await response.json() };
  }, harness.apiOrigin);
  expect(readable.status).toBe(200); expect(readable.etag).toMatch(tagPattern);
  expect(readable.cacheControl).toBe("private, no-cache"); expect(readable.dto.map).toBe("HeaderProbe");
  const preflight = harness.calls.filter(call => call.method === "OPTIONS");
  expect(preflight.some(call => call.status === 204 && call.origin === harness.browserOrigin && call.allowOrigin === harness.browserOrigin
    && call.requestedHeaders?.toLowerCase().includes("if-none-match") && String(call.allowHeaders).toLowerCase().includes("if-none-match"))).toBe(true);
  for (const call of harness.reads()) {
    expect(call.origin).toBe(harness.browserOrigin); expect(call.allowOrigin).toBe(harness.browserOrigin);
    expect(call.exposeHeaders?.split(",").map(value => value.trim())).toContain("ETag");
    expect(call.cacheControl).toBe("private, no-cache");
    expect(call.vary?.split(",").map(value => value.trim())).toEqual(expect.arrayContaining(["Origin", "Authorization"]));
    expect(call.authorization).toBe("Bearer etag-browser-owner-A");
  }
  const [filtered] = await readAfter(page, harness, () => page.getByRole("combobox", { name: "Map", exact: true }).selectOption("New"));
  expect(filtered.ifNoneMatch).toBeNull(); expect(filtered.status).toBe(200); expect(filtered.etag).not.toBe(firstTag);
  await dto(page, "owner-A", "New"); expect(JSON.parse(filtered.body).map).toBe("New");
  const [filteredSame] = await refresh(page, harness); expect(filteredSame.status).toBe(304); expect(filteredSame.ifNoneMatch).toBe(filtered.etag);
  const beforeRev = harness.computes.length;
  const [revision] = await readAfter(page, harness, () => page.getByRole("button", { name: "Advance local revision" }).click());
  expect(revision.ifNoneMatch).toBeNull(); expect(revision.status).toBe(200); expect(revision.url).toBe("/v1/timeseries?map=New");
  expect(harness.computes).toHaveLength(beforeRev); // #rev is a local identity; HTTP drops fragments.
  await expect(page.getByLabel("Resource identity", { exact: true })).toHaveText("/v1/timeseries?map=New#rev=2");
  const [b] = await readAfter(page, harness, () => page.getByRole("button", { name: "Use owner B" }).click());
  expect(b.ifNoneMatch).toBeNull(); expect(b.authorization).toBe("Bearer etag-browser-owner-B"); expect(b.etag).not.toBe(filtered.etag);
  await dto(page, "owner-B", "New");
  const [back] = await readAfter(page, harness, () => page.getByRole("button", { name: "Use owner A" }).click());
  expect(back.ifNoneMatch).toBeNull(); expect(back.authorization).toBe("Bearer etag-browser-owner-A"); await dto(page, "owner-A", "New");
  await harness.bumpOwner("owner-A"); const [changed] = await refresh(page, harness);
  expect(changed.status).toBe(200); expect(changed.etag).not.toBe(back.etag); await dto(page, "owner-A", "New", 1);
  const [sameChanged] = await refresh(page, harness); expect(sameChanged.status).toBe(304); expect(sameChanged.ifNoneMatch).toBe(changed.etag);
  expect(sameChanged.body).toBe(""); await dto(page, "owner-A", "New", 1);
  const commits = await page.evaluate(() => (window as unknown as { etagFixtureCommits: { owner: string; dataOwner: string | null; path: string }[] }).etagFixtureCommits);
  expect(commits.length).toBeGreaterThan(0);
  expect(commits.every(commit => commit.dataOwner === null || commit.dataOwner === commit.owner)).toBe(true);
  await noOverflow(page);
  await page.screenshot({ path: info.outputPath("conditional-api-cors-isolation.png"), fullPage: true });
});

test("one unconditional304 recovery is bounded and the real hook supports explicit Retry", async ({ page, harness }, info) => {
  const tag = await warm(page, harness);
  harness.protocolFaults(1);
  const recovered = await refresh(page, harness, 2);
  expect(recovered.map(call => call.status)).toEqual([304, 200]);
  expect(recovered.map(call => call.ifNoneMatch)).toEqual([tag, null]); expect(recovered[0].body).toBe("");
  expect(JSON.parse(recovered[1].body).owner).toBe("owner-A"); await dto(page); await expect(page.getByRole("alert")).toHaveCount(0);
  const [retained] = await refresh(page, harness); expect(retained.status).toBe(200); expect(retained.ifNoneMatch).toBeNull();
  harness.protocolFaults(2);
  const failed = await refresh(page, harness, 2);
  expect(failed.map(call => call.status)).toEqual([304, 304]); expect(failed.map(call => call.ifNoneMatch)).toEqual([retained.etag, null]);
  expect(failed.map(call => call.body)).toEqual(["", ""]);
  await expect(page.getByRole("alert")).toContainText("Select Retry");
  await expect(page.getByLabel("Error code", { exact: true })).toHaveText("conditional_body_missing"); await dto(page);
  const [retried] = await readAfter(page, harness, () => page.getByRole("button", { name: "Retry", exact: true }).click());
  expect(retried.ifNoneMatch).toBeNull(); expect(retried.status).toBe(200); await expect(page.getByRole("alert")).toHaveCount(0); await dto(page);
  const [same] = await refresh(page, harness); expect(same.status).toBe(304); expect(same.ifNoneMatch).toBe(retried.etag); expect(same.body).toBe("");
  await dto(page); await noOverflow(page);
  await page.screenshot({ path: info.outputPath("conditional-api-cors-retry.png"), fullPage: true });
});
