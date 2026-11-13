import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { expect, it, vi } from "vitest";

const source = fs.readFileSync(path.resolve(process.cwd(), "public/sw.js"), "utf8");

function worker(windows: Array<{ url: string; focus: ReturnType<typeof vi.fn>; navigate?: ReturnType<typeof vi.fn> }> = []) {
  const handlers = new Map<string, (event: unknown) => void>();
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const getSubscription = vi.fn().mockResolvedValue({ endpoint: "https://fcm.googleapis.com/fcm/send/active" });
  const store = new Map<string, Response>();
  const cache = { put: vi.fn(async (key: string, res: Response) => { store.set(key, res); }), match: vi.fn(async (key: string) => store.get(key)), addAll: vi.fn() };
  const caches = { open: vi.fn().mockResolvedValue(cache), keys: vi.fn().mockResolvedValue([]), match: vi.fn(), delete: vi.fn() };
  const fetch = vi.fn().mockResolvedValue({ ok: true });
  const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/new", toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/new", keys: { p256dh: "p", auth: "a" } }) };
  const subscribe = vi.fn().mockResolvedValue(subscription);
  const self = {
    addEventListener: (name: string, callback: (event: unknown) => void) => handlers.set(name, callback),
    location: { origin: "https://sc2tools.com" },
    registration: { showNotification, pushManager: { subscribe, getSubscription } },
    clients: { claim: vi.fn(), matchAll: vi.fn().mockResolvedValue(windows), openWindow },
    skipWaiting: vi.fn(),
  };
  vm.runInNewContext(source, { self, caches, fetch, URL, Response, JSON });
  return { handlers, showNotification, openWindow, fetch, subscribe, subscription, getSubscription, cache };
}
const waitFor = () => { let done: Promise<unknown> = Promise.resolve(); return { waitUntil: (p: Promise<unknown>) => { done = p; }, get done() { return done; } }; };

it("answers the push protocol challenge on the transferred message port", () => {
  const w = worker();
  const reply = vi.fn();
  w.handlers.get("message")!({ data: { type: "PUSH_PROBE" }, ports: [{ postMessage: reply }] });
  expect(reply).toHaveBeenCalledWith({ type: "PUSH_READY", version: 1 });
  expect(w.cache.put).not.toHaveBeenCalled();
});

it("uses fixed copy for queued legacy payloads and keeps only opaque tags", async () => {
  const w = worker();
  const legacy = { title: "Week 46: 23 games, 13–10", body: "Best map: Alcyone", href: "/app/reports/weekly/2026-W46", tag: "n:1" };
  for (const tag of ["n:1", "n:" + "x".repeat(43), "push-test"]) {
    const ev = waitFor();
    w.handlers.get("push")!({ ...ev, data: { json: () => ({ ...legacy, tag }) } });
    await ev.done;
  }
  const icon = "/icons/pwa/icon-192.png";
  expect(w.showNotification).toHaveBeenNthCalledWith(1, "SC2 Tools", { body: "You have a new notification.", tag: undefined, icon });
  expect(w.showNotification).toHaveBeenNthCalledWith(2, "SC2 Tools", { body: "You have a new notification.", tag: "n:" + "x".repeat(43), icon });
  expect(w.showNotification).toHaveBeenNthCalledWith(3, "SC2 Tools test notification", { body: "Push notifications work on this device.", tag: "push-test", icon });
});

it("ignores a queued push once this browser has unsubscribed", async () => {
  const w = worker();
  w.getSubscription.mockResolvedValue(null);
  const ev = waitFor();
  w.handlers.get("push")!({ ...ev, data: { json: () => ({ tag: "push-test" }) } });
  await ev.done;
  expect(w.showNotification).not.toHaveBeenCalled();
});

it("a click focuses an open SC2 Tools tab and navigates it, or opens a new window", async () => {
  const focused = { navigate: vi.fn().mockResolvedValue(undefined) };
  const tab = { url: "https://sc2tools.com/app", focus: vi.fn().mockResolvedValue(focused) };
  const w = worker([{ url: "https://other.test/", focus: vi.fn() }, tab]);
  const close = vi.fn(); const ev = waitFor();
  w.handlers.get("notificationclick")!({ ...ev, notification: { close, data: { href: "/coaching" } } });
  await ev.done;
  expect(close).toHaveBeenCalled(); expect(tab.focus).toHaveBeenCalled();
  expect(focused.navigate).toHaveBeenCalledWith("https://sc2tools.com/notifications");
  const none = worker(); const ev2 = waitFor();
  none.handlers.get("notificationclick")!({ ...ev2, notification: { close: vi.fn(), data: { href: "https://evil.test" } } });
  await ev2.done;
  expect(none.openWindow).toHaveBeenCalledWith("https://sc2tools.com/notifications");
  const test = waitFor();
  none.handlers.get("notificationclick")!({ ...test, notification: { close: vi.fn(), tag: "push-test" } });
  await test.done;
  expect(none.openWindow).toHaveBeenLastCalledWith("https://sc2tools.com/settings?tab=preferences#push");
});

it("a rotated subscription is re-registered with the stored API origin and the old endpoint", async () => {
  const w = worker();
  const config = waitFor();
  w.handlers.get("message")!({ ...config, data: { type: "PUSH_CONFIG", api: "https://api.sc2tools.com" } });
  await config.done;
  const rejected = waitFor(); w.handlers.get("message")!({ ...rejected, data: { type: "PUSH_CONFIG", api: "https://api.sc2tools.com/path" } });
  expect(w.cache.put).toHaveBeenCalledTimes(1);
  const oldSubscription = { endpoint: "https://fcm.googleapis.com/fcm/send/old" };
  w.getSubscription.mockResolvedValue(w.subscription);
  const ev = waitFor();
  w.handlers.get("pushsubscriptionchange")!({ ...ev, oldSubscription, newSubscription: w.subscription });
  await ev.done;
  expect(w.subscribe).not.toHaveBeenCalled();
  expect(w.fetch).toHaveBeenCalledWith("https://api.sc2tools.com/v1/push/subscription-change", expect.objectContaining({ method: "POST" }));
  expect(JSON.parse(w.fetch.mock.calls[0][1].body)).toEqual({ oldEndpoint: "https://fcm.googleapis.com/fcm/send/old", subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/new", keys: { p256dh: "p", auth: "a" } } });
  const off = waitFor();
  w.getSubscription.mockResolvedValue(null);
  w.handlers.get("pushsubscriptionchange")!({ ...off, oldSubscription, newSubscription: null });
  await off.done;
  expect(w.subscribe).not.toHaveBeenCalled();
  expect(w.fetch).toHaveBeenCalledTimes(1);
});
