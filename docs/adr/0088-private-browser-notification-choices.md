# ADR 0088 · Private browser notification choices

**Status** Accepted

## Decision

A browser registration permits delivery. Account preferences still decide which stored bell kinds can alert that browser. No kinds are implicitly enabled. Preserve explicitly saved legacy coaching selections across the new coaching controls. Legacy Other continues to cover the remaining catch-all notifications. Separate milestone, support reply and import choices require explicit selection.

Only saved, unmuted bell rows enter the existing best-effort push path. Device alerts use fixed lock-screen copy and open `/notifications`. Derive the replacement tag from a hash of the owner and the stored group key, or the row identifier when ungrouped. The browser never receives the bell row's text, private URL or raw grouping identifier through push.

Settings checks the active worker's protocol through a message port before showing the enable action. The owner's click directly calls `PushManager.subscribe` when the browser has no subscription, preserving the user gesture on Home Screen web apps. A waiting worker still requires the existing update approval. An existing browser subscription can be registered for a new account only through an explicit click. A server key change requires a reset and a new enable click. Browser-managed endpoint rotation cannot displace an already registered destination.

Device registrations remain user-scoped, capped and removed with the account. JSON and streaming exports include the device label, timestamps and allow-listed endpoint host. Backup restore never reactivates an endpoint. No new provider, configuration or dependency is required.

See [Push API](https://w3c.github.io/push-api/#dom-pushmanager-subscribe) and [WebKit's Home Screen push permission behavior](https://webkit.org/blog/13878/).
