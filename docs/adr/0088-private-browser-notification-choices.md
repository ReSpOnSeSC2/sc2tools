# ADR 0088 · Private browser notification choices

**Status** Accepted

## Decision

A browser registration permits delivery. Account preferences still decide which stored bell kinds can alert that browser. No kinds are implicitly enabled. Preserve explicitly saved legacy coaching selections across the new coaching controls. Legacy Other continues to cover the remaining catch-all notifications. Separate milestone, support reply and import choices require explicit selection.

Only saved, unmuted bell rows enter the existing best-effort push path. Both the API and worker enforce fixed lock-screen copy and the inbox destination. This also covers payloads queued before an upgrade. The fixed test alert still opens the push controls. Derive the replacement tag from a hash of the owner and the stored group key, or the row identifier when ungrouped. The browser never receives the bell row's text, private URL or raw grouping identifier through push.

Settings checks the active worker's protocol through a message port before showing the enable action. The owner's click directly calls `PushManager.subscribe` when the browser has no subscription, preserving the user gesture on Home Screen web apps. A waiting worker still requires the existing update approval. The current Settings bundle sends an enrollment version on explicit enable. Older bundles can refresh their existing row. This prevents an older tab from moving a shared browser to another account on load. An old key requires a reset and new enable click. A browser-provided rotation keeps the same enrollment and cannot displace a registered destination. Expiry without a replacement requires enabling the device again.

Turning this device off removes the current owner's row and unsubscribes the browser. Settings serializes local unsubscribe and server registration across tabs with Web Locks where available. The active worker drops queued events without a live subscription. Notifications already shown can remain in the operating system's history. Device registrations remain user-scoped and capped at ten, and account erasure removes them. JSON and streaming exports include the device label, timestamps and allow-listed endpoint host. Backup restore never reactivates an endpoint. No new provider, configuration or dependency is required.

See [Push API](https://w3c.github.io/push-api/#dom-pushmanager-subscribe) and [WebKit's Home Screen push permission behavior](https://webkit.org/blog/13878/).
