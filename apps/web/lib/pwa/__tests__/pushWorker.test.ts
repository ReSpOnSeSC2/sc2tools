import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { expect, it, vi } from "vitest";

const source = fs.readFileSync(path.resolve(process.cwd(), "public/sw.js"), "utf8");

function worker(windows: Array<{ url: string; focus: ReturnType<typeof vi.fn>; navigate?: ReturnType<typeof vi.fn> }> = []) {
  const handlers = new Map<string, (event: unknown) => void>();
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const store = new Map<string, Response>();
  const cache = { put: vi.fn(async (key: string, res: Response) => { store.set(key, res); }), match: vi.fn(async (key: string) => store.get(key)), addAll: vi.fn() };
  const caches = { open: vi.fn().mockResolvedValue(cache), keys: vi.fn().mockResolvedValue([]), match: vi.fn(), delete: vi.fn() };
  const fetch = vi.fn().mockResolvedValue({ ok: true });
  const subscribe = vi.fn().mockResolvedValue({ toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/new", keys: { p256dh: "p", auth: "a" } }) });
  const self = {
    addEventListener: (name: string, callback: (event: unknown) => void) => handlers.set(name, callback),
    location: { origin: "https://sc2tools.com" },
    registration: { showNotification, pushManager: { subscribe } },
    clients: { claim: vi.fn(), matchAll: vi.fn().mockResolvedValue(windows), openWindow },
    skipWaiting: vi.fn(),
  };
  vm.runInNewContext(source, { self, caches, fetch, URL, Response, JSON });
  return { handlers, showNotification, openWindow, fetch, subscribe, cache };
}
const waitFor = () => { let done: Promise<unknown> = Promise.resolve(); return { waitUntil: (p: Promise<unknown>) => { done = p; }, get done() { return done; } }; };

it("answers the push protocol challenge on the transferred message port", () => {
  const w = worker();
  const reply = vi.fn();
  w.handlers.get("message")!({ data: { type: "PUSH_PROBE" }, ports: [{ postMessage: reply }] });
  expect(reply).toHaveBeenCalledWith({ type: "PUSH_READY", version: 1 });
  expect(w.cache.put).not.toHaveBeenCalled();
});

it("shows a push as a notification that keeps only a same-site destination", async () => {
  const w = worker(); const ev = waitFor();
  w.handlers.get("push")!({ ...ev, data: { json: () => ({ title: "Week 46: 23 games, 13–10", body: "Best map: Alcyone", href: "/app/reports/weekly/2026-W46", tag: "n:1" }) } });
  await ev.done;
  expect(w.showNotification).toHaveBeenCalledWith("Week 46: 23 games, 13–10", expect.objectContaining({ body: "Best map: Alcyone", tag: "n:1", data: { href: "/app/reports/weekly/2026-W46" } }));
  for (const href of ["https://evil.test/", "//evil.test/x", "javascript:alert(1)", "/\\evil"]) {
    const next = waitFor(); w.handlers.get("push")!({ ...next, data: { json: () => ({ title: "x", href }) } }); await next.done;
    expect(w.showNotification.mock.lastCall![1].data.href).toBe("/notifications");
  }
  const broken = waitFor(); w.handlers.get("push")!({ ...broken, data: { json: () => { throw new Error("not json"); } } }); await broken.done;
  expect(w.showNotification.mock.lastCall![0]).toBe("SC2 Tools");
});

it("a click focuses an open SC2 Tools tab and navigates it, or opens a new window", async () => {
  const focused = { navigate: vi.fn().mockResolvedValue(undefined) };
  const tab = { url: "https://sc2tools.com/app", focus: vi.fn().mockResolvedValue(focused) };
  const w = worker([{ url: "https://other.test/", focus: vi.fn() }, tab]);
  const close = vi.fn(); const ev = waitFor();
  w.handlers.get("notificationclick")!({ ...ev, notification: { close, data: { href: "/coaching" } } });
  await ev.done;
  expect(close).toHaveBeenCalled(); expect(tab.focus).toHaveBeenCalled();
  expect(focused.navigate).toHaveBeenCalledWith("https://sc2tools.com/coaching");
  const none = worker(); const ev2 = waitFor();
  none.handlers.get("notificationclick")!({ ...ev2, notification: { close: vi.fn(), data: { href: "https://evil.test" } } });
  await ev2.done;
  expect(none.openWindow).toHaveBeenCalledWith("https://sc2tools.com/notifications");
});

it("a rotated subscription is re-registered with the stored API origin and the old endpoint", async () => {
  const w = worker();
  const config = waitFor();
  w.handlers.get("message")!({ ...config, data: { type: "PUSH_CONFIG", api: "https://api.sc2tools.com" } });
  await config.done;
  const rejected = waitFor(); w.handlers.get("message")!({ ...rejected, data: { type: "PUSH_CONFIG", api: "https://api.sc2tools.com/path" } });
  expect(w.cache.put).toHaveBeenCalledTimes(1);
  const ev = waitFor();
  w.handlers.get("pushsubscriptionchange")!({ ...ev, oldSubscription: { endpoint: "https://fcm.googleapis.com/fcm/send/old", options: { applicationServerKey: new Uint8Array([4]) } } });
  await ev.done;
  expect(w.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: new Uint8Array([4]) });
  expect(w.fetch).toHaveBeenCalledWith("https://api.sc2tools.com/v1/push/subscription-change", expect.objectContaining({ method: "POST" }));
  expect(JSON.parse(w.fetch.mock.calls[0][1].body)).toEqual({ oldEndpoint: "https://fcm.googleapis.com/fcm/send/old", subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/new", keys: { p256dh: "p", auth: "a" } } });
});
