import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { expect, it, vi } from "vitest";
const source = fs.readFileSync(path.resolve(process.cwd(), "public/sw.js"), "utf8");
function worker() {
  const handlers = new Map<string, (event: unknown) => void>();
  const offline = { offline: true }; const fetch = vi.fn().mockRejectedValue(new Error("offline"));
  const addAll = vi.fn().mockResolvedValue(undefined); const claim = vi.fn().mockResolvedValue(undefined); const skipWaiting = vi.fn();
  const caches = { open: vi.fn().mockResolvedValue({ addAll }), match: vi.fn().mockResolvedValue(offline), keys: vi.fn().mockResolvedValue(["sc2tools-offline-v0", "sc2tools-offline-v1", "other-app-cache"]), delete: vi.fn().mockResolvedValue(true) };
  vm.runInNewContext(source, { self: { addEventListener: (name: string, callback: (event: unknown) => void) => handlers.set(name, callback), clients: { claim }, skipWaiting }, caches, fetch, URL, Response: { error: () => ({ error: true }) } });
  return { handlers, caches, fetch, offline, addAll, claim, skipWaiting };
}
it("falls back only on failed GET document navigation; never caches the page", async () => {
  const w = worker(); const respondWith = vi.fn(); const request = { method: "GET", mode: "navigate", url: "https://sc2tools.com/app" };
  w.handlers.get("fetch")!({ request, respondWith }); expect(await respondWith.mock.calls[0][0]).toBe(w.offline);
  expect(w.caches.match).toHaveBeenCalledWith("/offline.html"); expect(w.caches.open).not.toHaveBeenCalled();
  const network = { live: true }; w.fetch.mockResolvedValueOnce(network); respondWith.mockClear(); w.handlers.get("fetch")!({ request, respondWith });
  expect(await respondWith.mock.calls[0][0]).toBe(network);
});
it.each([["GET", "cors", "/v1/me"], ["POST", "navigate", "/app"], ["GET", "navigate", "/overlay/token"], ["GET", "navigate", "/dock/token"]])("passes through %s %s %s", (method, mode, pathname) => {
  const w = worker(); const respondWith = vi.fn(); w.handlers.get("fetch")!({ request: { method, mode, url: `https://sc2tools.com${pathname}` }, respondWith });
  expect(respondWith).not.toHaveBeenCalled(); expect(w.fetch).not.toHaveBeenCalled();
});
it("pre-caches only offline.html, tolerates cache failure and keeps explicit update consent", async () => {
  const w = worker(); const waitUntil = vi.fn(); w.handlers.get("install")!({ waitUntil }); await waitUntil.mock.calls[0][0];
  expect(w.addAll).toHaveBeenCalledWith(["/offline.html"]); expect(w.skipWaiting).not.toHaveBeenCalled();
  w.caches.open.mockRejectedValueOnce(new Error("quota")); w.handlers.get("install")!({ waitUntil }); await expect(waitUntil.mock.calls[1][0]).resolves.toBeUndefined();
  w.handlers.get("message")!({ data: { type: "SKIP_WAITING" } }); expect(w.skipWaiting).toHaveBeenCalledOnce();
});
it("cleans only old offline caches and claims clients", async () => {
  const w = worker(); const waitUntil = vi.fn(); w.handlers.get("activate")!({ waitUntil }); await waitUntil.mock.calls[0][0];
  expect(w.caches.delete.mock.calls).toEqual([["sc2tools-offline-v0"]]); expect(w.claim).toHaveBeenCalledOnce();
});
