import { createHmac } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ tag: vi.fn(), path: vi.fn() }));
vi.mock("next/cache", () => ({ revalidateTag: h.tag, revalidatePath: h.path }));
import { POST } from "./route";
const secret = "local-community-secret", now = 1_790_000_000_000;
function request(scope = "community", ts = now, signedBy = secret, suffix = "") {
  const body = JSON.stringify({ ts, scope }) + suffix;
  return new Request("http://localhost/api/revalidate-community", { method: "POST", body,
    headers: { "x-sc2tools-signature": `sha256=${createHmac("sha256", signedBy).update(`${ts}.${body}`).digest("hex")}` } });
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv("COMMUNITY_REVALIDATE_SECRET", secret); h.tag.mockReset(); h.path.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

it("accepts the same HMAC protocol, purges only public Community/sitemap and never caches its response", async () => {
  const response = await POST(request()); expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(h.tag).toHaveBeenCalledTimes(1); expect(h.tag).toHaveBeenCalledWith("community");
  expect(h.path.mock.calls).toEqual([["/community", "layout"], ["/sitemap.xml"]]);
});
it.each([["guides", now, secret, 400], ["community", now - 300001, secret, 401], ["community", now, "wrong", 401]] as const)("rejects scope, stale timestamp or forged digest", async (scope, ts, signedBy, status) => {
  expect((await POST(request(scope, ts, signedBy))).status).toBe(status); expect(h.tag).not.toHaveBeenCalled();
});
it("is unavailable without the secret and rejects actual oversized bodies without trusting Content-Length", async () => {
  vi.stubEnv("COMMUNITY_REVALIDATE_SECRET", ""); expect((await POST(request())).status).toBe(503);
  vi.stubEnv("COMMUNITY_REVALIDATE_SECRET", secret); expect((await POST(request("community", now, secret, " ".repeat(4096)))).status).toBe(413);
  expect(h.tag).not.toHaveBeenCalled();
});
it("bounds a stalled request body and ignores late data", async () => {
  let enqueue!: (chunk: Uint8Array) => void;
  const body = new ReadableStream<Uint8Array>({ start(controller) { enqueue = value => { try { controller.enqueue(value); } catch { /* Cancelled. */ } }; } });
  const incoming = new Request("http://localhost/api/revalidate-community", { method: "POST", body, duplex: "half" } as RequestInit);
  const response = POST(incoming); await vi.advanceTimersByTimeAsync(2000);
  expect((await response).status).toBe(408); enqueue(new TextEncoder().encode("late"));
  expect(h.tag).not.toHaveBeenCalled();
});
