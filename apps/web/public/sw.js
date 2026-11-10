// Only the self-contained offline page is cached. API and page responses
// always use the network; no private data or JS/CSS chunks are cached.
// Updates still wait for explicit consent through ServiceWorkerRegister.
const OFFLINE_CACHE = "sc2tools-offline-v1";
// Push settings (the API origin for subscription rotation) live in their own
// one-entry cache so a restarted worker can still reach the API.
const PUSH_CONFIG_CACHE = "sc2tools-push-v1";
const PUSH_CONFIG_URL = "/__sc2tools_push_config";
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(OFFLINE_CACHE).then((cache) => cache.addAll(["/offline.html"])).catch(() => {}));
});
self.addEventListener("message", (event) => {
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
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || request.mode !== "navigate") return;
  const path = new URL(request.url).pathname;
  if (path.startsWith("/overlay") || path.startsWith("/dock")) return;
  event.respondWith(fetch(request).catch(() => caches.match("/offline.html").then((page) => page || Response.error())));
});

// A same-site path only: a push can never open another site.
function pushHref(value) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") ? value : "/notifications";
}
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = typeof data.title === "string" && data.title ? data.title.slice(0, 140) : "SC2 Tools";
  event.waitUntil(self.registration.showNotification(title, {
    body: typeof data.body === "string" ? data.body.slice(0, 280) : "",
    tag: typeof data.tag === "string" && data.tag ? data.tag.slice(0, 64) : undefined,
    icon: "/icons/pwa/icon-192.png",
    data: { href: pushHref(data.href) },
  }));
});
// Focus an open SC2 Tools tab and send it to the notification's page, or open one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(pushHref(event.notification.data && event.notification.data.href), self.location.origin).href;
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
    const key = previous.options && previous.options.applicationServerKey;
    if (!stored || !stored.api || !key) return;
    const next = event.newSubscription || await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await fetch(`${stored.api}/v1/push/subscription-change`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ oldEndpoint: previous.endpoint, subscription: next.toJSON() }),
    });
  })().catch(() => {}));
});
