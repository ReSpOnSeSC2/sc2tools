import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ revalidateTag: vi.fn(), revalidatePath: vi.fn() }));
vi.mock("next/cache", () => ({ revalidateTag: mocks.revalidateTag, revalidatePath: mocks.revalidatePath }));

import { POST, dynamic, runtime } from "./route";
import { GUIDE_REVALIDATE_MAX_SKEW_MS } from "@/lib/guides/revalidateSignature";

const SECRET = "test-only-revalidate-secret";
const URL = "http://localhost/api/revalidate-guides";
const NOW = Date.parse("2026-09-28T03:15:00.000Z");

/** The API's real sender (CommonJS), loaded with Node's own require. */
interface CapturedRequest {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string };
}
type Revalidator = () => Promise<{ ok: boolean; status?: number }>;
interface ApiRevalidateModule {
  buildGuideRevalidator(deps: {
    url: string;
    secret: string;
    now: () => number;
    fetchImpl: (url: string, init: CapturedRequest["init"]) => Promise<{ ok: boolean; status: number }>;
  }): Revalidator;
}
const apiModule = createRequire(import.meta.url)(
  path.resolve(process.cwd(), "../api/src/services/guideRevalidate.js"),
) as ApiRevalidateModule;

/** Capture what the API would send at `ts`, without any network. */
async function apiPing(ts: number, secret = SECRET): Promise<Request> {
  let captured: CapturedRequest | null = null;
  const revalidate = apiModule.buildGuideRevalidator({
    url: URL,
    secret,
    now: () => ts,
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return { ok: true, status: 200 };
    },
  });
  await revalidate();
  if (!captured) throw new Error("the API revalidator sent nothing");
  const { init } = captured as CapturedRequest;
  return new Request(URL, { method: init.method, headers: init.headers, body: init.body });
}

function signed(body: string, ts: number, secret = SECRET): Request {
  const digest = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return new Request(URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-sc2tools-signature": `sha256=${digest}` },
    body,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("GUIDES_REVALIDATE_SECRET", SECRET);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  mocks.revalidateTag.mockReset();
  mocks.revalidatePath.mockReset();
});

describe("POST /api/revalidate-guides", () => {
  it("runs on Node and is never cached", async () => {
    expect(runtime).toBe("nodejs");
    expect(dynamic).toBe("force-dynamic");
    const res = await POST(await apiPing(NOW));
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("accepts the API's real signed ping (epoch ms) and purges tag, guide paths and sitemap", async () => {
    const res = await POST(await apiPing(NOW - 1000));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revalidated: true, tag: "guides" });
    expect(mocks.revalidateTag).toHaveBeenCalledWith("guides");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/guides", "layout");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/sitemap.xml");
  });

  it("accepts a ts at the edge of the ±5 min window", async () => {
    expect(GUIDE_REVALIDATE_MAX_SKEW_MS).toBe(300_000);
    expect((await POST(await apiPing(NOW - GUIDE_REVALIDATE_MAX_SKEW_MS))).status).toBe(200);
    expect((await POST(await apiPing(NOW + GUIDE_REVALIDATE_MAX_SKEW_MS))).status).toBe(200);
  });

  it.each([
    ["older than 5 min", NOW - GUIDE_REVALIDATE_MAX_SKEW_MS - 1],
    ["more than 5 min ahead", NOW + GUIDE_REVALIDATE_MAX_SKEW_MS + 1],
    ["in seconds, not milliseconds", Math.floor(NOW / 1000)],
  ])("rejects a validly signed ping whose ts is %s (401)", async (_why, ts) => {
    const res = await POST(await apiPing(ts));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "stale" });
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
  });

  it("rejects a wrong secret, a tampered body, a missing or malformed header (401)", async () => {
    const body = JSON.stringify({ ts: NOW, scope: "guides" });
    const wrongSecret = await apiPing(NOW, "someone-else");
    const tampered = signed(body, NOW);
    const tamperedReq = new Request(URL, {
      method: "POST",
      headers: tampered.headers,
      body: body.replace("guides", "guideZ"),
    });
    const noHeader = new Request(URL, { method: "POST", body });
    const badHeader = new Request(URL, { method: "POST", headers: { "x-sc2tools-signature": "sha256=zz" }, body });
    const notJson = signed("ts=1", NOW);
    for (const req of [wrongSecret, tamperedReq, noHeader, badHeader, notJson]) {
      const res = await POST(req);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "bad_signature" });
    }
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a signed ping for another scope (400)", async () => {
    const res = await POST(signed(JSON.stringify({ ts: NOW, scope: "reviews" }), NOW));
    expect(res.status).toBe(400);
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
  });

  it("answers 503 while GUIDES_REVALIDATE_SECRET is unset", async () => {
    vi.stubEnv("GUIDES_REVALIDATE_SECRET", "");
    const res = await POST(await apiPing(NOW));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "not_configured" });
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
  });

  it("refuses an oversized body (413)", async () => {
    const res = await POST(signed(JSON.stringify({ ts: NOW, scope: "guides", pad: "x".repeat(5000) }), NOW));
    expect(res.status).toBe(413);
  });

  it("names every HTTP status it answers (house rule: no bare numeric literals)", () => {
    const source = readFileSync(path.resolve(process.cwd(), "app/api/revalidate-guides/route.ts"), "utf8");
    expect(source).not.toMatch(/reply\(\s*\d/);
  });
});
