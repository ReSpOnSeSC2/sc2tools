// Only the self-contained offline page is cached. API and page responses
// always use the network; no private data or JS/CSS chunks are cached.
// Updates still wait for explicit consent through ServiceWorkerRegister.
const OFFLINE_CACHE = "sc2tools-offline-v1";
// Push settings (the API origin for subscription rotation) live in their own
// one-entry cache so a restarted worker can still reach the API.
const PUSH_CONFIG_CACHE = "sc2tools-push-v1";
const PUSH_CONFIG_URL = "/__sc2tools_push_config";
const PUSH_WORKER_PROTOCOL = 1;
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(OFFLINE_CACHE).then((cache) => cache.addAll(["/offline.html"])).catch(() => {}));
});
self.addEventListener("message", (event) => {
  if (event.data?.type === "PUSH_PROBE") {
    event.ports[0]?.postMessage({ type: "PUSH_READY", version: PUSH_WORKER_PROTOCOL });
  }
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
  if (event.data && event.data.type === "PUSH_CONFIG" && typeof event.data.api === "string" && /^https?:\/\/[^/]+$/.test(event.data.api)) {
    event.waitUntil(caches.open(PUSH_CONFIG_CACHE).then((cache) => cache.put(PUSH_CONFIG_URL, new Response(JSON.stringify({ api: event.data.api })))).catch(() => {}));
  }
});
self.addEventListener("activate", (event) => {
  event.waitUntil(Promise.all([
    self.clients.claim(),
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("sc2tools-offline-") && key !== OFFLINE_CACHE).map((key) => caches.delete(key)))),
  ]));
});
function isDetachedSource(path) {
  try {
    path = decodeURI(path).toLowerCase();
  } catch {
    // Keep the existing bypass for a literal prefix with malformed encoding.
  }
  return path.startsWith("/overlay") || path.startsWith("/dock");
}
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || request.mode !== "navigate") return;
  const path = new URL(request.url).pathname;
  if (isDetachedSource(path)) return;
  event.respondWith(fetch(request).catch(() => caches.match("/offline.html").then((page) => page || Response.error())));
});

const PUSH_TEST_PATH = "/settings?tab=preferences#push";
const PUSH_TAG = /^n:[A-Za-z0-9_-]{43}$/;
function showPush(data) {
  const tag = data?.tag;
  const test = tag === "push-test";
  return self.registration.showNotification(test ? "SC2 Tools test notification" : "SC2 Tools", {
    body: test ? "Push notifications work on this device." : "You have a new notification.",
    tag: test || (typeof tag === "string" && PUSH_TAG.test(tag)) ? tag : undefined,
    icon: "/icons/pwa/icon-192.png",
  });
}
self.addEventListener("push", (event) => {
  let data;
  try { data = event.data?.json(); } catch { /* A legacy or malformed payload still shows safe copy. */ }
  event.waitUntil(self.registration.pushManager.getSubscription().then((subscription) => {
    if (subscription) return showPush(data);
  }));
});
// Focus an open SC2 Tools tab and send it to the notification's page, or open one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = event.notification.tag === "push-test" ? PUSH_TEST_PATH : "/notifications";
  const target = new URL(path, self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    const open = windows.find((client) => new URL(client.url).origin === self.location.origin && typeof client.focus === "function");
    if (!open) return self.clients.openWindow(target);
    return open.focus().then((client) => (client && typeof client.navigate === "function" ? client.navigate(target) : client));
  }));
});
// The browser replaced this device's subscription: hand the API the new one.
// The old endpoint proves which device row it replaces; no session is sent.
self.addEventListener("pushsubscriptionchange", (event) => {
  const previous = event.oldSubscription;
  if (!previous) return;
  event.waitUntil((async () => {
    const stored = await caches.open(PUSH_CONFIG_CACHE).then((cache) => cache.match(PUSH_CONFIG_URL)).then((res) => (res ? res.json() : null));
    const next = event.newSubscription;
    const current = await self.registration.pushManager.getSubscription();
    // Expiry without a browser-provided replacement needs a fresh owner enable.
    if (!stored?.api || !next || current?.endpoint !== next.endpoint) return;
    await fetch(`${stored.api}/v1/push/subscription-change`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ oldEndpoint: previous.endpoint, subscription: next.toJSON() }),
    });
  })().catch(() => {}));
});
