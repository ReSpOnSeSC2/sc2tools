// Minimal service worker — exists so the site meets Chrome's PWA
// install criteria (a registered SW with a fetch handler). We deliberately
// do NOT cache responses: this is a live, auth-gated app and a stale cache
// would surface other users' data or stale opponent dossiers.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", () => {
  // Pass-through: let the browser handle every request normally.
});
