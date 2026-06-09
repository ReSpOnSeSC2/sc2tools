// Minimal service worker — exists so the site meets Chrome's PWA
// install criteria (a registered SW with a fetch handler). We deliberately
// do NOT cache responses: this is a live, auth-gated app and a stale cache
// would surface other users' data or stale opponent dossiers.
//
// Update flow: install does NOT call skipWaiting() unconditionally —
// that silently swapped workers mid-session with no way to tell the
// user new code shipped. Instead the new worker idles in `waiting`
// until the page (ServiceWorkerRegister) shows an "Update available"
// prompt and posts SKIP_WAITING on user consent; `controllerchange`
// then reloads the tab onto the new build.

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", () => {
  // Pass-through: let the browser handle every request normally.
});
