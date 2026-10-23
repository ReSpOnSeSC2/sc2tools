// Only the self-contained offline page is cached. API and page responses
// always use the network; no private data or JS/CSS chunks are cached.
// Updates still wait for explicit consent through ServiceWorkerRegister.
const OFFLINE_CACHE = "sc2tools-offline-v1";
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(OFFLINE_CACHE).then((cache) => cache.addAll(["/offline.html"])).catch(() => {}));
});
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
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
